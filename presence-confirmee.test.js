const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "presence-confirmee-")),
  "test.db"
);

// Meme mecanique d'injection que arbitrage-guard.test.js : le mock doit etre
// pose sur l'objet exporte par ia.js AVANT le premier require d'assistant.js.
const ia = require("./ia");

let prochaineReponseModele = null;

ia.generer = async () => ({
  texte: JSON.stringify(prochaineReponseModele),
  usage: {},
  modele: "simule",
});

require("./hr");

const { db } = require("./database");
const { STATUTS, evaluerLigne, faitsDePonctualite } = require("./presence");
const { ouvrirQuestions, questionsOuvertes } = require("./arbitrage");
const { lireReponseAbsences } = require("./assistant");

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
// Le 29 septembre, une DRH a repondu a une question d'arbitrage en nommant
// clairement deux personnes : "MESSIHA ANGE, NGAKEU GLORIA. / presents, tous
// deux etait present". Le vocabulaire d'arbitrage n'avait que des statuts
// d'ABSENCE -- rien ne voulait dire "present". Le systeme a choisi le plus
// proche, PERMISSION, et a fini par ecrire dans le registre que les deux
// etaient en absence EXCUSEE -- l'oppose exact de ce qui avait ete confirme.
//
// Ces tests verifient trois choses : qu'un statut PRESENT existe et ecrit
// bien quelque chose (contrairement a PERMANENCE et TELETRAVAIL avant ce
// correctif, qui n'ecrivaient rien du tout et laissaient la personne
// redevenir ABSENT a la moindre relecture) ; qu'il ne se confond JAMAIS avec
// une absence, justifiee ou non, dans les listes que lit le rapport ; et
// qu'une reponse nommee mais au statut non reconnu ne disparait plus en
// silence.
// ---------------------------------------------------------------------------

for (const nom of ["MESSIHA ANGE", "NGAKEU GLORIA"]) {
  db.prepare(
    `INSERT INTO employees (nom_complet, cle_nom, suivi_presence, mode_travail)
     VALUES (?, ?, 1, 'PRESENTIEL')`
  ).run(nom, nom);
}

const EXPEDITEUR = { nom: "Tchana Netacy", open_id: "ou_test" };


function appel(id, nom, args = {}) {
  return { id, type: "function", function: { name: nom, arguments: JSON.stringify(args) } };
}


