const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "erreur-technique-")),
  "test.db"
);

require("./hr");

const { messageErreurTechnique } = require("./assistant");

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
// Le 1er octobre, la cle OpenRouter a depasse sa limite d'usage. L'appel de
// routage a echoue avec un 403 ("Key limit exceeded"), l'erreur est remontee
// jusqu'au gestionnaire de message SANS JAMAIS etre rattrapee avec une
// reponse a la DRH : elle a envoye une fiche de presence et n'a rien reçu en
// retour, aucune trace cote Lark qu'il y avait un probleme.
//
// index.js ne relance plus l'erreur depuis le traitement d'un message RH :
// il appelle toujours messageErreurTechnique() et envoie son resultat au
// salon. Ce fichier verifie que cette fonction distingue une panne cote
// fournisseur d'IA (orienter vers le service technique, la DRH ne peut rien
// y faire) d'une panne quelconque (inviter a reessayer).
// ---------------------------------------------------------------------------

(() => {
  verifier(
    "une erreur avec un statut HTTP oriente vers le service technique",
    () => {
      const erreur = new Error("Key limit exceeded (total limit).");
      erreur.status = 403;

      const message = messageErreurTechnique(erreur);

      assert.ok(
        /service technique/i.test(message),
        `le message ne mentionne pas le service technique : ${message}`
      );
      assert.ok(
        /403/.test(message),
        `le message ne reprend pas le code d'erreur : ${message}`
      );
    }
  );

  verifier(
    "une erreur sans statut HTTP invite a reessayer plutot qu'a contacter",
    () => {
      const message = messageErreurTechnique(new Error("ECONNRESET"));

      assert.ok(
        /r[ée]essaie/i.test(message),
        `le message n'invite pas a reessayer : ${message}`
      );
    }
  );

  verifier("une erreur sans objet (valeur inattendue) ne fait pas planter la fonction", () => {
    const message = messageErreurTechnique(undefined);

    assert.ok(typeof message === "string" && message.length > 0);
  });

  verifier(
    "index.js n'abandonne plus un message RH en echec sans reponse",
    () => {
      const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

      const repere = source.indexOf('resultat: "ERREUR"');

      assert.ok(repere !== -1, "le point de consignation de l'echec a disparu");

      // Les 800 caracteres qui suivent couvrent le reste du bloc catch -- la
      // consignation puis la reponse (ou, en cas de regression, le throw).
      const suiteDuBloc = source.slice(repere, repere + 800);

      assert.ok(
        suiteDuBloc.includes("messageErreurTechnique"),
        "le bloc catch du message RH n'appelle plus messageErreurTechnique : " +
        "regression du 1er octobre, la DRH ne reçoit plus rien en cas de panne"
      );
      assert.ok(
        !suiteDuBloc.includes("throw erreur;"),
        "le bloc catch du message RH relance encore l'erreur sans repondre a la DRH"
      );
    }
  );

  console.log(`${reussis} verifications passees (erreur-technique).`);
})();
