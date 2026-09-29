const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "extraction-texte-")),
  "test.db"
);

// L'injection se fait AVANT de requerir extraction.js : ce fichier destructure
// { genererJson } au moment de son propre chargement, donc le mock doit deja
// etre en place sur l'objet exporte par ia.js pour que la reference capturee
// soit la notre. C'est la meme mecanique qui a cause le bug du 29 septembre :
// une reference resolue une fois, au chargement, et plus jamais revisitee.
const ia = require("./ia");

let dernierAppelGenererJson = null;

ia.genererJson = async (options) => {
  dernierAppelGenererJson = options;

  return {
    donnees: {
      pages: [
        {
          date: "2026-09-28",
          lignes: [
            { nom: "ADANA ASTHORI", heure_arrivee: "07h10", heure_depart: "20h08" },
            { nom: "BEN AZIR", heure_arrivee: "08h40" },
          ],
        },
      ],
    },
  };
};

require("./hr"); // cree le registre du personnel, vide, avant tout appel

const extraction = require("./extraction");
const { aplatir, lirePointageTexte, promptPointageTexte } = extraction;
const { traiterPointage } = require("./assistant");

let reussis = 0;

async function verifier(intitule, fn) {
  try {
    await fn();
    reussis++;
  } catch (erreur) {
    console.error(`ECHEC : ${intitule}\n  ${erreur.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Quatre defauts trouves le 29 septembre en regardant les logs du VPS.
//
// 1. extraction.js importait messageAvecPages mais appelait messageUtilisateur
//    dans extrairePlanning et classerDocument : ReferenceError des le premier
//    planning ou la premiere classification recus, message perdu sans reponse.
// 2. Une fiche de presence arrivee en .docx n'avait aucun chemin de lecture :
//    les deux moteurs de vision n'acceptent pas ce format.
// 3. Une piece que la vision ne sait pas ouvrir disparaissait purement et
//    simplement du message envoye au routage, qui classait alors au hasard --
//    une fiche de presence Word a ete rangee en PERMISSION.
// 4. Un message route en POINTAGE sans la moindre piece jointe repartait en
//    silence : une DRH annoncant une fiche dans le texte, dont le fichier
//    n'etait jamais arrive, n'a reçu aucune reponse en neuf secondes.
//
// En creusant le point 2, un cinquieme defaut est apparu, deja present dans
// le code avant cette session : le mode "un seul moteur a repondu" perdait la
// date de chaque ligne en aplatissant la Map, et toutes les lignes
// s'ecrivaient donc sous date=null, s'ecrasant l'une l'autre.
// ---------------------------------------------------------------------------

(async () => {
  await verifier("point 1 : messageUtilisateur est bien resolu dans extraction.js", () => {
    const source = fs.readFileSync(path.join(__dirname, "extraction.js"), "utf8");
    const enTete = source.split("\n").slice(0, 5).join("\n");

    for (const nom of ["messageAvecPages", "messageUtilisateur"]) {
      const appele = new RegExp(`[^a-zA-Z_]${nom}\\(`).test(source);
      const importe = enTete.includes(nom);

      if (appele) {
        assert.ok(
          importe,
          `${nom} est appele mais absent de la destructuration de "./ia" -- ` +
          `c'est exactement le bug du 29 septembre`
        );
      }
    }
  });

  await verifier("point 5 (decouvert) : aplatir garde la date de chaque ligne", () => {
    const pages = new Map([
      [
        "2026-09-28",
        new Map([
          ["adana asthori", { nom: "ADANA ASTHORI", heure_arrivee: "07h10" }],
          ["ben azir", { nom: "BEN AZIR", heure_arrivee: "08h40" }],
        ]),
      ],
      [
        "2026-09-27",
        new Map([["soh romuald", { nom: "SOH ROMUALD", heure_arrivee: "07h37" }]]),
      ],
    ]);

    const lignes = aplatir(pages);

    assert.strictEqual(lignes.length, 3);
    assert.ok(lignes.every((l) => l.date), "une ligne est ressortie sans date");
    assert.deepStrictEqual(
      lignes.map((l) => l.date).sort(),
      ["2026-09-27", "2026-09-28", "2026-09-28"]
    );
    assert.ok(
      lignes.some((l) => l.date === "2026-09-28" && l.nom === "ADANA ASTHORI")
    );
  });

  await verifier("aplatir rend un tableau vide sur une Map vide", () => {
    assert.deepStrictEqual(aplatir(new Map()), []);
  });

  await verifier("point 2 : une fiche .docx se lit par le texte, pas par la vision", async () => {
    dernierAppelGenererJson = null;

    const texte =
      "28/09/2026\n\nNom et Prénoms\tHeure d'Arrivée\tHDP\tHRP\tHeure de Départ\n" +
      "ADANA ASTHORI\t07h10\t—\t—\t20h08\nBEN AZIR\t08h40\t—\t—\t—";

    const parJour = await lirePointageTexte(texte);

    assert.ok(dernierAppelGenererJson, "genererJson n'a jamais ete appele");
    assert.strictEqual(
      dernierAppelGenererJson.tache,
      "RAPPORT",
      "une fiche texte ne devrait pas passer par la tache VISION, payante et inutile ici"
    );

    const lignes = aplatir(parJour);

    assert.strictEqual(lignes.length, 2);
    assert.strictEqual(
      lignes.find((l) => l.nom === "ADANA ASTHORI")?.date,
      "2026-09-28"
    );
  });

  await verifier("promptPointageTexte porte le texte fourni, sans le tronquer", () => {
    const texte = "TEXTE DE TEST UNIQUE 4de8f1";
    const consigne = promptPointageTexte(texte);

    assert.ok(consigne.includes(texte), "le texte de la fiche n'apparait pas dans la consigne");
    assert.ok(
      /null/.test(consigne),
      "la consigne ne dit pas explicitement de ne jamais deviner une heure absente"
    );
  });

  await verifier(
    "point 4 : un pointage sans piece jointe repond, ne se tait plus",
    async () => {
      let reponse = null;

      await traiterPointage([], async (texte) => {
        reponse = texte;
      });

      assert.ok(
        reponse,
        "traiterPointage([]) est reparti en silence -- exactement le cas du " +
        "29 septembre, ou une DRH annoncant une fiche n'a reçu aucune reponse"
      );
      assert.ok(/aucun fichier/i.test(reponse), `reponse inattendue : ${reponse}`);
    }
  );

  console.log(`${reussis} verifications passees (extraction-texte).`);
})();