(async () => {
  // --- Le coeur de l'incident, rejoue mot pour mot -------------------------
  await verifier(
    "l'incident du 29 septembre : 'présentes' n'est plus pris pour 'permission'",
    async () => {
      const date = "2026-09-29";

      ouvrirQuestions(date, ["MESSIHA ANGE", "NGAKEU GLORIA"]);

      prochaineReponseModele = {
        reponses: [
          { nom: "MESSIHA ANGE", statut: "PRESENT", motif: null },
          { nom: "NGAKEU GLORIA", statut: "PRESENT", motif: null },
        ],
      };

      const texteRecu = "MESSIHA ANGE, NGAKEU GLORIA. presents, tous deux etait present";

      const traite = await lireReponseAbsences(texteRecu, EXPEDITEUR, async () => {});

      assert.strictEqual(traite, true);
      assert.strictEqual(questionsOuvertes(date).length, 0, "les deux auraient du etre tranchees");

      const absences = db
        .prepare(
          `SELECT e.nom_complet, a.type FROM absences a
           JOIN employees e ON e.id = a.employee_id
           WHERE a.date_debut <= ? AND a.date_fin >= ?`
        )
        .all(date, date);

      assert.ok(
        !absences.some((a) => a.type === "PERMISSION"),
        `une absence PERMISSION a ete ecrite a tort : ${JSON.stringify(absences)}`
      );
      assert.ok(
        absences.some((a) => a.nom_complet === "MESSIHA ANGE" && a.type === "PRESENT"),
        "MESSIHA ANGE n'a pas ete enregistree comme presente"
      );
      assert.ok(
        absences.some((a) => a.nom_complet === "NGAKEU GLORIA" && a.type === "PRESENT"),
        "NGAKEU GLORIA n'a pas ete enregistree comme presente"
      );
    }
  );

  // --- Une reponse nommee mais au statut non reconnu doit se voir ----------
  await verifier(
    "un statut non reconnu, sur une personne bien nommee, n'est plus silencieux",
    async () => {
      const date = "2026-09-30";

      ouvrirQuestions(date, ["MESSIHA ANGE"]);

      prochaineReponseModele = {
        reponses: [{ nom: "MESSIHA ANGE", statut: "EN_RETARD", motif: null }],
      };

      let reponseEnvoyee = null;

      const traite = await lireReponseAbsences(
        "Messiha Ange est en retard",
        EXPEDITEUR,
        async (t) => { reponseEnvoyee = t; }
      );

      assert.strictEqual(traite, true, "le message aurait du etre pris en charge");
      assert.ok(reponseEnvoyee, "aucune reponse envoyee a la DRH");
      assert.ok(
        /pas compris/i.test(reponseEnvoyee),
        `la reponse ne signale pas le statut non reconnu : ${reponseEnvoyee}`
      );
      assert.strictEqual(
        questionsOuvertes(date).length,
        1,
        "la question aurait du rester ouverte"
      );
    }
  );

  // --- Le coeur du defaut, au niveau le plus bas : evaluerLigne ------------
  await verifier(
    "PRESENT ne devient ni une absence justifiee, ni une absence non justifiee",
    () => {
      const ligne = evaluerLigne({
        nom: "TEST",
        heure_arrivee: null,
        heure_depart: null,
        de_soir_ce_jour: false,
        de_soir_la_veille: false,
        absence: { type: "PRESENT", motif: null },
        mode_travail: "PRESENTIEL",
      });

      assert.strictEqual(ligne.statut, STATUTS.PRESENT_CONFIRME);
      assert.notStrictEqual(ligne.statut, STATUTS.ABSENT);
      assert.notStrictEqual(ligne.statut, STATUTS.AUTORISEE);
    }
  );

  await verifier(
    "PERMANENCE et TELETRAVAIL ne redeviennent plus ABSENT a la relecture",
    () => {
      // Avant ce correctif, rien n'etait ecrit pour ces deux statuts : une
      // relecture ulterieure de la journee (le cas normal -- un rapport se
      // regenere) retrouvait toujours ABSENT, comme si la question n'avait
      // jamais ete tranchee.
      for (const type of ["PERMANENCE", "TELETRAVAIL"]) {
        const ligne = evaluerLigne({
          nom: "TEST",
          heure_arrivee: null,
          heure_depart: null,
          de_soir_ce_jour: false,
          de_soir_la_veille: false,
          absence: { type, motif: null },
          mode_travail: "PRESENTIEL",
        });

        assert.strictEqual(
          ligne.statut,
          STATUTS.PRESENT_CONFIRME,
          `${type} ne produit pas une presence confirmee`
        );
      }
    }
  );

  // --- Vu depuis le rapport : ni absent, ni excuse, simplement absent des listes
  await verifier(
    "faitsDePonctualite ne compte pas une presence confirmee comme une absence",
    () => {
      const date = "2026-10-01";

      db.prepare(
        `INSERT INTO employees (nom_complet, cle_nom, suivi_presence, mode_travail)
         VALUES ('TEMOIN PRESENT', 'TEMOIN PRESENT', 1, 'PRESENTIEL')`
      ).run();

      const temoin = db.prepare(`SELECT id FROM employees WHERE nom_complet = 'TEMOIN PRESENT'`).get();

      // Une autre personne a bien pointe, pour que la fiche soit consideree
      // recue (sinon faitsDePonctualite rend des listes vides par defaut).
      db.prepare(
        `INSERT INTO employees (nom_complet, cle_nom, suivi_presence, mode_travail)
         VALUES ('TEMOIN POINTE', 'TEMOIN POINTE', 1, 'PRESENTIEL')`
      ).run();

      const pointe = db.prepare(`SELECT id FROM employees WHERE nom_complet = 'TEMOIN POINTE'`).get();

      db.prepare(
        `INSERT INTO attendance (employee_id, date, heure_arrivee, certitude)
         VALUES (?, ?, '08h00', 'CONFIRMEE')`
      ).run(pointe.id, date);

      db.prepare(
        `INSERT INTO absences (employee_id, type, date_debut, date_fin)
         VALUES (?, 'PRESENT', ?, ?)`
      ).run(temoin.id, date, date);

      const p = faitsDePonctualite(date);
      const noms = (liste) => liste.map((l) => l.nom);

      assert.ok(
        !noms(p.absences_non_justifiees).includes("TEMOIN PRESENT"),
        "compte comme absence non justifiee"
      );
      assert.ok(
        !noms(p.absences_justifiees).includes("TEMOIN PRESENT"),
        "compte comme absence justifiee -- c'est pourtant l'erreur exacte de l'incident"
      );
    }
  );

  console.log(`${reussis} verifications passees (presence-confirmee).`);
})();
