const { db } = require("./database");

// ---------------------------------------------------------------------------
// Ne jamais conclure a une absence sans avoir demande
//
// Une fiche de presence ne dit pas tout. Une permanence, un conge pose la
// veille, une mission a Douala : rien de cela n'y figure, et une case vide
// ressemble alors trait pour trait a une absence. Le rapport du 24 septembre
// annoncait six absences non justifiees sur vingt-trois personnes -- un
// chiffre lourd, qui part a la Direction Generale, et que la fiche seule ne
// permet pas d'affirmer.
//
// Le programme ne peut pas trancher cela : l'information n'est nulle part
// dans ce qu'il detient. Il s'arrete donc et demande, plutot que d'ecrire une
// accusation par defaut. Tant qu'une personne n'a pas ete tranchee, le
// rapport de cette journee n'est pas produit.
//
// La reponse est conservee : une fois tranchee, une journee ne redemande
// rien. Regenerer le rapport ne relance pas la question.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS absences_a_confirmer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    date TEXT NOT NULL,
    nom TEXT NOT NULL,

    statut TEXT NOT NULL DEFAULT 'EN_ATTENTE',
    motif TEXT,

    cree_le DATETIME DEFAULT CURRENT_TIMESTAMP,
    repondu_le DATETIME,

    UNIQUE (date, nom)
  )
`);


// Les statuts qui ferment la question. ABSENT la ferme aussi : c'est une
// reponse, pas un silence -- la DRH confirme alors l'absence en connaissance
// de cause, et le rapport peut l'ecrire.
const STATUTS = new Set([
  "ABSENT",
  "PERMISSION",
  "CONGE",
  "MISSION",
  "MALADIE",
  "FORMATION",
  "PERMANENCE",
  "TELETRAVAIL",
]);


function ouvrirQuestions(date, noms) {
  const poser = db.prepare(`
    INSERT INTO absences_a_confirmer (date, nom)
    VALUES (?, ?)
    ON CONFLICT(date, nom) DO NOTHING
  `);

  let ouvertes = 0;

  for (const nom of noms) {
    const info = poser.run(date, nom);

    ouvertes += info.changes;
  }

  return ouvertes;
}


function questionsOuvertes(date = null) {
  return date
    ? db.prepare(`
        SELECT * FROM absences_a_confirmer
        WHERE date = ? AND statut = 'EN_ATTENTE'
        ORDER BY nom
      `).all(date)
    : db.prepare(`
        SELECT * FROM absences_a_confirmer
        WHERE statut = 'EN_ATTENTE'
        ORDER BY date DESC, nom
      `).all();
}


// La journee la plus recente qui attend encore une reponse : c'est celle a
// laquelle un message de la DRH repond presque toujours.
function journeeEnAttente() {
  const ligne = db.prepare(`
    SELECT date FROM absences_a_confirmer
    WHERE statut = 'EN_ATTENTE'
    ORDER BY date DESC
    LIMIT 1
  `).get();

  return ligne ? ligne.date : null;
}


function trancher(date, nom, statut, motif = null) {
  if (!STATUTS.has(statut)) {
    throw new Error(`Statut inconnu : ${statut}`);
  }

  return db.prepare(`
    UPDATE absences_a_confirmer
    SET statut = ?, motif = ?, repondu_le = CURRENT_TIMESTAMP
    WHERE date = ? AND nom = ? AND statut = 'EN_ATTENTE'
  `).run(statut, motif, date, nom);
}


// Ce que la DRH a tranche pour cette journee, pour memoire et pour le
// message de confirmation.
function reponsesDe(date) {
  return db.prepare(`
    SELECT nom, statut, motif FROM absences_a_confirmer
    WHERE date = ? AND statut != 'EN_ATTENTE'
    ORDER BY nom
  `).all(date);
}


// La question, formulee une seule fois, pour tous les chemins.
//
// Le rapport part de deux endroits : la DRH qui le demande, et le cron de
// 17h15 qui le publie dans le groupe. Un garde pose dans l'assistant seul
// laisserait le cron publier des absences jamais confirmees -- c'est-a-dire
// exactement le cas qui compte, puisque personne ne le regarde partir.
function questionsPourLeRapport(date) {
  const { faitsDePonctualite } = require("./presence");

  const ponctualite = faitsDePonctualite(date);

  if (!ponctualite.fiche_recue) {
    return { questions: [], message: null };
  }

  const noms = ponctualite.absences_non_justifiees.map((a) => a.nom);

  if (!noms.length) {
    return { questions: [], message: null };
  }

  ouvrirQuestions(date, noms);

  const questions = questionsOuvertes(date);

  if (!questions.length) {
    return { questions: [], message: null };
  }

  const message =
    `Avant de terminer le rapport du ${date}, ${questions.length} personne(s) ` +
    `n'ont aucun pointage et aucun justificatif connu. La fiche ne dit pas ` +
    `tout : permanence, congé, mission n'y figurent pas.\n\n` +
    questions.map((q) => `• ${q.nom}`).join("\n") +
    `\n\nDis-moi pour chacune, en la nommant : congé, permission, mission, ` +
    `formation, maladie, permanence, télétravail — ou « absent » si c'en est ` +
    `bien une.\n` +
    `Par exemple : « ${questions[0].nom} en congé, les autres absents ».\n\n` +
    `Le rapport attend ta réponse.`;

  return { questions, message };
}


module.exports = {
  STATUTS,
  questionsPourLeRapport,
  ouvrirQuestions,
  questionsOuvertes,
  journeeEnAttente,
  trancher,
  reponsesDe,
};
