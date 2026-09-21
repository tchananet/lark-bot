require("dotenv").config();

const fs = require("fs");
const path = require("path");
const Lark = require("@larksuiteoapi/node-sdk");

const { produireQuotidien, produireHebdomadaire } = require("./rapport");
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


// Le meme document que le .docx, en texte, pour une lecture au terminal.
// L'ordre des sections suit celui du rendu Word, sans quoi comparer les deux
// deviendrait un exercice.
function enTexte(d) {
  const lignes = [d.numero, "", `${d.ville}, le ${d.date_redaction}`, ""];

  if (d.type === "HEBDOMADAIRE") {
    return [...lignes, ...corpsTexteHebdomadaire(d)].join("\n");
  }

  lignes.push(`RAPPORT JOURNALIER CONSOLIDÉ DES ACTIVITÉS – ${d.titre_date}`, "");
  lignes.push(d.intro, "");

  let n = 1;
  const titre = (libelle) => `${String(n++).padStart(2, "0")} ${libelle}`;

  lignes.push(titre("Synthèse générale"));

  if ((d.synthese || []).length) {
    for (const s of d.synthese) {
      lignes.push(`  ${s.libelle} : ${s.valeur} — ${s.lecture}`);
    }
  } else {
    lignes.push("  Aucun indicateur chiffré transmis ce jour.");
  }

  lignes.push("", titre("Ponctualité"), `  ${d.ponctualite}`, "");

  for (const service of d.services || []) {
    lignes.push(titre(service.nom));

    for (const l of service.lignes || []) {
      lignes.push(
        `  • ${l.libelle} — ${l.description}` +
        (l.suite ? ` | Suite attendue : ${l.suite}` : "")
      );
    }

    lignes.push("");
  }

  lignes.push(titre("Points d'attention"));

  for (const p of d.points_attention || []) {
    lignes.push(`  • [${p.priorite}] ${p.intitule} — ${p.constat}`);
  }

  for (const manque of d.donnees_manquantes || []) {
    lignes.push(`  • ${manque}`);
  }

  lignes.push("", titre("Actions prioritaires"));

  if ((d.actions || []).length) {
    for (const a of d.actions) {
      lignes.push(`  • ${a.service} — ${a.action}`);
    }
  } else {
    lignes.push("  Aucune action prioritaire retenue pour cette journée.");
  }

  lignes.push("", titre("Conclusion"));

  for (const para of d.conclusion || []) {
    lignes.push(`  ${para}`);
  }

  lignes.push("", d.signature, "");

  return lignes.join("\n");
}


function corpsTexteHebdomadaire(d) {
  const lignes = [
    `RAPPORT HEBDOMADAIRE CONSOLIDÉ DES SERVICES — ${d.titre_periode}`,
    "",
    d.intro,
    "",
    "01 Synthèse exécutive",
  ];

  for (const a of d.axes || []) {
    lignes.push(`  ${a.axe} : ${a.constat}`);
    lignes.push(`    → ${a.vigilance}`);
  }

  lignes.push("", "02 Indicateurs commerciaux consolidés");

  for (const i of d.indicateurs || []) {
    lignes.push(
      `  ${i.date} | showroom ${i.showroom} | proformas/ventes ${i.proformas_ventes} ` +
      `| call center ${i.call_center} | relances ${i.relances}`
    );
  }

  lignes.push("", "03 Points d'attention");

  for (const pt of d.points_attention || []) {
    lignes.push(`  • [${pt.priorite}] ${pt.intitule} — ${pt.constat}`);
  }

  for (const manque of d.donnees_manquantes || []) {
    lignes.push(`  • ${manque}`);
  }

  lignes.push("", "04 Conclusion");

  for (const para of d.conclusion || []) {
    lignes.push(`  ${para}`);
  }

  lignes.push("", d.signature, "");

  return lignes;
}


async function publierRapport(options = {}) {
  const date = options.date || localReportDate();
  const chatId = options.chatId || process.env.LARK_REPORT_CHAT_ID;
  const essaiSeul = options.essaiSeul === true;
  const hebdomadaire = options.portee === "SEMAINE";

  if (!chatId && !essaiSeul) {
    throw new Error("LARK_REPORT_CHAT_ID absent de l'environnement");
  }

  if (!fs.existsSync(DOSSIER)) {
    fs.mkdirSync(DOSSIER, { recursive: true });
  }

  console.log(
    hebdomadaire
      ? `[rapport] Preparation du rapport hebdomadaire de la semaine du ${date}`
      : `[rapport] Preparation du rapport du ${date}`
  );

  try {
    const resultat = hebdomadaire
      ? await produireHebdomadaire(date, DOSSIER)
      : await produireQuotidien(date, DOSSIER);

    if (resultat.statut === "vide") {
      console.log(
        hebdomadaire
          ? "[rapport] Aucun compte rendu sur toute la semaine."
          : "[rapport] Aucun compte rendu ni fiche de presence ce jour."
      );

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
      `$${(Number(resultat.usage.cost || 0) + Number(resultat.cout_pieces || 0)).toFixed(6)}`
    );

    if (essaiSeul) {
      console.log(`[rapport] (essai) fichier ecrit : ${resultat.chemin}`);

      // Un essai lance sur le serveur produit un .docx que personne ne peut
      // ouvrir la-bas. Le meme contenu est donc ecrit en clair a l ecran.
      console.log(`\n${enTexte(resultat.document)}`);

      if (reserves.length) {
        console.log(`À vérifier : ${reserves.join(", ")}\n`);
      }

      return { ...resultat, statut: "essai", reserves };
    }

    await envoyerTexte(
      chatId,
      `${resultat.document.numero}\n` +
      (hebdomadaire
        ? `Rapport hebdomadaire consolidé — ${resultat.document.titre_periode}`
        : `Rapport journalier consolidé — ${resultat.document.titre_date}`) +
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

module.exports = { publierRapport, enTexte, envoyerTexte, envoyerFichier, DOSSIER };

// Execution manuelle : node publication.js [AAAA-MM-JJ] [--essai]
if (require.main === module) {
  const args = process.argv.slice(2);
  const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || null;

  publierRapport({
    date,
    essaiSeul: args.includes("--essai"),
    portee: args.includes("--semaine") ? "SEMAINE" : "JOURNEE",
  }).then((r) => {
    process.exitCode = r.statut === "erreur" ? 1 : 0;
  });
}
