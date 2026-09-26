const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "pages-")),
  "test.db"
);

const { ramenerALaMemeJournee } = require("./extraction");

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
// Une fiche en deux pages reste une seule journee.
//
// Chaque image etait lue comme un document independant, qui se datait sur son
// propre en-tete. Une fiche de presence tient rarement sur une page, et la
// suite ne reprend pas l'en-tete : le modele n'y trouvait aucune date, en
// devinait une, et la journee se retrouvait coupee en deux -- la moitie des
// gens sur un jour, l'autre moitie sur le jour voisin, et tout le monde
// absent de part et d'autre.
// ---------------------------------------------------------------------------

function page(date, noms, divergences = []) {
  return {
    retenus: noms.map((nom) => ({ nom, date, heure_arrivee: "08h00" })),
    divergences: divergences.map((nom) => ({ date, nom_brut: nom, motif: "test" })),
    moteurUnique: null,
  };
}


verifier("la suite sans en-tete herite de la journee de la premiere page", () => {
  const lectures = [
    page("2026-09-24", ["ADANA", "ALIMATOU", "BEN AZIR"]),
    page("2026-09-25", ["SOH", "TIAKO"]),
  ];

  const { reference, ecartees } = ramenerALaMemeJournee(lectures);

  assert.strictEqual(reference, "2026-09-24");
  assert.deepStrictEqual(ecartees, ["2026-09-25"]);

  const dates = new Set(lectures.flatMap((l) => l.retenus).map((l) => l.date));

  assert.deepStrictEqual([...dates], ["2026-09-24"], "la journee est restée coupée");
});


verifier("les cellules en revue suivent la meme journee", () => {
  const lectures = [
    page("2026-09-24", ["ADANA"]),
    page("2026-09-25", ["SOH"], ["NGA CATHERINE"]),
  ];

  ramenerALaMemeJournee(lectures);

  assert.strictEqual(lectures[1].divergences[0].date, "2026-09-24");
});


verifier("deux pages deja d'accord ne declenchent aucun recadrage", () => {
  const lectures = [
    page("2026-09-24", ["ADANA"]),
    page("2026-09-24", ["SOH"]),
  ];

  const { reference, ecartees } = ramenerALaMemeJournee(lectures);

  assert.strictEqual(reference, "2026-09-24");
  assert.deepStrictEqual(ecartees, []);
});


verifier("une premiere page illisible cede la reference a la suivante", () => {
  const lectures = [
    page("2026-09-24", []),
    page("2026-09-25", ["SOH", "TIAKO"]),
  ];

  const { reference, ecartees } = ramenerALaMemeJournee(lectures);

  assert.strictEqual(reference, "2026-09-25");
  assert.deepStrictEqual(ecartees, []);
});


verifier("sur une page, la date la mieux representee l'emporte", () => {
  // Les deux moteurs ont lu deux en-tetes differents sur la meme page : la
  // date portee par le plus de lignes est la bonne.
  const lectures = [
    {
      retenus: [
        { nom: "ADANA", date: "2026-09-24" },
        { nom: "ALIMATOU", date: "2026-09-24" },
        { nom: "BEN AZIR", date: "2026-09-24" },
        { nom: "SOH", date: "2026-03-24" },
      ],
      divergences: [],
      moteurUnique: null,
    },
  ];

  const { reference } = ramenerALaMemeJournee(lectures);

  assert.strictEqual(reference, "2026-09-24");
});


verifier("un envoi sans aucune ligne ne force rien", () => {
  const { reference, ecartees } = ramenerALaMemeJournee([page("2026-09-24", [])]);

  assert.strictEqual(reference, null);
  assert.deepStrictEqual(ecartees, []);
});


console.log(`${reussis} verifications passees (pages).`);
