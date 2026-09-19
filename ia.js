require("dotenv").config();

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Passerelle vers les modeles, via OpenRouter
//
// Un seul endroit porte la cle, le choix du modele et la reprise sur erreur.
// Les appelants demandent une TACHE, pas un modele : ils n'ont pas a savoir
// lequel la sert.
//
// Chaque tache a ete choisie sur mesure, pas au jugement :
//   ROUTAGE  mistral-nemo   18/18 sur les phrases reelles, 1,2 s, le moins
//                           cher du banc d'essai.
//   RAPPORT  deepseek-v3.2  seul a passer la validation du rapport. GLM
//                           4.7-flash ecrivait cinq fois plus de tokens pour
//                           le meme document, donc coutait plus cher malgre
//                           un prix au token inferieur.
//   VISION   glm-5.3-flash  13 arrivees sur 14 lues correctement sur la
//                           fiche manuscrite reelle.
// ---------------------------------------------------------------------------

const BASE = process.env.IA_BASE_URL || "https://openrouter.ai/api/v1";

const MODELES = {
  ROUTAGE: process.env.IA_MODELE_ROUTAGE || "mistralai/mistral-nemo",
  RAPPORT: process.env.IA_MODELE_RAPPORT || "deepseek/deepseek-v3.2",
  VISION: process.env.IA_MODELE_VISION || "z-ai/glm-5.3-flash",
};

const TIMEOUTS = {
  ROUTAGE: Number(process.env.IA_TIMEOUT_ROUTAGE || 60000),
  RAPPORT: Number(process.env.IA_TIMEOUT_RAPPORT || 180000),
  // La lecture d'un scan de plusieurs Mo est lente : OpenRouter analyse le
  // PDF avant meme d'appeler le modele.
  VISION: Number(process.env.IA_TIMEOUT_VISION || 300000),
};

const TENTATIVES = Number(process.env.IA_TENTATIVES || 4);

const MIME = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};


function cle() {
  const valeur = process.env.OPENROUTER_API_KEY;

  if (!valeur) {
    throw new Error("OPENROUTER_API_KEY absent de l'environnement");
  }

  return valeur;
}


function attendre(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// Le mode strict exige additionalProperties:false sur chaque objet. Nos
// schemas ne le portent pas : on le pose ici plutot que de le repeter.
function durcir(noeud) {
  if (!noeud || typeof noeud !== "object") {
    return noeud;
  }

  if (noeud.type === "object") {
    noeud.additionalProperties = false;
    Object.values(noeud.properties || {}).forEach(durcir);
  }

  if (noeud.type === "array") {
    durcir(noeud.items);
  }

  return noeud;
}


// Une piece jointe au format attendu par l'API. Les PDF passent par le type
// "file" : OpenRouter les analyse avant de les transmettre au modele.
function partieFichier(chemin) {
  const mimeType = MIME[path.extname(chemin || "").toLowerCase()];

  if (!mimeType || !fs.existsSync(chemin)) {
    return null;
  }

  const donnees = `data:${mimeType};base64,${fs.readFileSync(chemin).toString("base64")}`;

  return mimeType === "application/pdf"
    ? { type: "file", file: { filename: path.basename(chemin), file_data: donnees } }
    : { type: "image_url", image_url: { url: donnees } };
}


async function appeler(requete, tache) {
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), TIMEOUTS[tache] || 120000);

  try {
    const reponse = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cle()}`,
        "Content-Type": "application/json",
        "X-Title": "Assistant RH ALPHA MOTORS",
      },
      body: JSON.stringify(requete),
      signal: controleur.signal,
    });

    const corps = await reponse.json();

    if (!reponse.ok) {
      const erreur = new Error(corps.error?.message || JSON.stringify(corps));
      erreur.status = reponse.status;
      throw erreur;
    }

    return corps;
  } finally {
    clearTimeout(minuteur);
  }
}


async function generer(options) {
  const {
    tache = "RAPPORT",
    messages,
    schema = null,
    temperature = 0,
    modele = null,
  } = options;

  const requete = {
    model: modele || MODELES[tache] || MODELES.RAPPORT,
    temperature,
    messages,
    usage: { include: true },
    ...(schema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "reponse",
              strict: true,
              schema: durcir(JSON.parse(JSON.stringify(schema))),
            },
          },
        }
      : {}),
  };

  for (let essai = 1; essai <= TENTATIVES; essai++) {
    try {
      const corps = await appeler(requete, tache);

      return {
        texte: corps.choices?.[0]?.message?.content || "",
        usage: corps.usage || {},
        modele: requete.model,
      };
    } catch (erreur) {
      const status = erreur.status;

      // Pas de status : coupure reseau ou delai depasse, donc on retente.
      // Un 4xx (cle invalide, requete trop grosse) ne s'arrangera pas.
      const retentable =
        status === undefined || status === 408 || status === 429 || status >= 500;

      if (!retentable || essai === TENTATIVES) {
        throw erreur;
      }

      const delai = Math.min(30000, 5000 * 2 ** (essai - 1));

      console.warn(
        `[ia] ${tache} tentative ${essai}/${TENTATIVES} echouee ` +
        `(${(erreur.message || erreur).toString().slice(0, 90)}). ` +
        `Nouvelle tentative dans ${delai / 1000}s.`
      );

      await attendre(delai);
    }
  }
}


async function genererJson(options) {
  const resultat = await generer(options);
  const brut = (resultat.texte || "").trim();

  // Le mode strict n'est pas toujours honore : on echoue bruyamment plutot
  // que de laisser passer un objet a moitie lu.
  try {
    return { ...resultat, donnees: JSON.parse(brut) };
  } catch (erreur) {
    throw new Error(
      `Reponse JSON illisible de ${resultat.modele} ` +
      `(${brut.length} caracteres) : ${brut.slice(0, 200)}`
    );
  }
}


// Construit un message utilisateur melant texte et pieces jointes.
function messageUtilisateur(texte, fichiers = []) {
  const parties = [{ type: "text", text: texte }];

  for (const chemin of fichiers) {
    const partie = partieFichier(chemin);

    if (partie) {
      parties.push({ type: "text", text: `\nPIECE JOINTE : ${path.basename(chemin)}` });
      parties.push(partie);
    }
  }

  return { role: "user", content: parties.length === 1 ? texte : parties };
}

module.exports = {
  MODELES,
  generer,
  genererJson,
  partieFichier,
  messageUtilisateur,
};
