const fs = require("fs");
const path = require("path");

const { GoogleGenAI } = require("@google/genai");
const { genererJson } = require("./gemini");
const { normaliserHeure } = require("./temps");
const { lirePointage: lireOcrMistral } = require("./mistral");
const {
  listerEmployes,
  resoudreEmploye,
  enregistrerPointage,
  enregistrerPosteDeSoir,
  signalerPourRevue,
  cleNom,
} = require("./hr");

const MIME = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

// Deux lectures independantes de la meme feuille manuscrite. La temperature
// n'est pas nulle : a temperature nulle les deux passes renverraient la meme
// chose, y compris la meme erreur, et la comparaison ne prouverait rien. On
// veut au contraire que l'incertitude reelle du modele se manifeste par un
// desaccord.
const TEMPERATURE_EXTRACTION = Number(process.env.RH_TEMPERATURE_EXTRACTION || 0.4);

// La lecture dune fiche manuscrite numerisee est bien plus lente quune
// synthese de texte : 120 s ne suffisent pas pour un scan de plusieurs Mo.
const TIMEOUT_EXTRACTION_MS = Number(process.env.RH_TIMEOUT_EXTRACTION_MS || 300000);

function clientExtraction() {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { timeout: TIMEOUT_EXTRACTION_MS },
  });
}

const CHAMPS_HORAIRES = [
  "heure_arrivee",
  "heure_depart_pause",
  "heure_retour_pause",
  "heure_depart",
];


function partieFichier(chemin) {
  const mimeType = MIME[path.extname(chemin).toLowerCase()];

  if (!mimeType) {
    throw new Error(`Format non pris en charge pour l'extraction : ${chemin}`);
  }

  return {
    inlineData: { mimeType, data: fs.readFileSync(chemin).toString("base64") },
  };
}


// ---------------------------------------------------------------------------
// Fiche de presence
// ---------------------------------------------------------------------------

const SCHEMA_POINTAGE = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          lignes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                nom: { type: "string" },
                heure_arrivee: { type: "string" },
                heure_depart_pause: { type: "string" },
                heure_retour_pause: { type: "string" },
                heure_depart: { type: "string" },
                observation: { type: "string" },
              },
              required: [
                "nom",
                "heure_arrivee",
                "heure_depart_pause",
                "heure_retour_pause",
                "heure_depart",
                "observation",
              ],
            },
          },
        },
        required: ["date", "lignes"],
      },
    },
  },
  required: ["pages"],
};

function promptPointage() {
  const noms = listerEmployes().map((e) => e.nom_fiche || e.nom_complet);

  return `Transcris cette fiche de presence manuscrite d'ALPHA MOTORS.

UN FICHIER PEUT CONTENIR PLUSIEURS JOURNEES, dans n'importe quel ordre.
Chaque page porte sa propre date en haut ("DATE : __/__/____"). Traite chaque
page separement et reporte sa date au format AAAA-MM-JJ.

Colonnes du tableau, dans l'ordre :
NOM ET PRENOMS, HEURE D'ARRIVEE, SIGNATURE, HDP, SIGNATURE, HRP, SIGNATURE,
HEURE DE DEPART, SIGNATURE, OBSERVATION.
HDP est l'heure de depart en pause, HRP l'heure de retour de pause.
Ignore completement les colonnes SIGNATURE : elles ne contiennent que des
paraphes, jamais une heure.

Les noms preimprimes sont pris dans cette liste :
${noms.map((n) => `- ${n}`).join("\n")}
Reproduis chaque nom EXACTEMENT comme dans cette liste. Si une ligne porte un
nom manuscrit absent de la liste, recopie-le tel qu'il est ecrit.

Regles de transcription :
- Recopie les heures telles qu'elles sont ecrites (08h33, 8h18, 14:15, 07H58).
- Une case vide devient une chaine vide "". N'invente jamais une heure, ne
  deduis jamais une heure manquante a partir d'une autre.
- Si une valeur est raturee ou surchargee, retiens la valeur finale.
- Si un chiffre est douteux, transcris ta meilleure lecture : un autre
  controle comparera deux lectures independantes.
- Reporte TOUTES les lignes du tableau, y compris celles entierement vides.`;
}


async function lirePointageUnePasse(chemin, ai) {
  const donnees = await genererJson({
    contents: [{ role: "user", parts: [{ text: promptPointage() }, partieFichier(chemin)] }],
    schema: SCHEMA_POINTAGE,
    config: { temperature: TEMPERATURE_EXTRACTION },
  }, { ai });

  const parJour = new Map();

  for (const page of donnees.pages || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(page.date || "")) {
      continue;
    }

    const lignes = parJour.get(page.date) || new Map();

    for (const ligne of page.lignes || []) {
      if (!ligne.nom || !ligne.nom.trim()) {
        continue;
      }

      lignes.set(cleNom(ligne.nom), {
        nom: ligne.nom.trim(),
        heure_arrivee: normaliserHeure(ligne.heure_arrivee),
        heure_depart_pause: normaliserHeure(ligne.heure_depart_pause),
        heure_retour_pause: normaliserHeure(ligne.heure_retour_pause),
        heure_depart: normaliserHeure(ligne.heure_depart),
        observation: (ligne.observation || "").trim() || null,
      });
    }

    parJour.set(page.date, lignes);
  }

  return parJour;
}


