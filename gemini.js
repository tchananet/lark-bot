require("dotenv").config();

const { GoogleGenAI } = require("@google/genai");

// flash-lite : 0,7 s contre 1,7 s pour flash sur nos taches, et surtout des
// quotas gratuits bien plus larges. Le palier gemini-3.6-flash plafonnait a
// 20 requetes par jour, ce qui ne tient pas une seule journee de travail.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const TIMEOUT_MS = Number(process.env.DIGEST_TIMEOUT_MS || 120000);
const TENTATIVES = Number(process.env.DIGEST_RETRY_ATTEMPTS || 4);

function client() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY absent de l'environnement");
  }

  return new GoogleGenAI({
    apiKey,
    // Borne chaque tentative. Le SDK s'en sert aussi pour relever les
    // timeouts undici, a l'origine de UND_ERR_HEADERS_TIMEOUT.
    httpOptions: { timeout: TIMEOUT_MS },
  });
}

function attendre(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// On ne peut pas s'appuyer sur les retryOptions du SDK : il delegue a
// p-retry, qui abandonne immediatement sur TypeError sauf pour quatre
// messages propres aux navigateurs. Node lance "TypeError: fetch failed",
// absent de cette liste, donc une coupure reseau n'est jamais retentee.
async function generer(requete, options = {}) {
  const ai = options.ai || client();
  const tentatives = options.tentatives || TENTATIVES;

  for (let essai = 1; essai <= tentatives; essai++) {
    try {
      return await ai.models.generateContent({ model: MODEL, ...requete });
    } catch (erreur) {
      const status = erreur?.status;

      // Pas de status = panne reseau ou timeout : on retente.
      // Un 4xx (cle invalide, requete trop grosse) ne s'arrangera pas.
      const retentable =
        status === undefined ||
        status === 408 ||
        status === 429 ||
        status >= 500;

      if (!retentable || essai === tentatives) {
        throw erreur;
      }

      const delai = Math.min(30000, 5000 * 2 ** (essai - 1));

      console.warn(
        `[gemini] Tentative ${essai}/${tentatives} echouee ` +
        `(${erreur?.message || erreur}). Nouvelle tentative dans ${delai / 1000}s.`
      );

      await attendre(delai);
    }
  }
}

// Reponse contrainte par un schema JSON, puis analysee. Le modele peut
// encore renvoyer du texte invalide : on echoue bruyamment plutot que de
// laisser passer un objet a moitie lu.
async function genererJson(requete, options = {}) {
  const { schema, config, ...reste } = requete;

  const reponse = await generer(
    {
      ...reste,
      config: {
        ...(config || {}),
        responseMimeType: "application/json",
        ...(schema ? { responseJsonSchema: schema } : {}),
      },
    },
    options
  );

  const brut = (reponse.text || "").trim();

  try {
    return JSON.parse(brut);
  } catch (erreur) {
    throw new Error(
      `Reponse JSON illisible (${brut.length} caracteres) : ${brut.slice(0, 200)}`
    );
  }
}

module.exports = { MODEL, client, generer, genererJson };
