require("dotenv").config();

const fs = require("fs");
const path = require("path");
const Lark = require("@larksuiteoapi/node-sdk");
const { GoogleGenAI } = require("@google/genai");

const { prepareDailyBatch } = require("./batch");
const {
  localToday,
  localReportDate,
  allocateReportNumber,
} = require("./database");
const { extractWord } = require("./extractors");

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

// Garde-fous : une journee chargee ne doit pas envoyer 200 Mo a Gemini.
const MAX_ATTACHMENTS = Number(process.env.DIGEST_MAX_ATTACHMENTS || 20);
const MAX_FILE_BYTES = Number(process.env.DIGEST_MAX_FILE_BYTES || 15 * 1024 * 1024);

// Gemini plafonne la requete inline a 20 Mo. Le base64 gonfle de 4/3,
// donc on limite le cumul brut a 12 Mo pour rester sous la barre.
const MAX_TOTAL_BYTES = Number(process.env.DIGEST_MAX_TOTAL_BYTES || 12 * 1024 * 1024);

// Timeout par tentative (pas pour la sequence complete) et nombre de
// tentatives, initiale comprise.
const DIGEST_TIMEOUT_MS = Number(process.env.DIGEST_TIMEOUT_MS || 120000);
const DIGEST_RETRY_ATTEMPTS = Number(process.env.DIGEST_RETRY_ATTEMPTS || 4);

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


const MOIS_FR = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

const JOURS_FR = [
  "dimanche", "lundi", "mardi", "mercredi",
  "jeudi", "vendredi", "samedi",
];

// "2026-09-01" -> "1er septembre 2026" / "mardi 1er septembre 2026"
function dateEnFrancais(iso, avecJour = false) {
  const [annee, mois, jour] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(annee, mois - 1, jour));

  const quantieme = jour === 1 ? "1er" : String(jour);
  const base = `${quantieme} ${MOIS_FR[mois - 1]} ${annee}`;

  return avecJour ? `${JOURS_FR[d.getUTCDay()]} ${base}` : base;
}


// Le rapport ne doit RIEN devoir a l'expediteur Lark : un collaborateur
// transmet souvent le compte rendu d'un autre service. On retire donc
// toute identite d'expediteur avant d'envoyer les donnees au modele.
function anonymiserMessages(batch) {
  return batch.messages.map((message) => ({
    heure: message.timestamp,
    type: message.type,
    texte: message.text,
    pieces_jointes: message.attachments.map(
      (piece) => piece.name || path.basename(piece.path || "")
    ),
  }));
}


