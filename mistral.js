require("dotenv").config();

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Mistral OCR
//
// Moteur de reconnaissance dedie, nettement plus rapide et plus fidele sur
// les fiches manuscrites qu'un modele de conversation : sur la fiche du
// 15/09 il lit 4,9 s la ou la double passe Gemini demandait 219 s, et il
// retrouve les heures d'arrivee que Gemini manquait.
//
// Il sert de PREMIERE lecture. La seconde vient d'un autre moteur : deux
// passes du meme modele partagent les memes angles morts.
// ---------------------------------------------------------------------------

const MODELE_OCR = process.env.MISTRAL_OCR_MODEL || "mistral-ocr-latest";

const MIME = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function attendre(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


async function ocr(chemin, options = {}) {
  const cle = process.env.MISTRAL_API || process.env.MISTRAL_API_KEY;

  if (!cle) {
    throw new Error("MISTRAL_API absent de l'environnement");
  }

  const extension = path.extname(chemin).toLowerCase();
  const mimeType = MIME[extension];

  if (!mimeType) {
    throw new Error(`Format non pris en charge par l'OCR : ${extension}`);
  }

  const donnees = fs.readFileSync(chemin).toString("base64");
  const estPdf = mimeType === "application/pdf";

  const document = estPdf
    ? { type: "document_url", document_url: `data:${mimeType};base64,${donnees}` }
    : { type: "image_url", image_url: `data:${mimeType};base64,${donnees}` };

  const tentatives = options.tentatives || 3;

  for (let essai = 1; essai <= tentatives; essai++) {
    const reponse = await fetch("https://api.mistral.ai/v1/ocr", {
      method: "POST",
      headers: { Authorization: `Bearer ${cle}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODELE_OCR, document }),
    });

    const corps = await reponse.json();

    if (reponse.ok) {
      return corps.pages || [];
    }

    const message = corps.message || JSON.stringify(corps);
    const retentable = reponse.status === 429 || reponse.status >= 500;

    if (!retentable || essai === tentatives) {
      throw new Error(`OCR Mistral : ${message}`);
    }

    const delai = 5000 * essai;

    console.warn(
      `[mistral] Tentative ${essai}/${tentatives} echouee (${message}). ` +
      `Nouvelle tentative dans ${delai / 1000}s.`
    );

    await attendre(delai);
  }

  return [];
}


// ---------------------------------------------------------------------------
// Lecture du tableau markdown renvoye par l'OCR
// ---------------------------------------------------------------------------

function normaliserEntete(cellule) {
  return String(cellule || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

// Les colonnes sont reperees par leur intitule, jamais par leur position :
// une colonne ajoutee a la fiche ne doit pas tout decaler en silence.
const COLONNES = [
  { champ: "nom", motif: /^NOMETPRENOMS?$|^NOM$/ },
  { champ: "heure_arrivee", motif: /^HEUREDARRIVEE$/ },
  { champ: "heure_depart_pause", motif: /^HDP$/ },
  { champ: "heure_retour_pause", motif: /^HRP$/ },
  { champ: "heure_depart", motif: /^HEUREDEDEPART$/ },
  { champ: "observation", motif: /^OBSERVATIONS?$/ },
];

function cellules(ligne) {
  return ligne
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function estSeparateur(ligne) {
  return /^\|?[\s:|-]+\|?$/.test(ligne.trim()) && ligne.includes("-");
}


// "DATE : 16/09/2026" -> "2026-09-16"
function dateDeLaPage(markdown) {
  const trouve = markdown.match(/DATE\s*:?\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/i);

  if (!trouve) {
    return null;
  }

  const [, jour, mois, annee] = trouve;

  return `${annee}-${mois.padStart(2, "0")}-${jour.padStart(2, "0")}`;
}


function lignesDuTableau(markdown) {
  const lignes = markdown.split(/\r?\n/).filter((l) => l.trim().startsWith("|"));

  if (!lignes.length) {
    return [];
  }

  const entete = cellules(lignes[0]).map(normaliserEntete);

  // index -> champ, d'apres l'intitule de colonne
  const plan = new Map();

  entete.forEach((titre, index) => {
    for (const { champ, motif } of COLONNES) {
      if (motif.test(titre) && !plan.has(index)) {
        // Une meme colonne ne doit pas etre affectee deux fois : la fiche
        // comporte plusieurs colonnes SIGNATURE, qui ne matchent rien.
        if (![...plan.values()].includes(champ)) {
          plan.set(index, champ);
        }
      }
    }
  });

  if (!([...plan.values()].includes("nom"))) {
    return [];
  }

  return lignes
    .slice(1)
    .filter((l) => !estSeparateur(l))
    .map((ligne) => {
      const valeurs = cellules(ligne);
      const enregistrement = {};

      for (const [index, champ] of plan) {
        enregistrement[champ] = (valeurs[index] || "").trim();
      }

      return enregistrement;
    })
    .filter((e) => e.nom);
}


// Renvoie [{ date, lignes: [...] }] pour chaque page exploitable.
async function lirePointage(chemin) {
  const pages = await ocr(chemin);

  return pages
    .map((page) => ({
      date: dateDeLaPage(page.markdown || ""),
      lignes: lignesDuTableau(page.markdown || ""),
    }))
    .filter((page) => page.date && page.lignes.length);
}

module.exports = { ocr, lirePointage, dateDeLaPage, lignesDuTableau, MODELE_OCR };
