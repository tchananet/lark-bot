const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Chaque module doit au moins se charger
//
// Le 23 septembre, une fonction retiree de extraction.js est restee dans ses
// exports. Le bot a redemarre en boucle sur "lirePointageMistral is not
// defined" et n'a plus repondu a personne. Les 36 verifications passaient :
// aucune ne chargeait ce fichier.
//
// Ce test ne juge rien du comportement. Il se contente d'exiger que tout le
// code soit chargeable -- ce qui suffit a attraper un export fantome, un
// require casse ou une faute de syntaxe, les trois facons les plus rapides de
// mettre le bot a terre.
//
// index.js est exclu : le charger ouvre la connexion Lark et le serveur web.
// ---------------------------------------------------------------------------

// Les tests sont exclus par motif, pas par liste : une liste nominative
// s'oublie, et le dernier test ajoute venait de faire echouer celui-ci en
// rejouant ses propres insertions.
const EXCLUS = new Set(["index.js", "bot.js"]);

let reussis = 0;

// Une base jetable : charger database.js cree le fichier, et on ne veut pas
// toucher a celui du service.
process.env.DATABASE_PATH =
  process.env.DATABASE_PATH || path.join(require("os").tmpdir(), "test-modules.db");

const modules = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js") && !EXCLUS.has(f))
  .sort();

for (const fichier of modules) {
  try {
    require(path.join(__dirname, fichier));
    reussis++;
  } catch (erreur) {
    console.error(`ECHEC : ${fichier}\n  ${erreur.message}`);
    process.exitCode = 1;
  }
}

assert.ok(modules.length > 10, "la liste des modules semble incomplete");

console.log(`${reussis}/${modules.length} modules charges.`);