// Premiere lecture : moteur OCR dedie de Mistral. Ramenee exactement a la
// meme forme que la lecture Gemini, pour que la confrontation ignore d'ou
// vient chaque version.
async function lirePointageMistral(chemin) {
  const pages = await lireOcrMistral(chemin);
  const parJour = new Map();

  for (const page of pages) {
    const lignes = parJour.get(page.date) || new Map();

    for (const ligne of page.lignes) {
      lignes.set(cleNom(ligne.nom), {
        nom: ligne.nom.trim(),
        heure_arrivee: normaliserHeure(ligne.heure_arrivee),
        heure_depart_pause: normaliserHeure(ligne.heure_depart_pause),
        heure_retour_pause: normaliserHeure(ligne.heure_retour_pause),
        heure_depart: normaliserHeure(ligne.heure_depart),
        observation: (ligne.observation || "").trim() || null,
      });
    }

    parJour.set(page.date, lignes);
  }

  return parJour;
}


// Confronte deux lectures. Ce sur quoi elles s'accordent est retenu ; tout
// desaccord part en revue plutot que d'entrer dans les chiffres.
function confronter(passeA, passeB) {
  const retenus = [];
  const divergences = [];
  const dates = new Set([...passeA.keys(), ...passeB.keys()]);

  for (const date of dates) {
    const a = passeA.get(date) || new Map();
    const b = passeB.get(date) || new Map();

    if (!passeA.has(date) || !passeB.has(date)) {
      divergences.push({
        date,
        nom_brut: null,
        motif: `journee vue par une seule des deux lectures`,
        passe_1: passeA.has(date) ? "presente" : "absente",
        passe_2: passeB.has(date) ? "presente" : "absente",
      });
      continue;
    }

    for (const cle of new Set([...a.keys(), ...b.keys()])) {
      const la = a.get(cle);
      const lb = b.get(cle);

      if (!la || !lb) {
        divergences.push({
          date,
          nom_brut: (la || lb).nom,
          motif: "ligne vue par une seule des deux lectures",
          passe_1: la ? JSON.stringify(la) : "absente",
          passe_2: lb ? JSON.stringify(lb) : "absente",
        });
        continue;
      }

      const ecarts = CHAMPS_HORAIRES.filter((champ) => la[champ] !== lb[champ]);

      if (ecarts.length) {
        divergences.push({
          date,
          nom_brut: la.nom,
          motif: `lectures divergentes sur : ${ecarts.join(", ")}`,
          passe_1: JSON.stringify(ecarts.map((c) => `${c}=${la[c]}`)),
          passe_2: JSON.stringify(ecarts.map((c) => `${c}=${lb[c]}`)),
        });

        // On garde ce sur quoi les deux lectures s accordent et on ne vide
        // que le champ conteste. Jeter la ligne entiere ferait disparaitre
        // une arrivee pourtant certaine, et la personne serait portee
        // absente alors qu elle etait bien la.
        const partiel = { ...la, champs_incertains: ecarts };

        for (const champ of ecarts) {
          partiel[champ] = null;
        }

        retenus.push({ date, ...partiel });
        continue;
      }

      retenus.push({ date, ...la, champs_incertains: [] });
    }
  }

  return { retenus, divergences };
}


