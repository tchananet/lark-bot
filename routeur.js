const fs = require("fs");
const path = require("path");

const { genererJson } = require("./gemini");
const { localToday } = require("./database");

// ---------------------------------------------------------------------------
// Routage par intention
//
// Pas de commandes a retenir : la DRH ecrit en francais et le bot decide de
// ce qu'il doit faire. Les documents sont classes d'apres leur contenu, pas
// d'apres leur nom de fichier.
// ---------------------------------------------------------------------------

const MIME = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const INTENTIONS = [
  "POINTAGE",
  "PLANNING",
  "RAPPORT",
  "PERMISSION",
  "DEMANDE_RAPPORT",
  "AUTRE",
];

const SCHEMA = {
  type: "object",
  properties: {
    intention: { type: "string", enum: INTENTIONS },
    certitude: { type: "string", enum: ["HAUTE", "MOYENNE", "BASSE"] },
    explication: { type: "string" },
    absences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          personne: { type: "string" },
          type: {
            type: "string",
            enum: ["PERMISSION", "CONGE", "MISSION", "MALADIE", "FORMATION"],
          },
          date_debut: { type: "string" },
          date_fin: { type: "string" },
          motif: { type: "string" },
        },
        required: ["personne", "type", "date_debut", "date_fin", "motif"],
      },
    },
    rapport_date: { type: "string" },
  },
  required: ["intention", "certitude", "explication", "absences", "rapport_date"],
};


function prompt(aujourdhui, aDesPiecesJointes) {
  return `Tu orientes les messages recus par l'assistant RH d'ALPHA MOTORS.
Determine ce que l'expediteur attend, puis renseigne les champs utiles.

Date du jour : ${aujourdhui}.
${aDesPiecesJointes ? "Le message comporte une piece jointe, fournie ci-dessous." : "Le message ne comporte aucune piece jointe."}

INTENTIONS POSSIBLES
POINTAGE : une fiche de presence, tableau de noms avec heures d'arrivee et de
  depart, le plus souvent manuscrite et signee.
PLANNING : un planning de permanence ou d'equipe du soir, associant des jours
  a des personnes de garde.
RAPPORT : un compte rendu d'activite redige par un service.
PERMISSION : le message declare qu'une ou plusieurs personnes etaient ou
  seront absentes, en permission, en conge, en mission, malades ou en
  formation. Cela couvre aussi une reponse aux questions posees par le bot.
DEMANDE_RAPPORT : le message reclame un rapport, une synthese ou un
  recapitulatif, pour une date donnee ou pour la derniere journee.
AUTRE : tout le reste, y compris les salutations et les messages sans objet.

CHAMPS A RENSEIGNER
absences : une entree par personne ET par periode citee. Le nom est recopie
  tel qu'il est ecrit, sans le completer. Les dates sont au format AAAA-MM-JJ,
  resolues par rapport a la date du jour : "hier", "ce matin", "du 14 au 18"
  doivent devenir des dates reelles. Pour une seule journee, date_debut et
  date_fin sont identiques. Le motif reprend les mots de l'expediteur ; s'il
  n'y en a pas, laisse une chaine vide.
  Laisse la liste vide pour toute intention autre que PERMISSION.
rapport_date : la journee demandee, au format AAAA-MM-JJ, uniquement pour
  DEMANDE_RAPPORT. Chaine vide si aucune date n'est precisee ou si
  l'intention est autre.

REGLES
- Ne devine pas une intention a partir du nom du fichier : lis son contenu.
- Si le message ne demande rien et n'annonce rien, reponds AUTRE.
- certitude vaut BASSE des que plusieurs lectures sont plausibles.
- explication : une phrase, en francais, disant ce que tu as compris.`;
}


function partieFichier(chemin) {
  const mimeType = MIME[path.extname(chemin || "").toLowerCase()];

  if (!mimeType || !fs.existsSync(chemin)) {
    return null;
  }

  return {
    inlineData: { mimeType, data: fs.readFileSync(chemin).toString("base64") },
  };
}


async function analyser({ texte = "", fichiers = [] } = {}) {
  const aujourdhui = localToday();

  const parts = [{ text: prompt(aujourdhui, fichiers.length > 0) }];

  if (texte.trim()) {
    parts.push({ text: `\nMESSAGE RECU :\n${texte.trim()}` });
  }

  for (const chemin of fichiers) {
    const partie = partieFichier(chemin);

    if (partie) {
      parts.push({ text: `\nPIECE JOINTE : ${path.basename(chemin)}` });
      parts.push(partie);
    }
  }

  const analyse = await genererJson({
    contents: [{ role: "user", parts }],
    schema: SCHEMA,
    config: { temperature: 0 },
  });

  return {
    intention: INTENTIONS.includes(analyse.intention) ? analyse.intention : "AUTRE",
    certitude: analyse.certitude || "BASSE",
    explication: analyse.explication || "",
    // Une absence sans personne ni date est inexploitable : on la jette
    // plutot que d'ecrire une ligne incomplete en base.
    absences: (analyse.absences || []).filter(
      (a) => a.personne && /^\d{4}-\d{2}-\d{2}$/.test(a.date_debut || "")
    ),
    rapport_date: /^\d{4}-\d{2}-\d{2}$/.test(analyse.rapport_date || "")
      ? analyse.rapport_date
      : null,
  };
}

module.exports = { analyser, INTENTIONS };
