require("dotenv").config();

const Lark = require("@larksuiteoapi/node-sdk");

const { localReportDate } = require("./database");
const { prepareDailyBatch } = require("./batch");
const { etatDesAttendus } = require("./attendus");
const { faitsDePonctualite } = require("./presence");
const { listerRH } = require("./hr");

// ---------------------------------------------------------------------------
// La relance du matin
//
// Le bot savait constater, pas reclamer. A 10h il regarde la journee de la
// veille et dit a la DRH ce qui n'est pas arrive -- rien d'autre. Si tout est
// la, il se tait : un message quotidien qui dit "tout va bien" cesse d'etre
// lu au bout d'une semaine.
//
// Il ecrit a la DRH seule, jamais au groupe ni aux services. Un bot qui
// relance les gens directement se retourne vite contre celui qui l'a mis en
// place.
// ---------------------------------------------------------------------------

const larkClient = new Lark.Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  domain: Lark.Domain.Lark,
});


function comptesRH() {
  const { parConfig, enBase } = listerRH();

  const deLaBase = enBase
    .map((employe) => employe.lark_open_id)
    .filter(Boolean);

  return [...new Set([...parConfig, ...deLaBase])];
}


async function ecrireA(openId, texte) {
  await larkClient.im.v1.message.create({
    params: { receive_id_type: "open_id" },
    data: {
      receive_id: openId,
      msg_type: "text",
      content: JSON.stringify({ text: texte }),
    },
  });
}


function messageDeRelance(date, etat, ponctualite) {
  const lignes = [`Rapports attendus pour le ${date} — point de 10h`];

  if (etat.manquants.length) {
    lignes.push("", "Pas encore parvenus :");

    for (const attendu of etat.manquants) {
      lignes.push(`• ${attendu.libelle} (${attendu.nom})`);
    }
  }

  for (const partiel of etat.partiels) {
    lignes.push(
      `• ${partiel.libelle} : ${partiel.recu} document(s) reçu(s) sur ` +
      `${partiel.quantite} attendus.`
    );
  }

  if (!ponctualite.fiche_recue) {
    lignes.push("• Fiche de présence : non reçue.");
  }

  lignes.push(
    "",
    `Reçus : ${etat.arrives.map((a) => a.libelle).join(", ") || "aucun"}.`
  );

  return lignes.join("\n");
}


async function relancer(options = {}) {
  const date = options.date || localReportDate();
  const batch = prepareDailyBatch(date);
  const etat = etatDesAttendus(date, batch.fenetre);

  if (etat.jourChome) {
    console.log(`[relance] ${date} est un dimanche, rien a reclamer.`);

    return { statut: "chome", date };
  }

  const ponctualite = faitsDePonctualite(date);
  const rienNeManque =
    !etat.manquants.length && !etat.partiels.length && ponctualite.fiche_recue;

  // Le silence est une information : il veut dire que tout est arrive.
  if (rienNeManque) {
    console.log(`[relance] ${date} : tout est arrive, aucun message envoye.`);

    return { statut: "complet", date };
  }

  const texte = messageDeRelance(date, etat, ponctualite);
  const destinataires = comptesRH();

  if (!destinataires.length) {
    console.warn("[relance] Aucun compte RH connu, message non envoye.");

    return { statut: "sans_destinataire", date, texte };
  }

  if (options.essaiSeul) {
    console.log(`[relance] (essai) destinataires : ${destinataires.length}\n\n${texte}`);

    return { statut: "essai", date, texte, destinataires };
  }

  for (const openId of destinataires) {
    try {
      await ecrireA(openId, texte);
    } catch (erreur) {
      console.error(`[relance] envoi impossible a ${openId} :`, erreur.message);
    }
  }

  console.log(
    `[relance] ${date} : ${etat.manquants.length} manquant(s), ` +
    `message envoye a ${destinataires.length} compte(s) RH.`
  );

  return { statut: "envoye", date, texte, destinataires };
}

module.exports = { relancer, messageDeRelance, comptesRH };

if (require.main === module) {
  const args = process.argv.slice(2);

  relancer({
    date: args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || null,
    essaiSeul: args.includes("--essai"),
  }).catch((erreur) => {
    console.error(erreur);
    process.exitCode = 1;
  });
}