const PROMPT = `Tu rédiges le rapport journalier consolidé des activités
d'ALPHA MOTORS Cameroun, établi par la Direction des Ressources Humaines
à l'attention de la Direction Générale.

Tu reçois les comptes rendus transmis par les services via Lark : le texte
des messages, puis les pièces jointes (rapports PDF, images, documents).

REGLE D'IDENTIFICATION -- LA PLUS IMPORTANTE
N'utilise JAMAIS l'expéditeur pour attribuer une activité : un collaborateur
transmet fréquemment le compte rendu d'un autre service. Aucune information
sur l'expéditeur ne t'est d'ailleurs fournie, et c'est voulu.
Le service concerné et les personnes citées se déduisent UNIQUEMENT du
contenu : en-têtes, intitulés, signatures et noms figurant dans le corps des
messages et des pièces jointes.
Les noms que tu cites sont ceux qui apparaissent DANS les rapports (clients,
collaborateurs concernés), jamais un identifiant technique.

REGLE DE DATE -- AUSSI IMPORTANTE QUE LA PRECEDENTE
Le présent rapport porte sur UNE journée précise, indiquée plus bas.
Les services transmettent leur compte rendu entre 17h le jour concerné et
16h le lendemain : un compte rendu reçu le matin ou l'après-midi porte donc
presque toujours sur la journée de la VEILLE.

L'heure d'arrivée d'un message n'indique JAMAIS la journée qu'il couvre. Ne
t'y fie pas. Fie-toi à la date annoncée dans le compte rendu lui-même :
titre, en-tête, mention "rapport du ...", "journée du ...", "activités du
...", "hier", "ce jour", signature datée.

- Compte rendu concernant la journée du rapport : intégré normalement.
- Compte rendu concernant manifestement une AUTRE journée : NE PAS le
  compter dans les indicateurs ni dans les sections de service. Signale-le
  en une ligne sous les points d'attention, en précisant la journée qu'il
  concerne, par exemple : Compte rendu du Service X portant sur la journée
  du 30 août reçu hors période.
- Compte rendu sans date explicite : rattaché à la journée du rapport.

STRUCTURE ATTENDUE -- reproduis cette ossature en texte brut.

Commence par reproduire mot pour mot le bloc d'en-tête fourni plus bas,
puis une ligne vide, puis le titre :
RAPPORT JOURNALIER CONSOLIDÉ DES ACTIVITÉS – <DATE COUVERTE EN MAJUSCULES>
puis une phrase d'introduction citant uniquement les services ayant
réellement transmis un compte rendu, sur le modèle :
Le présent rapport consolide les activités de <services> pour la journée du
<jour et date>.

01 Synthèse générale
Une ligne par indicateur chiffré, au format :
Libellé : valeur — lecture courte
Ne retiens que les indicateurs réellement présents (visites showroom,
proformas, essais, ventes, appels, messages traités, nouveaux prospects,
rendez-vous fixés, injoignables, nous revient, pas intéressés, etc.).
Calcule les totaux et taux de conversion quand les éléments le permettent,
et précise la base du calcul. Le taux de conversion de référence est
appels vers rendez-vous, soit rendez-vous fixés divisés par appels émis.

Puis une section numérotée par service ayant transmis un compte rendu, dans
cet ordre lorsqu'ils sont présents : Direction Commerciale & Call Center,
Service Informatique, Service Après-Vente, puis tout autre service.
Pour un service d'activités, une puce par activité :
• LIBELLÉ EN MAJUSCULES — description factuelle.
Pour le Service Après-Vente, une puce par dossier client :
• Nom du client — activité ou demande | Suite attendue : action.

Ensuite, toujours dans la numérotation continue :

<n> Points d'attention
Une puce par point :
• [HAUTE] Intitulé — constat.
Priorités possibles : HAUTE, MOYENNE, BASSE.

<n+1> Actions prioritaires
Une puce par service :
• SERVICE — actions concrètes à mener.

<n+2> Conclusion
Deux ou trois paragraphes : volume d'activité, ce qui a été concrétisé ou
non, ce qui reste en suspens. Termine par exactement cette phrase :
Le présent rapport est soumis à l'appréciation de la Direction Générale pour
orientations et suites à donner.

Puis, sur la dernière ligne, seule :
LA DIRECTION DES RESSOURCES HUMAINES

REGLES DE FOND
- N'invente jamais un chiffre, un nom, un dossier ni une activité. Le rapport
  ne contient que ce qui figure dans les données reçues.
- Si aucun indicateur chiffré n'est disponible, écris sous 01 :
  Aucun indicateur chiffré transmis ce jour.
- Ne crée pas la section d'un service qui n'a rien transmis.
- Si les données reçues ne sont manifestement pas des comptes rendus
  d'activité (essais techniques, messages de test), dis-le explicitement
  et n'invente pas de rapport.
- Ne recopie pas les messages un par un : consolide par service et par thème.
- Numérote les sections en continu à partir de 01, sur deux chiffres.
- Texte brut uniquement : ni markdown, ni astérisques, ni dièses, ni tableaux.
- Français administratif sobre, à la troisième personne, correctement
  accentué.
- TYPOGRAPHIE : les intitulés de section s'écrivent en casse normale
  accentuée (01 Synthèse générale, 04 Service Après-Vente, 05 Points
  d'attention), jamais en capitales. Seuls le titre du rapport et les
  libellés d'activité sont en capitales. Utilise la puce • et le tiret
  cadratin — comme séparateur.`;


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
          text: `\n--- Piece jointe : ${label} ---`,
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
            `\n--- Piece jointe : ${label} ` +
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


