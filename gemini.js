require("dotenv").config();

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Gemini, troisieme moteur de lecture
//
// Le 23 septembre, les deux moteurs en place ont refuse en meme temps : quota
// Mistral epuise, et plafond de la cle OpenRouter descendu sous les 0,50 $
// qu'elle exige pour traiter une piece jointe. Les six comptes rendus du
// lundi sont ressortis "lecture impossible".
//
// Deux fournisseurs qui tombent ensemble, c'est une panne. Trois, c'est
// improbable. Gemini lit les PDF nativement et dispose d'un palier gratuit :
// il ne coute rien de l'avoir en reserve.
//
// Sans GEMINI_API_KEY, ce module se declare simplement indisponible.
// ---------------------------------------------------------------------------

const MODELE = process.env.GEMINI_MODELE || "gemini-3.6-flash";
const RACINE = "https://generativelanguage.googleapis.com/v1beta";
const DELAI = Number(process.env.GEMINI_TIMEOUT || 180000);

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


async function lire(chemin, consigne) {
  const cle = process.env.GEMINI_API_KEY;

  if (!cle) {
    throw new Error("GEMINI_API_KEY absent de l'environnement");
  }

  const mimeType = MIME[path.extname(chemin || "").toLowerCase()];

  if (!mimeType) {
    throw new Error(`Format non pris en charge par Gemini : ${path.extname(chemin)}`);
  }

  const reponse = await fetch(
    `${RACINE}/models/${MODELE}:generateContent?key=${cle}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(DELAI),
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: consigne },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: fs.readFileSync(chemin).toString("base64"),
                },
              },
            ],
          },
        ],
        generationConfig: { temperature: 0 },
      }),
    }
  );

  const corps = await reponse.json();

  if (!reponse.ok) {
    throw new Error(`Gemini : ${corps?.error?.message || reponse.status}`);
  }

  const texte = (corps.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();

  if (!texte) {
    // Une reponse vide a une cause : quota, filtre de securite, document
    // illisible. La taire ferait passer le document pour vide.
    throw new Error(
      `Gemini n'a rien renvoye (${corps.candidates?.[0]?.finishReason || "sans motif"})`
    );
  }

  return texte;
}

module.exports = { lire, disponible, MODELE };
