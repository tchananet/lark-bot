const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Une base neuve et jetable : ce test ecrit des messages, il ne doit pas
// toucher celle du poste ni celle du conteneur.
const base = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "inventaire-")),
  "test.db"
);

process.env.DATABASE_PATH = base;

const { db, memoriserTexte } = require("./database");
const { inventaire } = require("./inventaire");

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
// L'etat doit refleter ce que le bot a REELLEMENT en base.
//
// Il a longtemps annonce "pas encore lu", expediteur "?", recu "null" pour des
// PDF dont le texte etait en base depuis leur arrivee. La cause n'etait pas la
// lecture mais l'interrogation : inventaire.js lisait piece.file_path et
// message.message_id, deux champs que prepareDailyBatch n'expose pas. Les
// requetes recevaient undefined et ne ramenaient rien.
//
// Une faute de ce genre ne casse rien : elle ment. D'ou ce test, qui pose une
// piece lue et verifie qu'elle ressort bien comme lue.
// ---------------------------------------------------------------------------

const JOURNEE = "2026-09-24";

// La fenetre du 24 va de 17h le 24 a 17h le 25. created_at est stocke en UTC
// et relu avec le decalage camerounais : 08h30 UTC = 09h30 sur place, le 25.
const ARRIVEE = "2026-09-25 08:30:00";
const CHEMIN = path.join(os.tmpdir(), "rapport-du-24-09-2026.pdf");

fs.writeFileSync(CHEMIN, "piece de test");

db.prepare(
  `INSERT INTO users (open_id, name) VALUES (?, ?)`
).run("ou_test", "Isabelle Nga");

db.prepare(`
  INSERT INTO messages (message_id, chat_id, sender_id, message_type,
                        content, created_at, pour_rapport)
  VALUES (?, ?, ?, 'file', '', ?, 1)
`).run("om_test", "oc_test", "ou_test", ARRIVEE);

db.prepare(`
  INSERT INTO attachments (message_id, attachment_type, file_name, file_path)
  VALUES (?, 'file', ?, ?)
`).run("om_test", "RAPPORT DU 24 09 26.pdf", CHEMIN);

memoriserTexte({
  file_path: CHEMIN,
  file_name: "RAPPORT DU 24 09 26.pdf",
  texte: "Rapport d'activite du 24 septembre 2026. Chiffre d'affaires : 0.",
  moteur: "pdf",
});

const etat = inventaire(JOURNEE);

verifier("la piece jointe du lot est retrouvee", () => {
  assert.strictEqual(etat.pieces.length, 1);
});

const piece = etat.pieces[0] || {};

verifier("un document deja lu ne ressort pas 'pas encore lu'", () => {
  assert.strictEqual(piece.lu, true, "la piece est annoncee non lue");
  assert.strictEqual(piece.moteur, "pdf");
  assert.ok(piece.caracteres > 0, "aucun caractere compte");
});

verifier("l'expediteur est nomme, pas '?'", () => {
  assert.strictEqual(piece.expediteur, "Isabelle Nga");
});

verifier("l'heure de reception n'est pas nulle", () => {
  assert.ok(piece.recu, "heure de reception absente");
});

verifier("le fichier est vu sur le disque", () => {
  assert.strictEqual(piece.surLeDisque, true);
});

// Le rendu francais ne doit pas contredire l'etat qu'il resume.
const { enFrancais } = require("./inventaire");
const rendu = enFrancais(etat, "jeudi 24 septembre");

verifier("le texte affiche ne dit pas 'pas encore lu'", () => {
  assert.ok(
    !rendu.includes("pas encore lu"),
    `rendu contradictoire :\n${rendu}`
  );
});

verifier("le texte affiche nomme l'expediteur", () => {
  assert.ok(rendu.includes("Isabelle Nga"), `rendu :\n${rendu}`);
});

console.log(`${reussis} verifications passees (inventaire).`);