function attendre(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// On ne peut pas s'appuyer sur les retryOptions du SDK : il delegue a
// p-retry, qui abandonne immediatement sur TypeError sauf pour quatre
// messages propres aux navigateurs. Node lance "TypeError: fetch failed",
// absent de cette liste, donc une coupure reseau n'est jamais retentee.
async function generateWithRetry(ai, request) {
  for (let attempt = 1; attempt <= DIGEST_RETRY_ATTEMPTS; attempt++) {
    try {
      return await ai.models.generateContent(request);
    } catch (error) {
      const status = error?.status;

      // Pas de status = panne reseau ou timeout : on retente.
      // Un 4xx (cle invalide, requete trop grosse) ne s'arrangera pas.
      const retryable =
        status === undefined ||
        status === 408 ||
        status === 429 ||
        status >= 500;

      if (!retryable || attempt === DIGEST_RETRY_ATTEMPTS) {
        throw error;
      }

      const delai = Math.min(30000, 5000 * 2 ** (attempt - 1));

      console.warn(
        `[digest] Tentative ${attempt}/${DIGEST_RETRY_ATTEMPTS} echouee ` +
        `(${error?.message || error}). Nouvelle tentative dans ${delai / 1000}s.`
      );

      await attendre(delai);
    }
  }
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

  const ai = new GoogleGenAI({
    apiKey,
    // Borne chaque tentative. Le SDK s'en sert aussi pour relever les
    // timeouts undici, qui sont a l'origine de UND_ERR_HEADERS_TIMEOUT.
    httpOptions: { timeout: DIGEST_TIMEOUT_MS },
  });

  const { parts, skipped, used } = await buildAttachmentParts(batch);

  const numero = allocateReportNumber(batch.date);
  const villeSiege = process.env.RAPPORT_VILLE || "Yaoundé";

  const enTete =
    `N° ${String(numero).padStart(3, "0")} / AM / DRH / ADRH\n` +
    `${villeSiege}, le ${dateEnFrancais(localToday())}`;

  const header = {
    text:
      `${PROMPT}\n\n` +
      `BLOC D'EN-TETE A REPRODUIRE MOT POUR MOT :\n${enTete}\n\n` +
      `Date couverte par le rapport : ${dateEnFrancais(batch.date, true)}\n` +
      `Fenetre de collecte (heure locale) : du ${batch.fenetre.debut} ` +
      `au ${batch.fenetre.fin}, les comptes rendus arrivant surtout le soir ` +
      `et le lendemain matin.\n` +
      `Date couverte en majuscules : ${dateEnFrancais(batch.date).toUpperCase()}\n` +
      `Nombre de pieces jointes fournies ci-dessous : ${used}\n` +
      (skipped.length
        ? `Pieces jointes non transmises : ${skipped.join(", ")}\n`
        : "") +
      `\nCOMPTES RENDUS RECUS (JSON, sans identite d'expediteur) :\n` +
      `${JSON.stringify(anonymiserMessages(batch), null, 2)}`,
  };

  const response = await generateWithRetry(ai, {
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
  const date = options.date || localReportDate();
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
      return { status: "dry-run", text };
    }

    await sendDigestToLark(text);
    console.log("[digest] Rapport envoye au groupe de suivi.");

    return { status: "sent", text };
  } catch (error) {
    console.error("[digest] Echec de generation du rapport :", error);

    // Sans cela, un echec est indiscernable d'une journee sans message :
    // dans les deux cas le groupe ne recoit rien.
    // Un --dry-run ne doit evidemment rien publier, meme en cas d'echec.
    if (dryRun) {
      console.log("[digest] (dry-run) echec non signale dans Lark.");
      return { status: "error", text: null };
    }

    try {
      await sendDigestToLark(
        `Rapport quotidien du ${date} : echec de generation.\n\n` +
        `Cause : ${error?.message || error}\n\n` +
        `Relancer manuellement avec la commande /rapport ${date}`
      );
    } catch (notifyError) {
      console.error(
        "[digest] Impossible de signaler l'echec dans Lark :",
        notifyError?.message || notifyError
      );
    }

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
