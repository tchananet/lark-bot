require("dotenv").config();

const fs = require("fs");
const path = require("path");

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

const PIECES = db.prepare(`
  SELECT attachment_type, file_name, file_path
  FROM attachments
  WHERE message_id = ?
  ORDER BY id ASC
`);

// Une piece jointe ne parvient au rapport que si trois conditions tiennent :
// le fichier existe encore sur le disque, son extension est lisible, et le
// message n'a pas ete ecarte. Les trois sont verifiees ici, parce qu'aucune
// ne se voit depuis Lark.
const EXTENSIONS_LUES = [".pdf", ".jpg", ".jpeg", ".png", ".webp", ".docx"];

function etatPiece(piece) {
  const chemin = piece.file_path;

  if (!chemin) {
    return "AUCUN CHEMIN EN BASE - jamais telechargee";
  }

  if (!fs.existsSync(chemin)) {
    return `ABSENTE DU DISQUE - ${chemin}`;
  }

  const ext = path.extname(piece.file_name || chemin).toLowerCase();
  const taille = Math.round(fs.statSync(chemin).size / 1024);

  if (!EXTENSIONS_LUES.includes(ext)) {
    return `FORMAT NON LU (${ext || "sans extension"}) - ${taille} Ko`;
  }

  return `lisible (${ext}, ${taille} Ko)`;
}

function messagesDe(date) {
  const { debut, fin } = reportWindow(date);

  return {
    debut,
    fin,
    lignes: MESSAGES.all(TZ_OFFSET, TZ_OFFSET, debut, TZ_OFFSET, fin),
  };
}

const COMPLET = process.argv.includes("--complet");

function apercu(message) {
  const brut = (message.content || "").trim();

  if (!brut) {
    return message.pieces
      ? `(${message.pieces} piece(s) jointe(s), sans texte)`
      : "(vide)";
  }

  // La date que le modele a retenue se trouve presque toujours dans les
  // premieres lignes du compte rendu : --complet les donne en entier.
  if (COMPLET) {
    return brut.split("\n").join("\n     ");
  }

  const texte = brut.replace(/\s+/g, " ");

  return texte.length > 90 ? `${texte.slice(0, 90)}...` : texte;
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

    for (const piece of PIECES.all(ligne.message_id)) {
      console.log(
        `     piece : ${piece.file_name || "(sans nom)"} -> ${etatPiece(piece)}`
      );
    }

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

// Le format d'un fichier ne dit pas ce que le modele y lit. --lire transcrit
// reellement chaque piece, exactement comme le fait le rapport, et montre le
// debut du texte obtenu : c'est la seule facon de voir quelle date le modele
// a sous les yeux. Compter environ un demi-centime par piece.
async function transcrire(date) {
  // Un diagnostic qui reste bloque n'apprend rien. On coupe court : une
  // seule tentative, et deux minutes au maximum par piece. Mieux vaut un
  // echec annonce qu'une attente sans fin.
  process.env.IA_TENTATIVES = process.env.IA_TENTATIVES || "1";
  process.env.IA_TIMEOUT_VISION = process.env.IA_TIMEOUT_VISION || "120000";

  const { lirePiece } = require("./rapport");
  const { lignes } = messagesDe(date);

  console.log("\n---------------------------------------------------------------");
  console.log("Transcription des pieces jointes, telle que le rapport la voit :");

  for (const ligne of lignes) {
    for (const piece of PIECES.all(ligne.message_id)) {
      const nom = piece.file_name || "(sans nom)";

      console.log(`\n  ${ligne.heure_locale}  ${ligne.expediteur}  ${nom}`);

      if (!piece.file_path || !fs.existsSync(piece.file_path)) {
        console.log("     NON LUE : fichier introuvable sur le disque.");
        continue;
      }

      // Affiche avant l'appel : si rien ne suit, c'est que la lecture de
      // CETTE piece est la ou tout se bloque.
      process.stdout.write("     lecture en cours...");

      const depart = Date.now();

      try {
        const lecture = await lirePiece(piece.file_path, nom);

        console.log(` ${Math.round((Date.now() - depart) / 1000)}s`);

        if (!lecture || !(lecture.texte || "").trim()) {
          console.log("     NON LUE : format non pris en charge, ou texte vide.");
          continue;
        }

        const debut = lecture.texte.trim().split("\n").slice(0, 15);

        console.log(debut.map((l) => `     | ${l}`).join("\n"));

        if (lecture.texte.trim().split("\n").length > 15) {
          console.log("     | ...");
        }
      } catch (erreur) {
        console.log(` ${Math.round((Date.now() - depart) / 1000)}s`);
        console.log(`     NON LUE : ${erreur.message}`);
      }
    }
  }
}


async function principal() {
  const date =
    process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || localReportDate();

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

  if (process.argv.includes("--lire")) {
    await transcrire(date);
  }

  console.log(
    `\nDetail d'une fenetre voisine : node verifier-rapport.js ${decale(-1)}`
  );

  if (!COMPLET) {
    console.log(
      `Texte integral des messages : ` +
      `node verifier-rapport.js ${date} --complet`
    );
  }

  if (!process.argv.includes("--lire")) {
    console.log(
      `Transcription des pieces jointes, comme le rapport les lit : ` +
      `node verifier-rapport.js ${date} --lire\n`
    );
  }
}

principal().catch((erreur) => {
  console.error(erreur);
  process.exitCode = 1;
});
