const http = require("http");
const fs = require("fs");
const path = require("path");

const { derniers, statistiques } = require("./journal");
const { evaluerJournee } = require("./presence");
const { revuesEnAttente, listerEmployes, listerRH } = require("./hr");
const { localReportDate } = require("./database");

// ---------------------------------------------------------------------------
// Interface de consultation
//
// Lecture seule : rien ne se modifie depuis le navigateur. Toute ecriture
// passe par Lark, ou la personne est identifiee par son compte. Une page web
// posee sur un VPS n'offre pas cette garantie.
//
// Le serveur ne demarre pas sans INTERFACE_TOKEN : ces pages exposent des
// donnees RH nominatives, et un port ouvert sans secret sur une adresse
// publique les rendrait lisibles par n'importe qui.
// ---------------------------------------------------------------------------

// Port volontairement inhabituel : les ports courants sont deja pris sur le
// VPS, et un port banal attire les balayages automatises.
const PORT = Number(process.env.INTERFACE_PORT || 47821);

// Par defaut la boucle locale uniquement. Le jeton voyage en clair en HTTP :
// expose sur une adresse publique, il se lit dans le trafic ou dans les logs
// d un proxy. On y accede par un tunnel SSH, sauf choix explicite contraire.
const ADRESSE = process.env.INTERFACE_BIND || "127.0.0.1";

function jeton() {
  return (process.env.INTERFACE_TOKEN || "").trim();
}

function autorise(requete, url) {
  const attendu = jeton();
  const fourni =
    url.searchParams.get("cle") ||
    (requete.headers.authorization || "").replace(/^Bearer\s+/i, "");

  // Comparaison a longueur constante : une comparaison ordinaire s'arrete au
  // premier caractere different et laisse deviner le secret par mesure du
  // temps de reponse.
  if (!attendu || !fourni || fourni.length !== attendu.length) {
    return false;
  }

  let ecart = 0;

  for (let i = 0; i < attendu.length; i++) {
    ecart |= attendu.charCodeAt(i) ^ fourni.charCodeAt(i);
  }

  return ecart === 0;
}


function json(reponse, code, corps) {
  const texte = JSON.stringify(corps);

  reponse.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  reponse.end(texte);
}


function donnees(url) {
  const date = url.searchParams.get("date") || localReportDate();

  switch (url.pathname) {
    case "/api/journal":
      return { journal: derniers(url.searchParams.get("limite") || 100) };

    case "/api/statistiques":
      return { statistiques: statistiques(14) };

    case "/api/presence":
      return evaluerJournee(date);

    case "/api/revue":
      return { revues: revuesEnAttente() };

    case "/api/employes":
      return { employes: listerEmployes(), acces: listerRH() };

    default:
      return null;
  }
}


const serveur = http.createServer((requete, reponse) => {
  const url = new URL(requete.url, `http://${requete.headers.host || "localhost"}`);

  if (requete.method !== "GET") {
    return json(reponse, 405, { erreur: "Lecture seule" });
  }

  if (!autorise(requete, url)) {
    return json(reponse, 401, { erreur: "Cle requise" });
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    const page = fs.readFileSync(path.join(__dirname, "interface.html"), "utf8");

    reponse.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // La page ne charge rien depuis l'exterieur : autant l'interdire.
      "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      "Referrer-Policy": "no-referrer",
    });

    return reponse.end(page);
  }

  try {
    const corps = donnees(url);

    return corps
      ? json(reponse, 200, corps)
      : json(reponse, 404, { erreur: "Ressource inconnue" });
  } catch (erreur) {
    console.error("[interface]", erreur.message);
    return json(reponse, 500, { erreur: "Erreur interne" });
  }
});


function demarrer() {
  if (!jeton()) {
    console.warn(
      "[interface] INTERFACE_TOKEN absent : interface desactivee. " +
      "Ces pages exposent des donnees RH nominatives et ne sont pas " +
      "publiees sans secret."
    );
    return null;
  }

  serveur.listen(PORT, ADRESSE, () => {
    console.log(
      `[interface] Consultation sur ${ADRESSE}:${PORT}` +
      (ADRESSE === "127.0.0.1"
        ? " (boucle locale : passer par un tunnel SSH)"
        : " -- ATTENTION : adresse exposee, le jeton circule en clair en HTTP")
    );
  });

  return serveur;
}

module.exports = { demarrer, serveur };
