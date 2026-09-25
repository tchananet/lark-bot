const { db } = require("./database");

// ---------------------------------------------------------------------------
// Ce que le bot DOIT recevoir
//
// Jusqu'ici il ne connaissait que ce qui arrivait. Il pouvait donc dire "j'ai
// quatre documents", jamais "il manque le Call Center" -- et c'est pourtant
// la seule chose utile un matin.
//
// Une remarque de conception, parce qu'elle contredit une autre regle du
// projet : ici on se fie au COMPTE LARK de l'expediteur. Le rapport, lui, ne
// doit jamais attribuer une activite d'apres l'expediteur, puisqu'un
// collaborateur transmet souvent le compte rendu d'un autre service. Les deux
// regles sont justes : "qui a transmis" n'est pas "de quel service parle ce
// document".
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS attendus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    open_id TEXT NOT NULL,
    libelle TEXT NOT NULL,
    genre TEXT NOT NULL DEFAULT 'RAPPORT',

    -- Nombre de documents attendus par occurrence. L'Informatique en envoie
    -- deux par jour, MESSOA et TIAKO : "l'IT a transmis" veut dire deux.
    quantite INTEGER NOT NULL DEFAULT 1,

    -- QUOTIDIEN du lundi au samedi, HEBDOMADAIRE une fois la semaine.
    frequence TEXT NOT NULL DEFAULT 'QUOTIDIEN',

    actif INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (open_id, genre)
  )
`);


function declarer({ open_id, libelle, genre = "RAPPORT", quantite = 1, frequence = "QUOTIDIEN" }) {
  return db.prepare(`
    INSERT INTO attendus (open_id, libelle, genre, quantite, frequence)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(open_id, genre) DO UPDATE SET
      libelle = excluded.libelle,
      quantite = excluded.quantite,
      frequence = excluded.frequence,
      actif = 1
  `).run(open_id, libelle, genre, quantite, frequence);
}


function lister() {
  return db.prepare(`
    SELECT a.*, COALESCE(u.name, a.open_id) AS nom
    FROM attendus a
    LEFT JOIN users u ON u.open_id = a.open_id
    WHERE a.actif = 1
    ORDER BY a.genre, a.libelle
  `).all();
}


function retirer(openId, genre = "RAPPORT") {
  return db.prepare(`
    UPDATE attendus SET actif = 0 WHERE open_id = ? AND genre = ?
  `).run(openId, genre);
}


// Ce qui est reellement arrive pour une journee, par expediteur. La fenetre
// est celle du rapport : [D 17h, D+1 17h[.
const RECU = db.prepare(`
  SELECT m.sender_id, COUNT(DISTINCT a.file_path) AS documents
  FROM attachments a
  JOIN messages m ON m.message_id = a.message_id
  WHERE DATETIME(m.created_at, ?) >= ?
    AND DATETIME(m.created_at, ?) < ?
  GROUP BY m.sender_id
`);

const TZ = process.env.DB_TZ_OFFSET || "+1 hours";


// Le dimanche, personne ne travaille : ne reclamer un compte rendu ce jour-la
// ferait du bruit tous les lundis matin.
function jourOuvre(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay() !== 0;
}


function etatDesAttendus(date, fenetre) {
  if (!jourOuvre(date)) {
    return { jourChome: true, arrives: [], manquants: [], partiels: [] };
  }

  const recus = new Map(
    RECU.all(TZ, fenetre.debut, TZ, fenetre.fin).map((r) => [r.sender_id, r.documents])
  );

  const arrives = [];
  const manquants = [];
  const partiels = [];

  for (const attendu of lister()) {
    if (attendu.frequence !== "QUOTIDIEN") {
      continue;
    }

    const recu = recus.get(attendu.open_id) || 0;

    if (!recu) {
      manquants.push(attendu);
    } else if (recu < attendu.quantite) {
      partiels.push({ ...attendu, recu });
    } else {
      arrives.push({ ...attendu, recu });
    }
  }

  return { jourChome: false, arrives, manquants, partiels };
}

module.exports = { declarer, lister, retirer, etatDesAttendus, jourOuvre };
