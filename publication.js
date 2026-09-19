require("dotenv").config();

const fs = require("fs");
const path = require("path");
const Lark = require("@larksuiteoapi/node-sdk");

const { produireQuotidien } = require("./rapport");
const { localReportDate } = require("./database");

// ---------------------------------------------------------------------------
// Production et publication du rapport
//
// Le rapport part desormais en .docx sur le papier a en-tete de la maison,
// accompagne d'une ligne de texte : le groupe voit tout de suite de quelle
// journee il s'agit sans avoir a ouvrir la piece jointe.
// ---------------------------------------------------------------------------

const DOSSIER = process.env.RAPPORT_DOSSIER || path.join(__dirname, "rapports");

const larkClient = new Lark.Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  domain: Lark.Domain.Lark,
});


async function envoyerTexte(chatId, texte) {
  await larkClient.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text: texte }),
    },
  });
}


async function envoyerFichier(chatId, chemin) {
  const upload = await larkClient.im.v1.file.create({
    data: {
      file_type: "doc",
      file_name: path.basename(chemin),
      file: fs.createReadStream(chemin),
    },
  });

  const fileKey = upload?.file_key;

  if (!fileKey) {
    throw new Error(`Televersement du rapport impossible : ${path.basename(chemin)}`);
  }

  await larkClient.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "file",
      content: JSON.stringify({ file_key: fileKey }),
    },
  });
}


async function publierRapport(options = {}) {
  const date = options.date || localReportDate();
  const chatId = options.chatId || process.env.LARK_REPORT_CHAT_ID;
  const essaiSeul = options.essaiSeul === true;

  if (!chatId && !essaiSeul) {
    throw new Error("LARK_REPORT_CHAT_ID absent de l'environnement");
  }

  if (!fs.existsSync(DOSSIER)) {
    fs.mkdirSync(DOSSIER, { recursive: true });
  }

  console.log(`[rapport] Preparation du rapport du ${date}`);

  try {
    const resultat = await produireQuotidien(date, DOSSIER);

    if (resultat.statut === "vide") {
      console.log("[rapport] Aucun compte rendu ni fiche de presence ce jour.");
      return { statut: "vide", date };
    }

    // Un defaut de validation n'empeche pas la publication : le document est
    // produit, mais on dit franchement ce qui cloche plutot que de le taire.
    if (resultat.erreurs.length) {
      console.warn(`[rapport] Defauts persistants : ${resultat.erreurs.join(", ")}`);
    }

    // Une piece jointe ecartee est un compte rendu qui manque au rapport :
    // le groupe doit l'apprendre avec le rapport, pas dans les logs.
    const reserves = [
      ...resultat.erreurs,
      ...(resultat.pieces_ignorees || []).map((piece) => `piece non lue : ${piece}`),
    ];

    console.log(
      `[rapport] ${resultat.modele}, ` +
      `${resultat.usage.prompt_tokens || 0}+${resultat.usage.completion_tokens || 0} tokens, ` +
      `${(Number(resultat.usage.cost || 0) + Number(resultat.cout_pieces || 0)).toFixed(6)}`
    );

    if (essaiSeul) {
      console.log(`[rapport] (essai) fichier ecrit : ${resultat.chemin}`);
      return { ...resultat, statut: "essai", reserves };
    }

    await envoyerTexte(
      chatId,
      `${resultat.document.numero}\n` +
      `Rapport journalier consolidé — ${resultat.document.titre_date}` +
      (reserves.length ? `\n\nÀ vérifier : ${reserves.join(", ")}` : "")
    );

    await envoyerFichier(chatId, resultat.chemin);

    console.log(`[rapport] Publie : ${path.basename(resultat.chemin)}`);

    return { ...resultat, statut: "publie", reserves };
  } catch (erreur) {
    console.error("[rapport] Echec :", erreur);

    // Sans ce signalement, un echec et une journee sans compte rendu se
    // ressemblent : dans les deux cas le groupe ne recoit rien.
    if (!essaiSeul) {
      try {
        await envoyerTexte(
          chatId,
          `Rapport du ${date} : échec de génération.\n\n` +
          `Cause : ${erreur?.message || erreur}\n\n` +
          `Relancer en écrivant : le rapport du ${date}`
        );
      } catch (notification) {
        console.error("[rapport] Signalement impossible :", notification?.message);
      }
    }

    return { statut: "erreur", date, erreur: erreur?.message };
  }
}

module.exports = { publierRapport, envoyerTexte, envoyerFichier, DOSSIER };

// Execution manuelle : node publication.js [AAAA-MM-JJ] [--essai]
if (require.main === module) {
  const args = process.argv.slice(2);
  const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || null;

  publierRapport({ date, essaiSeul: args.includes("--essai") }).then((r) => {
    process.exitCode = r.statut === "erreur" ? 1 : 0;
  });
}
