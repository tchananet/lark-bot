const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "silence-")),
  "test.db"
);

// Meme mecanique d'injection que les autres tests de cette semaine : le mock
// doit etre en place sur l'objet exporte par ia.js AVANT le premier require
// de assistant.js (qui destructure generer/genererJson a son chargement, et
// entraine routeur.js avec lui).
const ia = require("./ia");

let prochaineReponseRoutage = null;

ia.genererJson = async () => ({
  donnees: prochaineReponseRoutage,
  usage: {},
  modele: "simule",
});

require("./hr");

const { traiter, traiterConversation } = require("./assistant");

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
// Une pièce jointe qui arrive doit toujours recevoir une réponse. Neuf des
// dix branches de traiter() le garantissaient déjà ; deux ne le faisaient
// pas, trouvées en revérifiant chacune après coup :
//
// 1. traiterConversation (QUESTION, ou message ambigu avec fichier) se
//    taisait si le fichier n'avait pas pu être lu et que le texte qui
//    l'accompagnait était court -- exactement le cas d'un post Lark portant
//    juste un fichier.
// 2. GESTION_ACCES se taisait si l'intention était reconnue mais qu'aucun
//    detail exploitable n'avait ete extrait.
// ---------------------------------------------------------------------------

const EXPEDITEUR = { nom: "Tchana Netacy", open_id: "ou_test" };

(async () => {

await verifier(
  "un fichier joint illisible, sans texte, recoit une reponse",
  async () => {
    let reponseEnvoyee = null;

    // "/chemin/inexistant.jpg" n'a jamais ete lu : texteConnu() y renverra
    // toujours null, simulant une lecture qui a echoue.
    await traiterConversation(
      "",
      ["/chemin/inexistant.jpg"],
      async (texte) => { reponseEnvoyee = texte; }
    );

    assert.ok(reponseEnvoyee, "aucune reponse envoyee pour un fichier illisible");
    assert.ok(/pas réussi à lire/i.test(reponseEnvoyee), `reponse inattendue : ${reponseEnvoyee}`);
  }
);

await verifier(
  "aucun fichier et un texte trop court restent silencieux (comportement voulu)",
  async () => {
    let appele = false;

    await traiterConversation("ok", [], async () => { appele = true; });

    assert.strictEqual(appele, false, "un simple 'ok' sans fichier ne devrait rien declencher");
  }
);

await verifier(
  "GESTION_ACCES sans detail exploitable repond, ne se tait plus",
  async () => {
    prochaineReponseRoutage = {
      intention: "GESTION_ACCES",
      certitude: "HAUTE",
      explication: "test",
      // acces volontairement absent : le modele n'a rien pu en tirer.
    };

    let reponseEnvoyee = null;

    await traiter({
      texte: "gere les acces stp",
      fichiers: [],
      expediteur: EXPEDITEUR,
      repondre: async (texte) => { reponseEnvoyee = texte; },
    });

    assert.ok(reponseEnvoyee, "aucune reponse envoyee pour un GESTION_ACCES sans detail");
    assert.ok(/accès/i.test(reponseEnvoyee), `reponse inattendue : ${reponseEnvoyee}`);
  }
);

await verifier("GESTION_ACCES avec un detail exploitable fonctionne toujours", async () => {
  prochaineReponseRoutage = {
    intention: "GESTION_ACCES",
    certitude: "HAUTE",
    explication: "test",
    acces: { action: "LISTER" },
  };

  let reponseEnvoyee = null;

  await traiter({
    texte: "qui a acces ?",
    fichiers: [],
    expediteur: EXPEDITEUR,
    repondre: async (texte) => { reponseEnvoyee = texte; },
  });

  assert.ok(reponseEnvoyee, "aucune reponse envoyee");
  assert.ok(
    !/Je n'ai pas compris/.test(reponseEnvoyee),
    "un cas qui fonctionne a ete pris pour un cas non reconnu"
  );
});

console.log(`${reussis} verifications passees (silence).`);

})();
