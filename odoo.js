require("dotenv").config();

const { cleNom, normaliserNom } = require("./hr");

// ---------------------------------------------------------------------------
// Passerelle vers Odoo, via l'API JSON-RPC externe
//
// Le meme protocole que celui utilise pour explorer Odoo en conversation
// (login une fois via /jsonrpc, puis execute_kw pour tout le reste). Un seul
// endroit porte les identifiants et la mise en cache du uid -- comme ia.js
// pour les modeles de langage, mais pour les ecritures RH destinees a Odoo
// (permissions, mesures disciplinaires) plutot qu'a notre base SQLite.
//
// Les identifiants (ODOO_URL, ODOO_DB, ODOO_USER, ODOO_PASSWORD) ne sont lus
// qu'au moment d'un appel reel, jamais au chargement du module : une
// installation qui n'utilise pas encore Odoo ne doit pas planter a cause
// d'un require("./odoo") quelque part dans la chaine.
// ---------------------------------------------------------------------------

function variable(nom) {
  const valeur = process.env[nom];

  if (!valeur) {
    throw new Error(`${nom} absent de l'environnement : Odoo n'est pas configure.`);
  }

  return valeur;
}


async function appelerJsonRpc(service, method, args) {
  const url = `${variable("ODOO_URL").replace(/\/$/, "")}/jsonrpc`;

  const reponse = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { service, method, args },
      id: 1,
    }),
  });

  const corps = await reponse.json();

  if (corps.error) {
    throw new Error(
      corps.error.data?.message || corps.error.message || "Erreur Odoo inconnue"
    );
  }

  return corps.result;
}


// Le uid de connexion ne change pas en cours de route : une seule connexion
// par processus, pas une par appel.
let uidEnCache = null;

async function obtenirUid() {
  if (uidEnCache) {
    return uidEnCache;
  }

  const uid = await appelerJsonRpc("common", "login", [
    variable("ODOO_DB"),
    variable("ODOO_USER"),
    variable("ODOO_PASSWORD"),
  ]);

  if (!uid) {
    throw new Error("Connexion a Odoo refusee (identifiants invalides).");
  }

  uidEnCache = uid;

  return uid;
}


async function executerKw(model, methode, args = [], kwargs = {}) {
  const uid = await obtenirUid();

  return appelerJsonRpc("object", "execute_kw", [
    variable("ODOO_DB"),
    uid,
    variable("ODOO_PASSWORD"),
    model,
    methode,
    args,
    kwargs,
  ]);
}


async function creer(model, valeurs) {
  return executerKw(model, "create", [valeurs]);
}


async function ecrire(model, id, valeurs) {
  return executerKw(model, "write", [[id], valeurs]);
}


async function lire(model, domaine, champs, limite = 50) {
  return executerKw(model, "search_read", [domaine], { fields: champs, limit: limite });
}


// ---------------------------------------------------------------------------
// Rattacher un employe de notre registre a son enregistrement Odoo
//
// Les deux registres ne portent pas toujours exactement le meme nom (la
// fiche papier dit "NGA ISABELLE", Odoo dit "NGA ISABELLE SANDRINE" -- l'etat
// civil complet). On reprend ici le meme filet que resoudreEmploye dans
// hr.js : tous les mots du nom recu doivent se retrouver dans le nom Odoo, ou
// l'inverse. La liste des employes Odoo est mise en cache en memoire pour la
// duree du processus : interroger Odoo a chaque resolution couterait un
// aller-retour reseau par ecriture.
// ---------------------------------------------------------------------------

function jetons(valeur) {
  return normaliserNom(valeur).split(" ").filter(Boolean);
}

let employesOdooEnCache = null;

async function employesOdoo() {
  if (!employesOdooEnCache) {
    employesOdooEnCache = await lire(
      "hr.employee",
      [["active", "=", true]],
      ["name"],
      1000
    );
  }

  return employesOdooEnCache;
}


// Expose pour les tests et pour forcer une relecture apres l'ajout d'un
// employe cote Odoo sans redemarrer le bot.
function invaliderCacheEmployes() {
  employesOdooEnCache = null;
}


async function resoudreEmployeOdoo(nomBrut) {
  const employes = await employesOdoo();
  const cle = cleNom(nomBrut);

  const exact = employes.find((e) => cleNom(e.name) === cle);

  if (exact) {
    return exact;
  }

  const recus = jetons(nomBrut);

  const candidats = employes.filter((e) => {
    const connus = new Set(jetons(e.name));

    return recus.every((mot) => connus.has(mot));
  });

  if (candidats.length === 1) {
    return candidats[0];
  }

  if (!candidats.length) {
    const recusConnus = new Set(recus);

    const inverses = employes.filter((e) => {
      const mots = jetons(e.name);

      return mots.length > 1 && mots.every((mot) => recusConnus.has(mot));
    });

    if (inverses.length === 1) {
      return inverses[0];
    }
  }

  return null;
}


// ---------------------------------------------------------------------------
// Types de conge (hr.leave.type) -- recherches par nom plutot que par id en
// dur : un id change d'un environnement Odoo a l'autre, un nom non.
// ---------------------------------------------------------------------------

const typesCongeEnCache = new Map();

async function obtenirTypeConge(nom) {
  if (typesCongeEnCache.has(nom)) {
    return typesCongeEnCache.get(nom);
  }

  const resultats = await lire("hr.leave.type", [["name", "=", nom]], ["name"], 1);
  const type = resultats[0] || null;

  typesCongeEnCache.set(nom, type);

  return type;
}


module.exports = {
  executerKw,
  creer,
  ecrire,
  lire,
  resoudreEmployeOdoo,
  obtenirTypeConge,
  invaliderCacheEmployes,
};
