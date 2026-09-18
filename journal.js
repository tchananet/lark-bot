const { db } = require("./database");

// ---------------------------------------------------------------------------
// Journal des requetes
//
// Les logs du conteneur disparaissent a chaque recreation et ne se
// consultent qu'en SSH. Ce journal est en base : il survit aux
// redeploiements et alimente l'interface.
//
// Il consigne QUI a ecrit, ce que le bot a COMPRIS et ce qu'il a FAIT.
// Le contenu des messages n'y est pas recopie : il est deja dans la table
// messages, et le dupliquer multiplierait les endroits ou des donnees RH
// se retrouvent stockees.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    message_id TEXT,
    chat_id TEXT,

    expediteur_open_id TEXT,
    expediteur_nom TEXT,
    est_rh INTEGER NOT NULL DEFAULT 0,

    type_message TEXT,
    fichiers TEXT,

    intention TEXT,
    certitude TEXT,
    explication TEXT,

    relaye INTEGER NOT NULL DEFAULT 0,
    resultat TEXT NOT NULL DEFAULT 'OK',
    detail TEXT,
    duree_ms INTEGER,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

try {
  db.exec(`ALTER TABLE journal ADD COLUMN relaye INTEGER NOT NULL DEFAULT 0`);
} catch (erreur) {
  // La colonne existe deja.
}

db.exec(`CREATE INDEX IF NOT EXISTS idx_journal_date ON journal(created_at)`);


function consigner(entree) {
  try {
    return db.prepare(`
      INSERT INTO journal
        (message_id, chat_id, expediteur_open_id, expediteur_nom, est_rh,
         type_message, fichiers, intention, certitude, explication,
         relaye, resultat, detail, duree_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entree.message_id || null,
      entree.chat_id || null,
      entree.expediteur_open_id || null,
      entree.expediteur_nom || null,
      entree.est_rh ? 1 : 0,
      entree.type_message || null,
      (entree.fichiers || []).join(", ") || null,
      entree.intention || null,
      entree.certitude || null,
      entree.explication || null,
      entree.relaye ? 1 : 0,
      entree.resultat || "OK",
      entree.detail || null,
      entree.duree_ms || null
    );
  } catch (erreur) {
    // Le journal ne doit jamais faire echouer le traitement d'un message.
    console.error("[journal] Ecriture impossible :", erreur.message);
    return null;
  }
}


function derniers(limite = 100) {
  return db.prepare(`
    SELECT * FROM journal ORDER BY id DESC LIMIT ?
  `).all(Math.min(Number(limite) || 100, 500));
}


function statistiques(jours = 7) {
  return db.prepare(`
    SELECT
      DATE(created_at) AS jour,
      COUNT(*) AS total,
      SUM(CASE WHEN est_rh = 1 THEN 1 ELSE 0 END) AS rh,
      SUM(CASE WHEN resultat = 'ERREUR' THEN 1 ELSE 0 END) AS erreurs
    FROM journal
    WHERE created_at >= DATETIME('now', ?)
    GROUP BY jour
    ORDER BY jour DESC
  `).all(`-${Number(jours) || 7} days`);
}

module.exports = { consigner, derniers, statistiques };
