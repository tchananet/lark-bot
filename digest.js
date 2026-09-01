require("dotenv").config();

const fs = require("fs");
const path = require("path");
const Lark = require("@larksuiteoapi/node-sdk");
const { GoogleGenAI } = require("@google/genai");

const { prepareDailyBatch } = require("./batch");
const { localToday } = require("./database");
const { extractWord } = require("./extractors");

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

// Garde-fous : une journee chargee ne doit pas envoyer 200 Mo a Gemini.
const MAX_ATTACHMENTS = Number(process.env.DIGEST_MAX_ATTACHMENTS || 20);
const MAX_FILE_BYTES = Number(process.env.DIGEST_MAX_FILE_BYTES || 15 * 1024 * 1024);

// Gemini plafonne la requete inline a 20 Mo. Le base64 gonfle de 4/3,
// donc on limite le cumul brut a 12 Mo pour rester sous la barre.
const MAX_TOTAL_BYTES = Number(process.env.DIGEST_MAX_TOTAL_BYTES || 12 * 1024 * 1024);

// Types que Gemini lit nativement en inline.
const INLINE_MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
};

const larkClient = new Lark.Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  domain: Lark.Domain.Lark,
});


const PROMPT = `Tu rediges le rapport quotidien interne d'ALPHA MOTORS Cameroun.

Tu recois les messages envoyes aujourd'hui par les collaborateurs via Lark,
au format JSON, suivis des pieces jointes qu'ils ont transmises.

Redige un rapport en francais, dans ce format exact :

RAPPORT QUOTIDIEN — <date en toutes lettres>

<n> collaborateurs · <n> messages · <n> pieces jointes

SYNTHESE
<2 a 5 paragraphes courts. Regroupe par theme, pas par message. Cite les
personnes par leur nom. Resume le contenu reel des pieces jointes que tu as
recues, pas seulement leur nom de fichier.>

A SUIVRE
· <points qui demandent une action ou une decision, un par ligne>
· <s'il n'y a rien a signaler, ecris "Rien a signaler.">

Regles :
- N'invente jamais un fait, un chiffre ou un nom qui n'apparait pas dans les donnees.
- Si un expediteur est identifie par un identifiant technique (ou_...), ecris
  "collaborateur non identifie" plutot que l'identifiant.
- Ne recopie pas les messages un par un : synthetise.
- Pas de markdown, pas d'asterisques, pas de dieses. Texte brut uniquement.
- Reste factuel et sobre.
- Rediges en francais correctement accentue (rapport, releve, echeance...),
  meme si les consignes ci-dessus sont ecrites sans accents.`;


async function buildAttachmentParts(batch) {
  const parts = [];
  const skipped = [];
  let used = 0;
  let totalBytes = 0;

  for (const message of batch.messages) {
    for (const attachment of message.attachments) {
      const filePath = attachment.path;
      const label = attachment.name || path.basename(filePath || "");

      if (!filePath || !fs.existsSync(filePath)) {
        skipped.push(`${label} (fichier absent du disque)`);
        continue;
      }

      if (used >= MAX_ATTACHMENTS) {
        skipped.push(`${label} (limite de ${MAX_ATTACHMENTS} pieces jointes atteinte)`);
        continue;
      }

      const size = fs.statSync(filePath).size;

      if (size > MAX_FILE_BYTES) {
        skipped.push(`${label} (trop volumineux : ${Math.round(size / 1024 / 1024)} Mo)`);
        continue;
      }

      if (totalBytes + size > MAX_TOTAL_BYTES) {
        skipped.push(`${label} (budget total de pieces jointes atteint)`);
        continue;
      }

      const ext = path.extname(filePath).toLowerCase();
      const mimeType = INLINE_MIME[ext];

      if (mimeType) {
        parts.push({
          text: `\n--- Piece jointe de ${message.sender.name} : ${label} ---`,
        });
        parts.push({
          inlineData: {
            mimeType,
            data: fs.readFileSync(filePath).toString("base64"),
          },
        });
        used++;
        totalBytes += size;
        continue;
      }

      // Gemini ne lit pas le .docx nativement : on extrait le texte.
      if (ext === ".docx") {
        let extracted;

        try {
          extracted = await extractWord(filePath);
        } catch (error) {
          console.error("Extraction docx echouee :", filePath, error.message);
          skipped.push(`${label} (extraction docx impossible)`);
          continue;
        }

        parts.push({
          text:
            `\n--- Piece jointe de ${message.sender.name} : ${label} ` +
            `(texte extrait) ---\n${extracted}`,
        });
        used++;
        totalBytes += size;
        continue;
      }

      skipped.push(`${label} (format ${ext || "inconnu"} non lisible)`);
    }
  }

  return { parts, skipped, used };
}


async function buildDigest(date) {
  const batch = prepareDailyBatch(date);

  if (batch.total_messages === 0) {
    return { batch, text: null };
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY absent de l'environnement");
  }

  const ai = new GoogleGenAI({ apiKey });

  const { parts, skipped, used } = await buildAttachmentParts(batch);

  const header = {
    text:
      `${PROMPT}\n\n` +
      `Date du rapport : ${batch.date}\n` +
      `Nombre de pieces jointes transmises ci-dessous : ${used}\n` +
      (skipped.length
        ? `Pieces jointes non transmises : ${skipped.join(", ")}\n`
        : "") +
      `\nMESSAGES (JSON) :\n${JSON.stringify(batch.messages, null, 2)}`,
  };

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [header, ...parts] }],
  });

  return { batch, text: response.text, skipped, attachmentsSent: used };
}


async function sendDigestToLark(text) {
  const chatId = process.env.LARK_REPORT_CHAT_ID;

  if (!chatId) {
    throw new Error("LARK_REPORT_CHAT_ID absent de l'environnement");
  }

  await larkClient.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  });
}


async function runDigest(options = {}) {
  const date = options.date || localToday();
  const dryRun = options.dryRun === true;

  console.log(`[digest] Preparation du rapport du ${date}`);

  try {
    const { batch, text, attachmentsSent, skipped } = await buildDigest(date);

    if (!text) {
      console.log("[digest] Aucun message ce jour, rapport non envoye.");
      return { status: "empty", text: null };
    }

    console.log(
      `[digest] ${batch.total_messages} messages, ` +
      `${attachmentsSent} pieces jointes envoyees a Gemini` +
      (skipped.length ? `, ${skipped.length} ignorees` : "")
    );

    if (dryRun) {
      console.log("\n----- APERCU (non envoye) -----\n");
      console.log(text);
      console.log("\n-------------------------------\n");
      return text;
    }

    await sendDigestToLark(text);
    console.log("[digest] Rapport envoye au groupe de suivi.");

    return { status: "sent", text };
  } catch (error) {
    console.error("[digest] Echec de generation du rapport :", error);
    return { status: "error", text: null };
  }
}


module.exports = {
  runDigest,
  buildDigest,
  buildAttachmentParts,
};


// Execution manuelle : node digest.js [AAAA-MM-JJ] [--dry-run]
if (require.main === module) {
  const args = process.argv.slice(2);
  const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || null;
  const dryRun = args.includes("--dry-run");

  runDigest({ date, dryRun }).then((result) => {
    // Pas de process.exit() : il avorte le processus pendant que le SDK
    // Lark ferme ses handles. On laisse la boucle se vider seule.
    // Une journee sans message est un succes, pas une erreur.
    process.exitCode = result.status === "error" ? 1 : 0;
  });
}
