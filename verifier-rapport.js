require("dotenv").config();

const { db, reportWindow, localReportDate } = require("./database");

// ---------------------------------------------------------------------------
// Pourquoi tel compte rendu ne figure-t-il pas dans le rapport ?
//
// Un compte rendu peut manquer pour deux raisons, et l'une comme l'autre est
// invisible depuis Lark :
//
//   1. il a ete ECARTE : un message de la DRH dont l'intention n'est pas
//      "RAPPORT" est retire du rapport, pour que la conversation avec le bot
//      n'y atterrisse pas ;
//   2. il est TOMBE DANS UNE AUTRE FENETRE : le rapport du jour D couvre
//      [D 17h00, D+1 17h00[. Un compte rendu du jour D envoye AVANT 17h ce
//      meme jour appartient donc a la fenetre de la veille.
//
// Ce script montre les deux, plus les fenetres voisines, pour une date
// donnee. Lancement : node verifier-rapport.js 2026-09-17
// ---------------------------------------------------------------------------

const TZ_OFFSET = process.env.DB_TZ_OFFSET || "+1 hours";

const MESSAGES = db.prepare(`
  SELECT
    m.message_id,
    m.message_type,
    m.pour_rapport,
    m.content,
    DATETIME(m.created_at, ?) AS heure_locale,
    COALESCE(u.name, m.sender_id) AS expediteur,
    (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.message_id) AS pieces
  FROM messages m
  LEFT JOIN users u ON u.open_id = m.sender_id
  WHERE DATETIME(m.created_at, ?) >= ?
    AND DATETIME(m.created_at, ?) < ?
  ORDER BY m.created_at ASC
`);

const INTENTION = db.prepare(`
  SELECT intention, certitude, explication, est_rh
  FROM journal
  WHERE message_id = ?
  ORDER BY id DESC
  LIMIT 1
`);

function messagesDe(date) {
  const { debut, fin } = reportWindow(date);

  return {
    debut,
    fin,
    lignes: MESSAGES.all(TZ_OFFSET, TZ_OFFSET, debut, TZ_OFFSET, fin),
  };
}

function apercu(message) {
  const texte = (message.content || "").replace(/\s+/g, " ").trim();

  if (texte) {
    return texte.length > 90 ? `${texte.slice(0, 90)}...` : texte;
  }

  return message.pieces ? `(${message.pieces} piece(s) jointe(s), sans texte)` : "(vide)";
}

function afficher(date, options = {}) {
  const { debut, fin, lignes } = messagesDe(date);

  console.log(`\nFenetre du rapport du ${date} : de ${debut} a ${fin}`);

  if (!lignes.length) {
    console.log("  Aucun message dans cette fenetre.");
    return;
  }

  const retenus = lignes.filter((l) => l.pour_rapport === 1);
  const ecartes = lignes.filter((l) => l.pour_rapport !== 1);

  console.log(
    `  ${lignes.length} message(s) : ${retenus.length} retenu(s), ` +
    `${ecartes.length} ecarte(s).`
  );

  if (options.bref) {
    return;
  }

  for (const ligne of lignes) {
    const journal = INTENTION.get(ligne.message_id);

    console.log(
      `\n  ${ligne.pour_rapport === 1 ? "RETENU " : "ECARTE "} ` +
      `${ligne.heure_locale}  ${ligne.expediteur || "?"}` +
      (ligne.pieces ? `  [${ligne.pieces} piece(s) jointe(s)]` : "")
    );

    console.log(`     ${apercu(ligne)}`);

    if (journal) {
      console.log(
        `     lu comme : ${journal.intention || "?"} ` +
        `(${journal.certitude || "?"})` +
        (journal.est_rh ? " - expediteur DRH" : "")
      );

      if (ligne.pour_rapport !== 1 && journal.intention) {
        console.log(
          `     ecarte du rapport car un message de la DRH dont l'intention ` +
          `n'est pas RAPPORT est retire.`
        );
      }
    } else if (ligne.pour_rapport !== 1) {
      console.log("     ecarte, sans trace dans le journal.");
    }
  }
}

const date = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || localReportDate();

const d = new Date(`${date}T00:00:00Z`);
const decale = (jours) => {
  const copie = new Date(d);
  copie.setUTCDate(copie.getUTCDate() + jours);
  return copie.toISOString().slice(0, 10);
};

afficher(date);

console.log("\n---------------------------------------------------------------");
console.log("Fenetres voisines, au cas ou un compte rendu y serait tombe :");

afficher(decale(-1), { bref: true });
afficher(decale(1), { bref: true });

console.log(
  `\nPour voir le detail d'une fenetre voisine : ` +
  `node verifier-rapport.js ${decale(-1)}\n`
);

process.exitCode = 0;
