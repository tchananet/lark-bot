const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "arbitrage-guard-")),
  "test.db"
);

// Meme mecanique que pour les autres tests d'injection : assistant.js
// destructure { generer } depuis "./ia" au moment de son propre chargement.
// Le mock doit donc deja etre pose sur l'objet exporte par ia.js AVANT ce
// premier require, sans quoi assistant.js garde sa reference reelle.
const ia = require("./ia");

let prochaineReponseModele = null;

ia.generer = async () => ({
  texte: JSON.stringify(prochaineReponseModele),
  usage: {},
  modele: "simule",
});

require("./hr");

const { db } = require("./database");
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
// Le 29 septembre, une DRH a repondu a une question d'arbitrage sur trois
// personnes par une consigne de mise en forme du rapport : "Ne nomme
// personne cote RH, dis juste une absence, et s'il y a des retards, tu dis
// qu'il y a eu tel nombre de retards c'est tout". Le mot "absence" a suffi a
// faire confirmer ABSENT pour les trois -- aucune n'etait nommee, aucun
// catch-all explicite n'etait employe.
//
// Le modele qui interprete la reponse PROPOSE ; ces tests verifient que le
// programme VERIFIE avant d'ecrire quoi que ce soit -- la meme discipline
// que partout ailleurs dans ce fichier, jamais sur la seule parole du modele.
//
// Chaque scenario utilise sa PROPRE journee : ouvrirQuestions ne rouvre
// jamais une question deja tranchee (c'est voulu -- une journee tranchee ne
// redemande rien), donc reutiliser une meme date entre scenarios ferait
// silencieusement disparaitre les questions du scenario suivant.
// ---------------------------------------------------------------------------

for (const nom of ["MEDJO LOIC", "NDIANG AVIGAIL", "TCHANA NETACY"]) {
  db.prepare(
    `INSERT INTO employees (nom_complet, cle_nom, suivi_presence, mode_travail)
     VALUES (?, ?, 1, 'PRESENTIEL')`
  ).run(nom, nom);
}

const NOMS = ["MEDJO LOIC", "NDIANG AVIGAIL", "TCHANA NETACY"];
const EXPEDITEUR = { nom: "Tchana Netacy", open_id: "ou_test" };


function reponsesToutAbsent() {
  return { reponses: NOMS.map((nom) => ({ nom, statut: "ABSENT", motif: null })) };
}


(async () => {
  await verifier(
    "l'incident du 29 septembre : le mot 'absence' seul ne confirme rien",
    async () => {
      const date = "2026-09-28";

      ouvrirQuestions(date, NOMS);

      prochaineReponseModele = reponsesToutAbsent();

      const texteRecu =
        "Ne nomme personne côté RH, dis juste une absence, et s'il y a des " +
        "retards, tu dis qu'il y a eu tel nombre de retards c'est tout";

      let reponseEnvoyee = null;

      const traite = await lireReponseAbsences(
        texteRecu,
        EXPEDITEUR,
        async (texte) => { reponseEnvoyee = texte; }
      );

      assert.strictEqual(traite, true, "le message aurait du etre pris en charge");

      const restantes = questionsOuvertes(date).map((q) => q.nom);

      assert.deepStrictEqual(
        restantes.sort(),
        [...NOMS].sort(),
        "au moins une des trois personnes a ete tranchee sans etre nommee"
      );

      assert.ok(reponseEnvoyee, "aucune reponse envoyee a la DRH");
      assert.ok(
        /pas sûr|nomme|préciser|precise/i.test(reponseEnvoyee),
        `la reponse ne demande pas de clarifier : ${reponseEnvoyee}`
      );
    }
  );

  await verifier("nommer chacun, un a un, tranche correctement", async () => {
    const date = "2026-09-29";

    ouvrirQuestions(date, NOMS);

    prochaineReponseModele = {
      reponses: [
        { nom: "MEDJO LOIC", statut: "ABSENT", motif: null },
        { nom: "NDIANG AVIGAIL", statut: "CONGE", motif: null },
        { nom: "TCHANA NETACY", statut: "PERMANENCE", motif: null },
      ],
    };

    const texteRecu =
      "Medjo Loic est absent, Ndiang Avigail est en congé, Tchana Netacy " +
      "était de permanence";

    let reponseEnvoyee = null;

    await lireReponseAbsences(texteRecu, EXPEDITEUR, async (t) => { reponseEnvoyee = t; });

    assert.strictEqual(questionsOuvertes(date).length, 0, "tout aurait du etre tranche");
    assert.ok(/Tout est tranch/i.test(reponseEnvoyee || ""));
  });

  await verifier(
    "un catch-all explicite couvre les personnes non nommees individuellement",
    async () => {
      const date = "2026-09-30";

      ouvrirQuestions(date, NOMS);

      prochaineReponseModele = {
        reponses: [
          { nom: "MEDJO LOIC", statut: "CONGE", motif: null },
          { nom: "NDIANG AVIGAIL", statut: "ABSENT", motif: null },
          { nom: "TCHANA NETACY", statut: "ABSENT", motif: null },
        ],
      };

      const texteRecu = "Medjo Loic en congé, les autres absents";

      await lireReponseAbsences(texteRecu, EXPEDITEUR, async () => {});

      assert.strictEqual(
        questionsOuvertes(date).length,
        0,
        "le catch-all explicite aurait du couvrir les deux non nommees"
      );
    }
  );

  await verifier(
    "le mot 'absent' seul, sans 'les autres' ni 'le reste', ne suffit pas au catch-all",
    async () => {
      const date = "2026-10-01";

      ouvrirQuestions(date, NOMS);

      prochaineReponseModele = {
        reponses: [
          { nom: "MEDJO LOIC", statut: "CONGE", motif: null },
          { nom: "NDIANG AVIGAIL", statut: "ABSENT", motif: null },
          { nom: "TCHANA NETACY", statut: "ABSENT", motif: null },
        ],
      };

      // "absent" est present dans le texte, mais rattache a Medjo Loic
      // uniquement -- ce n'est ni "les autres", ni "le reste".
      const texteRecu = "Medjo Loic en congé, il n'était pas absent hier";

      await lireReponseAbsences(texteRecu, EXPEDITEUR, async () => {});

      const restantes = questionsOuvertes(date).map((q) => q.nom);

      assert.ok(
        restantes.includes("NDIANG AVIGAIL") && restantes.includes("TCHANA NETACY"),
        `les deux non nommees auraient du rester en attente : ${restantes}`
      );
      assert.ok(
        !restantes.includes("MEDJO LOIC"),
        "MEDJO LOIC, lui, etait bien nomme et aurait du etre tranche"
      );
    }
  );

  await verifier("un message totalement etranger ne tranche rien", async () => {
    const date = "2026-10-02";

    ouvrirQuestions(date, NOMS);

    prochaineReponseModele = { reponses: [] };

    const traite = await lireReponseAbsences(
      "salut, ça va ?",
      EXPEDITEUR,
      async () => {}
    );

    assert.strictEqual(traite, false, "un message sans rapport aurait du repartir en routage normal");
    assert.strictEqual(questionsOuvertes(date).length, 3);
  });

  console.log(`${reussis} verifications passees (arbitrage-guard).`);
})();
