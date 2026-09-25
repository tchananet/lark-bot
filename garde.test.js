const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Base jetable : ce test memorise du texte, il ne doit toucher ni la base du
// poste ni celle du conteneur.
process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "garde-")),
  "test.db"
);

const { memoriserTexte } = require("./database");
const { texteSoumis, citeDansLeMessage } = require("./assistant");

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
// Le garde qui empeche d'inventer des absences -- et qui ne doit pas non plus
// effacer les vraies.
//
// Le 19 septembre, deux messages sans le moindre nom ont produit six absences
// completes, inscrites en base. D'ou la regle : la personne doit etre
// reellement nommee dans ce que l'expediteur a soumis.
//
// Mais un "post" Lark ne portant que des fichiers arrive avec un texte vide.
// Le 25 septembre, NGA ISABELLE et MARIE SHARONE ETOUNA ont ete ecartees alors
// qu'elles etaient nommees dans le planning joint : le garde regardait le
// message seul. Les deux fautes sont symetriques, et ce test tient les deux
// bouts.
// ---------------------------------------------------------------------------

const PLANNING = path.join(os.tmpdir(), "planning-semaine.pdf");

fs.writeFileSync(PLANNING, "piece de test");

memoriserTexte({
  file_path: PLANNING,
  file_name: "planning-semaine.pdf",
  texte:
    "Planning de la semaine du 22 au 27 septembre 2026.\n" +
    "NGA ISABELLE : formation du 24 au 25.\n" +
    "MARIE SHARONE ETOUNA : conge le 24.",
  moteur: "pdf",
});

verifier("un nom ecrit dans le message est retenu", () => {
  assert.strictEqual(
    citeDansLeMessage("NGA ISABELLE", texteSoumis("Isabelle est en formation", [])),
    true
  );
});

verifier("un post sans texte : le nom du document joint compte", () => {
  assert.strictEqual(
    citeDansLeMessage("NGA ISABELLE", texteSoumis("", [PLANNING])),
    true,
    "le nom figure dans le planning joint et devrait etre accepte"
  );
});

verifier("le second nom du document compte aussi", () => {
  assert.strictEqual(
    citeDansLeMessage("MARIE SHARONE ETOUNA", texteSoumis("", [PLANNING])),
    true
  );
});

verifier("un nom absent partout reste refuse", () => {
  assert.strictEqual(
    citeDansLeMessage("BERNARD KOUAM", texteSoumis("", [PLANNING])),
    false,
    "un nom que personne n a ecrit ne doit jamais passer"
  );
});

verifier("sans message ni piece, rien ne passe", () => {
  assert.strictEqual(citeDansLeMessage("NGA ISABELLE", texteSoumis("", [])), false);
});

// Une piece jamais lue n'apporte rien : elle ne doit pas ouvrir la porte.
verifier("une piece non extraite n autorise rien", () => {
  const inconnu = path.join(os.tmpdir(), "jamais-lu.pdf");

  assert.strictEqual(
    citeDansLeMessage("NGA ISABELLE", texteSoumis("", [inconnu])),
    false
  );
});

console.log(`${reussis} verifications passees (garde).`);