async function extrairePointage(chemin, options = {}) {
  const documentId = options.documentId || null;

  // Deux MOTEURS differents, pas deux passes du meme modele : deux lectures
  // d'un meme modele partagent les memes angles morts et se trompent
  // ensemble. Sur la fiche du 15/09, Gemini a lu deux fois 08h02 puis 08h09
  // la ou il fallait lire 08h22 ; Mistral lit 08h22. Un desaccord entre
  // moteurs signale precisement les cellules reellement ambigues.
  const [passeA, passeB] = await Promise.all([
    lirePointageMistral(chemin),
    lirePointageUnePasse(chemin, clientExtraction()),
  ]);

  const { retenus, divergences } = confronter(passeA, passeB);

  let enregistres = 0;
  let vides = 0;
  const enRevue = [...divergences];

  for (const ligne of retenus) {
    const resolution = resoudreEmploye(ligne.nom);

    if (!resolution.employe) {
      enRevue.push({
        date: ligne.date,
        nom_brut: ligne.nom,
        motif: `nom non rattache a un employe (${resolution.methode})`,
        passe_1: JSON.stringify(ligne),
        passe_2: null,
      });
      continue;
    }

    const aDesHeures = CHAMPS_HORAIRES.some((champ) => ligne[champ]);

    // Une ligne entierement vide est une information en soi (la personne
    // n'a pas signe), mais elle n'a rien a stocker : le moteur de regles
    // deduira ABSENT, A DISTANCE ou ABSENCE AUTORISEE de son cote.
    if (!aDesHeures && !ligne.observation) {
      vides++;
      continue;
    }

    enregistrerPointage({
      employee_id: resolution.employe.id,
      date: ligne.date,
      heure_arrivee: ligne.heure_arrivee,
      heure_depart: ligne.heure_depart,
      heure_depart_pause: ligne.heure_depart_pause,
      heure_retour_pause: ligne.heure_retour_pause,
      observation: ligne.observation,
      source_document_id: documentId,
      certitude: ligne.champs_incertains?.length ? "A_VERIFIER" : "CONFIRMEE",
      champs_incertains: ligne.champs_incertains,
    });

    enregistres++;
  }

  for (const divergence of enRevue) {
    signalerPourRevue({ ...divergence, source_document_id: documentId });
  }

  return {
    dates: [...new Set(retenus.map((l) => l.date))].sort(),
    enregistres,
    vides,
    en_revue: enRevue.length,
    divergences: enRevue,
  };
}


// ---------------------------------------------------------------------------
// Planning hebdomadaire de l'equipe du soir
// ---------------------------------------------------------------------------

const SCHEMA_PLANNING = {
  type: "object",
  properties: {
    periode_debut: { type: "string" },
    periode_fin: { type: "string" },
    jours: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          personnes: { type: "array", items: { type: "string" } },
        },
        required: ["date", "personnes"],
      },
    },
  },
  required: ["jours"],
};

const PROMPT_PLANNING = `Transcris ce planning hebdomadaire de l'equipe du soir
d'ALPHA MOTORS.

Le tableau associe a chaque jour la liste des personnes de permanence, avec la
date correspondante. Reporte chaque date au format AAAA-MM-JJ.

Les noms sont souvent ecrits en abrege ou au prenom seul (WILLIAM, MARIE S.,
MARIAH J.). Recopie-les EXACTEMENT comme ils figurent sur le document, sans
tenter de les completer : le rapprochement avec le registre du personnel est
fait ensuite.

Le separateur entre les personnes est generalement "&". Une case vide donne
une liste vide.`;


async function extrairePlanning(chemin, options = {}) {
  const documentId = options.documentId || null;

  const donnees = await genererJson({
    contents: [{ role: "user", parts: [{ text: PROMPT_PLANNING }, partieFichier(chemin)] }],
    schema: SCHEMA_PLANNING,
    config: { temperature: 0 },
  }, { ai: clientExtraction() });

  let enregistres = 0;
  const enRevue = [];

  for (const jour of donnees.jours || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(jour.date || "")) {
      continue;
    }

    for (const nom of jour.personnes || []) {
      const resolution = resoudreEmploye(nom);

      if (!resolution.employe) {
        enRevue.push({
          date: jour.date,
          nom_brut: nom,
          motif: `planning : nom non rattache (${resolution.methode})`,
        });
        continue;
      }

      enregistrerPosteDeSoir(resolution.employe.id, jour.date, documentId);
      enregistres++;
    }
  }

  for (const divergence of enRevue) {
    signalerPourRevue({ ...divergence, source_document_id: documentId });
  }

  return {
    periode: [donnees.periode_debut || null, donnees.periode_fin || null],
    jours: (donnees.jours || []).length,
    enregistres,
    en_revue: enRevue.length,
    divergences: enRevue,
  };
}


// ---------------------------------------------------------------------------
// Classement d'un document entrant
// ---------------------------------------------------------------------------

const SCHEMA_CLASSEMENT = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["POINTAGE", "PLANNING", "RAPPORT", "AUTRE"] },
    justification: { type: "string" },
  },
  required: ["type", "justification"],
};

const PROMPT_CLASSEMENT = `Classe ce document dans une seule categorie.

POINTAGE : fiche de presence, tableau de noms avec heures d'arrivee et de
depart, souvent manuscrite et signee.
PLANNING : planning de permanence ou d'equipe du soir, associant des jours a
des personnes de garde.
RAPPORT : compte rendu d'activite redige par un service.
AUTRE : tout le reste (facture, courrier, photo sans rapport).

Reponds par la categorie et une justification d'une phrase.`;


async function classerDocument(chemin) {
  return genererJson({
    contents: [{ role: "user", parts: [{ text: PROMPT_CLASSEMENT }, partieFichier(chemin)] }],
    schema: SCHEMA_CLASSEMENT,
    config: { temperature: 0 },
  }, { ai: clientExtraction() });
}

module.exports = {
  extrairePointage,
  extrairePlanning,
  classerDocument,
  confronter,
  lirePointageUnePasse,
  lirePointageMistral,
};
