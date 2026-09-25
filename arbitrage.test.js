const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "arbitrage-")),
  "test.db"
);

const {
  ouvrirQuestions,
  questionsOuvertes,
  journeeEnAttente,
  trancher,
  reponsesDe,
} = require("./arbitrage");

let reussis = 0;

function verifier(intitule, fn) {
  try {
    fn();
    reussis++;
  } catch (erreur) {
    console.error(`ECHEC : ${intitule}\n  ${erreur.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Une decision de la DRH ne se reperd pas.
//
// Le rapport s'arrete tant qu'une absence n'est pas tranchee. Si une reponse
// deja donnee pouvait se reperdre, le bot redemanderait la meme chose a
// chaque regeneration -- et finirait par ne plus etre lu.
// ---------------------------------------------------------------------------

const JOUR = "2026-09-24";
const NOMS = ["TAKAM VANAULD", "OBELE HENRI", "YENE STEPHANE"];

verifier("ouvrir pose une question par personne", () => {
  assert.strictEqual(ouvrirQuestions(JOUR, NOMS), 3);
  assert.strictEqual(questionsOuvertes(JOUR).length, 3);
});

verifier("reposer les memes questions n'en cree aucune", () => {
  assert.strictEqual(ouvrirQuestions(JOUR, NOMS), 0);
  assert.strictEqual(questionsOuvertes(JOUR).length, 3);
});

verifier("la journee en attente est retrouvee", () => {
  assert.strictEqual(journeeEnAttente(), JOUR);
});

verifier("trancher ferme la question, et elle seule", () => {
  trancher(JOUR, "TAKAM VANAULD", "CONGE", "congé annuel");

  const restantes = questionsOuvertes(JOUR).map((q) => q.nom);

  assert.deepStrictEqual(restantes, ["OBELE HENRI", "YENE STEPHANE"]);
});

verifier("une absence confirmee est une reponse, pas un silence", () => {
  trancher(JOUR, "OBELE HENRI", "ABSENT");

  assert.deepStrictEqual(
    questionsOuvertes(JOUR).map((q) => q.nom),
    ["YENE STEPHANE"]
  );
});

verifier("un statut inconnu est refuse", () => {
  assert.throws(
    () => trancher(JOUR, "YENE STEPHANE", "EN_VACANCES"),
    /Statut inconnu/
  );

  assert.strictEqual(questionsOuvertes(JOUR).length, 1);
});

verifier("retrancher une question deja close ne change rien", () => {
  const info = trancher(JOUR, "TAKAM VANAULD", "ABSENT");

  assert.strictEqual(info.changes, 0, "une reponse a ete ecrasee");

  const conge = reponsesDe(JOUR).find((r) => r.nom === "TAKAM VANAULD");

  assert.strictEqual(conge.statut, "CONGE");
  assert.strictEqual(conge.motif, "congé annuel");
});

verifier("rouvrir une journee deja tranchee ne redemande rien", () => {
  trancher(JOUR, "YENE STEPHANE", "PERMANENCE");

  // Le rapport est relance : il repose les memes questions.
  ouvrirQuestions(JOUR, NOMS);

  assert.strictEqual(
    questionsOuvertes(JOUR).length,
    0,
    "le bot redemanderait ce qui a deja ete tranche"
  );

  assert.strictEqual(journeeEnAttente(), null);
});

verifier("chaque journee a ses propres questions", () => {
  ouvrirQuestions("2026-09-25", ["OBELE HENRI"]);

  assert.strictEqual(questionsOuvertes("2026-09-25").length, 1);
  assert.strictEqual(questionsOuvertes(JOUR).length, 0);
  assert.strictEqual(journeeEnAttente(), "2026-09-25");
});

verifier("les reponses d'une journee sont toutes conservees", () => {
  assert.strictEqual(reponsesDe(JOUR).length, 3);
});


// ---------------------------------------------------------------------------
// Le rapport s'arrete vraiment, et repart une fois la reponse donnee.
//
// Le reste du fichier verifie la table. Ceci verifie la consequence : une
// case vide sur la fiche suspend le rapport au lieu de devenir une accusation
// dans un document qui monte a la Direction Generale.
// ---------------------------------------------------------------------------

const { db } = require("./database");
const { questionsPourLeRapport } = require("./arbitrage");

// Le registre du personnel est cree par hr.js : sans lui, pas de table.
require("./hr");

const JOUR_REEL = "2026-10-01";

db.prepare(`
  INSERT INTO employees (nom_complet, cle_nom, suivi_presence, mode_travail)
  VALUES (?, ?, 1, 'PRESENTIEL')
`).run("PRESENT AU POSTE", "PRESENT AU POSTE");

db.prepare(`
  INSERT INTO employees (nom_complet, cle_nom, suivi_presence, mode_travail)
  VALUES (?, ?, 1, 'PRESENTIEL')
`).run("SANS POINTAGE", "SANS POINTAGE");

const present = db.prepare(`SELECT id FROM employees WHERE cle_nom = ?`)
  .get("PRESENT AU POSTE");

// Une seule personne a pointe : la fiche est donc bien arrivee, et l'autre
// ressort ABSENTE faute de ligne.
db.prepare(`
  INSERT INTO attendance (employee_id, date, heure_arrivee, certitude)
  VALUES (?, ?, '08h00', 'CONFIRMEE')
`).run(present.id, JOUR_REEL);

verifier("une case vide suspend le rapport au lieu de l'accuser", () => {
  const attente = questionsPourLeRapport(JOUR_REEL);

  assert.strictEqual(attente.questions.length, 1);
  assert.strictEqual(attente.questions[0].nom, "SANS POINTAGE");
  assert.ok(
    attente.message.includes("SANS POINTAGE"),
    "la question ne nomme pas la personne"
  );
  assert.ok(
    attente.message.includes("permanence"),
    "la question n'explique pas ce que la fiche ne dit pas"
  );
});

verifier("une fois tranchee, la journee ne suspend plus rien", () => {
  trancher(JOUR_REEL, "SANS POINTAGE", "PERMANENCE");

  assert.strictEqual(questionsPourLeRapport(JOUR_REEL).questions.length, 0);
});

verifier("une journee sans fiche ne pose aucune question", () => {
  assert.strictEqual(questionsPourLeRapport("2026-10-02").questions.length, 0);
});

console.log(`${reussis} verifications passees (arbitrage).`);
