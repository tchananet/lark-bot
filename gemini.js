require("dotenv").config();

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Gemini, moteur de lecture principal
//
// Le 23 septembre, les deux moteurs en place ont refuse en meme temps : quota
// gratuit Mistral epuise, et plafond de la cle OpenRouter descendu sous les
// 0,50 $ qu'elle exige pour traiter une piece jointe. Les six comptes rendus
// du lundi sont ressortis "lecture impossible".
//
// Gemini lit les PDF et les photos nativement, sur un palier gratuit. Il
// passe donc en premier : aucune lecture ne doit dependre d'un compte
// prepaye. Mistral et le modele de vision restent en secours.
//
// Sans GEMINI_API_KEY, ce module se declare simplement indisponible et la
// chaine repart sur les moteurs suivants.
// ---------------------------------------------------------------------------

// Plusieurs modeles plutot qu un seul. Le palier gratuit sature modele par
// modele : quand gemini-3.6-flash repond "high demand", un modele plus leger
// passe souvent du premier coup. Attendre le meme backend pendant une minute
// ne sert a rien, basculer coute une seconde.
const MODELES = (process.env.GEMINI_MODELES ||
  "gemini-3.6-flash,gemini-3.5-flash-lite,gemini-2.5-flash-lite,gemini-2.5-flash"
).split(",").map((m) => m.trim()).filter(Boolean);

const MODELE = MODELES[0];
const RACINE = "https://generativelanguage.googleapis.com/v1beta";
const DELAI = Number(process.env.GEMINI_TIMEOUT || 180000);
const TENTATIVES = Number(process.env.GEMINI_TENTATIVES || 4);

const MIME = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function disponible() {
  return !!process.env.GEMINI_API_KEY;
}

function attendre(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// Le palier gratuit connait des pics : "This model is currently experiencing
// high demand", quelques minutes apres une lecture reussie. Ce n'est pas une
// panne, c'est une file d'attente. Sans reprises, ce moteur serait
// inutilisable et chaque bouffee de charge renverrait vers les comptes
// payants -- ce qu'on cherche precisement a eviter.
async function appeler(corps) {
  const cle = process.env.GEMINI_API_KEY;

  if (!cle) {
    throw new Error("GEMINI_API_KEY absent de l'environnement");
  }

  let dernier = null;

  // Chaque modele est essaye a son tour ; on ne s acharne pas sur un backend
  // sature quand un autre est libre.
  for (const modele of MODELES) {
  for (let essai = 1; essai <= TENTATIVES; essai++) {
    try {
      const reponse = await fetch(
        `${RACINE}/models/${modele}:generateContent?key=${cle}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(DELAI),
          body: JSON.stringify(corps),
        }
      );

      const json = await reponse.json();

      if (reponse.ok) {
        return json;
      }

      const message = json?.error?.message || String(reponse.status);

      dernier = new Error(`Gemini (${modele}) : ${message}`);

      // 429 file d'attente, 5xx incident passager, "high demand" surcharge.
      // Une cle invalide ou un modele retire, eux, ne s'arrangeront pas.
      const retentable =
        reponse.status === 429 ||
        reponse.status >= 500 ||
        /high demand|overload/i.test(message);

      // Modele sature ou retire : inutile d insister, on passe au suivant.
      if (!retentable) {
        break;
      }

      if (essai === TENTATIVES) {
        break;
      }
    } catch (erreur) {
      dernier = erreur;

      if (essai === TENTATIVES) {
        break;
      }
    }

    const delai = 3000 * essai;

    console.warn(
      `[gemini] ${modele}, tentative ${essai}/${TENTATIVES} ` +
      `(${String(dernier.message).slice(0, 70)}). Reprise dans ${delai / 1000}s.`
    );

    await attendre(delai);
  }

  console.warn(`[gemini] ${modele} indisponible, modele suivant.`);
  }

  throw dernier;
}


function piece(chemin, consigne) {
  const mimeType = MIME[path.extname(chemin || "").toLowerCase()];

  if (!mimeType) {
    throw new Error(`Format non pris en charge par Gemini : ${path.extname(chemin)}`);
  }

  return [
    { text: consigne },
    {
      inline_data: {
        mime_type: mimeType,
        data: fs.readFileSync(chemin).toString("base64"),
      },
    },
  ];
}


function texteDe(corps) {
  return (corps.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();
}


async function lire(chemin, consigne) {
  const corps = await appeler({
    contents: [{ parts: piece(chemin, consigne) }],
    generationConfig: { temperature: 0 },
  });

  const texte = texteDe(corps);

  if (!texte) {
    // Une reponse vide a une cause : quota, filtre de securite, document
    // illisible. La taire ferait passer le document pour vide.
    throw new Error(
      `Gemini n'a rien renvoye (${corps.candidates?.[0]?.finishReason || "sans motif"})`
    );
  }

  return texte;
}


// Meme appel, mais le modele doit rendre du JSON conforme au schema. Sert a
// lire une fiche de presence sans dependre d'un fournisseur payant.
async function lireJson(chemin, consigne, schema) {
  const corps = await appeler({
    contents: [{ parts: piece(chemin, consigne) }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: pourGemini(schema),
    },
  });

  const brut = texteDe(corps);

  try {
    return JSON.parse(brut);
  } catch (erreur) {
    throw new Error(
      `Gemini : reponse JSON illisible (${brut.length} caracteres) : ${brut.slice(0, 160)}`
    );
  }
}


// Gemini refuse les mots-cles de JSON Schema qu'il ne connait pas --
// additionalProperties, $schema, const. On ne garde que ce qu'il accepte.
function pourGemini(noeud) {
  if (Array.isArray(noeud)) {
    return noeud.map(pourGemini);
  }

  if (!noeud || typeof noeud !== "object") {
    return noeud;
  }

  const garde = {};

  for (const [cle, valeur] of Object.entries(noeud)) {
    if (["additionalProperties", "$schema", "const", "default"].includes(cle)) {
      continue;
    }

    garde[cle] = pourGemini(valeur);
  }

  return garde;
}

module.exports = { lire, lireJson, disponible, MODELE };
