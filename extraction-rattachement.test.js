const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "extraction-rattachement-")),
  "test.db"
);

require("./hr");

const { db } = require("./database");
const { ajouterAlias } = require("./hr");
const { confronter } = require("./extraction");

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

function ajouterEmploye(nomComplet, cleNom) {
  db.prepare(
    `INSERT INTO employees (nom_complet, cle_nom, suivi_presence, mode_travail)
     VALUES (?, ?, 1, 'PRESENTIEL')`
  ).run(nomComplet, cleNom);
}

// ---------------------------------------------------------------------------
// Le 30 septembre, sur la fiche reelle, un moteur a lu "SOH ROMUALD", l'autre
// "SOH ROMUALD BRICE" -- la meme personne, bien presente de 07h30 a 17h28.
// confronter() comparait alors par le texte brut de chaque lecture : les deux
// transcriptions ne portaient pas la meme cle, chacune etait vue "par un seul
// moteur", aucune n'etait retenue, et SOH ROMUALD est ressorti ABSENT dans le
// rapport alors qu'il avait signe. Meme chose pour "MESSINA ANGE" / "MESSIHA
// ANGE" (une lettre confondue par l'OCR).
//
// La correction rattache chaque lecture a un employe reel (resoudreEmploye,
// deja utilise plus loin dans le pipeline) avant de comparer, pour que deux
// transcriptions differentes de la meme personne soient vues comme UNE seule
// ligne.
// ---------------------------------------------------------------------------

ajouterEmploye("SOH ROMUALD", "ROMUALD SOH");
ajouterEmploye("MESSIHA ANGE", "ANGE MESSIHA");
ajouterEmploye("ADANA ASTHORI", "ADANA ASTHORI");

// Contrairement a "SOH ROMUALD BRICE", une lettre confondue (MESSINA/MESSIHA)
// n'est pas un sous-ensemble de jetons : resoudreEmploye ne la rapproche pas
// de lui-meme. Elle ne se resout que si quelqu'un l'a deja vue une fois et
// que l'alias a ete retenu -- exactement ce qui s'est produit en production
// apres une premiere revue manuelle. Le test reproduit cet etat.
{
  const { employe } = require("./hr").resoudreEmploye("MESSIHA ANGE");
  ajouterAlias(employe.id, "MESSINA ANGE", "TEST");
}

(() => {
  verifier(
    "un nom abrege par un moteur et complet par l'autre sont vus comme la meme personne",
    () => {
      const passeA = new Map([
        [
          "2026-09-30",
          new Map([
            [
              "romuald soh",
              {
                nom: "SOH ROMUALD",
                heure_arrivee: "07h30",
                heure_depart_pause: "14h43",
                heure_retour_pause: "16h25",
                heure_depart: "17h28",
                observation: "MANUSCRIT",
              },
            ],
          ]),
        ],
      ]);

      const passeB = new Map([
        [
          "2026-09-30",
          new Map([
            [
              "brice romuald soh",
              {
                nom: "SOH ROMUALD BRICE",
                heure_arrivee: "07h30",
                heure_depart_pause: "14h43",
                heure_retour_pause: "16h25",
                heure_depart: "17h28",
                observation: "MANUSCRIT",
              },
            ],
          ]),
        ],
      ]);

      const { retenus, divergences } = confronter(passeA, passeB);

      assert.strictEqual(
        divergences.length,
        0,
        `SOH ROMUALD est encore parti en revue : ${JSON.stringify(divergences)}`
      );
      assert.strictEqual(retenus.length, 1, "la ligne n'a pas ete retenue");
      assert.strictEqual(retenus[0].heure_depart, "17h28");
    }
  );

  verifier(
    "une lettre confondue par l'OCR, deja resolue par un alias, n'ecarte pas la ligne",
    () => {
      const passeA = new Map([
        [
          "2026-09-30",
          new Map([
            [
              "ange messiha",
              {
                nom: "MESSIHA ANGE",
                heure_arrivee: "08h01",
                heure_depart_pause: "13h37",
                heure_retour_pause: "14h37",
                heure_depart: "18h10",
                observation: "ÉMARGÉ",
              },
            ],
          ]),
        ],
      ]);

      const passeB = new Map([
        [
          "2026-09-30",
          new Map([
            [
              "ange messina",
              {
                nom: "MESSINA ANGE",
                heure_arrivee: "08h01",
                heure_depart_pause: "13h37",
                heure_retour_pause: "14h37",
                heure_depart: "18h10",
                observation: "EMARGÉ",
              },
            ],
          ]),
        ],
      ]);

      const { retenus, divergences } = confronter(passeA, passeB);

      assert.strictEqual(divergences.length, 0, JSON.stringify(divergences));
      assert.strictEqual(retenus.length, 1);
    }
  );

  verifier(
    "deux personnes reellement differentes restent deux lignes distinctes",
    () => {
      const passeA = new Map([
        [
          "2026-09-30",
          new Map([
            [
              "adana asthori",
              { nom: "ADANA ASTHORI", heure_arrivee: "07h10", heure_depart_pause: null, heure_retour_pause: null, heure_depart: "20h08", observation: null },
            ],
          ]),
        ],
      ]);

      const passeB = new Map([
        [
          "2026-09-30",
          new Map([
            [
              "romuald soh",
              { nom: "SOH ROMUALD", heure_arrivee: "07h30", heure_depart_pause: null, heure_retour_pause: null, heure_depart: "17h28", observation: null },
            ],
          ]),
        ],
      ]);

      const { retenus, divergences } = confronter(passeA, passeB);

      assert.strictEqual(retenus.length, 0);
      assert.strictEqual(divergences.length, 2, "ADANA ASTHORI et SOH ROMUALD doivent rester deux lignes distinctes, chacune signalee");
    }
  );

  verifier(
    "un nom hors registre n'est pas silencieusement perdu",
    () => {
      const passeA = new Map([
        [
          "2026-09-30",
          new Map([
            [
              "inconnu total",
              { nom: "INCONNU TOTAL", heure_arrivee: "08h00", heure_depart_pause: null, heure_retour_pause: null, heure_depart: "18h00", observation: null },
            ],
          ]),
        ],
      ]);

      const passeB = new Map([["2026-09-30", new Map()]]);

      const { retenus, divergences } = confronter(passeA, passeB);

      assert.strictEqual(retenus.length, 0);
      assert.strictEqual(divergences.length, 1);
      assert.strictEqual(divergences[0].nom_brut, "INCONNU TOTAL");
    }
  );

  console.log(`${reussis} verifications passees (extraction-rattachement).`);
})();
