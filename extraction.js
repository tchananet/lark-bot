const { genererJson, messageAvecPages } = require("./ia");
const { normaliserHeure } = require("./temps");
const gemini = require("./gemini");
const {
  listerEmployes,
  resoudreEmploye,
  enregistrerPointage,
  enregistrerPosteDeSoir,
  signalerPourRevue,
  cleNom,
} = require("./hr");

// Deux lectures independantes de la meme feuille manuscrite. La temperature
// n'est pas nulle : a temperature nulle les deux passes renverraient la meme
// chose, y compris la meme erreur, et la comparaison ne prouverait rien. On
// veut au contraire que l'incertitude reelle du modele se manifeste par un
// desaccord.
const TEMPERATURE_EXTRACTION = Number(process.env.RH_TEMPERATURE_EXTRACTION || 0.4);

const CHAMPS_HORAIRES = [
  "heure_arrivee",
  "heure_depart_pause",
  "heure_retour_pause",
  "heure_depart",
];


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


// Les trois moteurs rendent la meme structure de pages ; seule la mise en
// forme differe. On la fait une fois pour toutes, sinon la confrontation
// comparerait des ecritures d'heures plutot que des lectures.
function rangerParJour(donnees) {
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


// Gemini : palier gratuit, lit les PDF et les photos nativement. C'est le
// moteur principal depuis que les quotas Mistral et OpenRouter se sont
// epuises le meme jour, emportant une fiche entiere.
async function lirePointageGemini(chemin) {
  return rangerParJour(
    await gemini.lireJson(chemin, promptPointage(), SCHEMA_POINTAGE)
  );
}


// Le modele de vision passe par OpenRouter, donc par un compte payant. Il
// reste en dernier recours.
async function lirePointageUnePasse(chemin) {
  const { donnees } = await genererJson({
    tache: "VISION",
    messages: [await messageAvecPages(promptPointage(), [chemin])],
    schema: SCHEMA_POINTAGE,
    temperature: TEMPERATURE_EXTRACTION,
  });

  return rangerParJour(donnees);
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


async function lirePages(chemin) {

  // Deux MOTEURS differents, pas deux passes du meme modele : deux lectures
  // d'un meme modele partagent les memes angles morts et se trompent
  // ensemble. Sur la fiche du 15/09, Gemini a lu deux fois 08h02 puis 08h09
  // la ou il fallait lire 08h22 ; Mistral lit 08h22. Un desaccord entre
  // moteurs signale precisement les cellules reellement ambigues.
  // Trois moteurs, essayes ensemble. On en retient DEUX, qui se relisent l'un
  // l'autre : deux passes d'un meme modele partagent les memes angles morts
  // et se trompent ensemble, deux moteurs differents ne se trompent pas au
  // meme endroit.
  //
  // Promise.all rejetait des qu'un seul echouait, en jetant au passage les
  // lectures reussies. Le 23 septembre, un "Rate limit exceeded" de Mistral a
  // ainsi fait disparaitre la fiche du 21 et du 22.
  const moteurs = [
    ["Gemini", () => lirePointageGemini(chemin)],
    ["le modele de vision", () => lirePointageUnePasse(chemin)],
  ].filter(([nom]) => nom !== "Gemini" || gemini.disponible());

  const resultats = await Promise.allSettled(moteurs.map(([, lire]) => lire()));

  const reussies = [];
  const echecs = [];

  resultats.forEach((resultat, i) => {
    if (resultat.status === "fulfilled") {
      reussies.push({ nom: moteurs[i][0], pages: resultat.value });
    } else {
      echecs.push(`${moteurs[i][0]} : ${resultat.reason?.message || resultat.reason}`);
    }
  });

  if (!reussies.length) {
    throw new Error(`Aucun moteur n'a pu lire la fiche. ${echecs.join(" ; ")}`);
  }


  let moteurUnique = null;
  let retenus;
  let divergences;

  if (reussies.length >= 2) {
    ({ retenus, divergences } = confronter(reussies[0].pages, reussies[1].pages));
  } else {
    moteurUnique = reussies[0].nom;
    retenus = [...reussies[0].pages.values()].flatMap((jour) => [...jour.values()]);
    divergences = [];

    console.warn(
      `[extraction] lecture simple : seul ${moteurUnique} a repondu ` +
      `(${echecs.join(" ; ")}). Aucune confrontation.`
    );
  }

  return { retenus, divergences, moteurUnique };
}


// Ecrire ce qui a ete lu. Separe de la lecture pour qu'un envoi de plusieurs
// pages puisse etre recadre sur une seule journee avant la moindre ecriture.
function enregistrerLecture({ retenus, divergences, moteurUnique, documentId }) {
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
    moteur_unique: moteurUnique,
  };
}


async function extrairePointage(chemin, options = {}) {
  const lecture = await lirePages(chemin);

  return enregistrerLecture({
    ...lecture,
    documentId: options.documentId || null,
  });
}


// La date qui revient le plus souvent sur une page. Une fiche papier en porte
// une seule ; si les deux moteurs ont lu deux en-tetes differents, la plus
// representee est la bonne.
function dateDominante(lignes) {
  const comptes = new Map();

  for (const ligne of lignes) {
    comptes.set(ligne.date, (comptes.get(ligne.date) || 0) + 1);
  }

  let meilleure = null;
  let record = 0;

  for (const [date, compte] of comptes) {
    if (compte > record) {
      meilleure = date;
      record = compte;
    }
  }

  return meilleure;
}


// Ramener les pages d'un meme envoi sur une seule journee.
//
// La reference est la date de la premiere page qui a livre des lignes :
// c'est elle qui porte l'en-tete. Les suivantes en heritent.
function ramenerALaMemeJournee(lectures) {
  const porteuse = lectures.find((lecture) => lecture.retenus.length);
  const reference = porteuse ? dateDominante(porteuse.retenus) : null;

  const ecartees = new Set();

  if (!reference) {
    return { reference: null, ecartees: [] };
  }

  for (const lecture of lectures) {
    for (const ligne of lecture.retenus) {
      if (ligne.date !== reference) {
        ecartees.add(ligne.date);
        ligne.date = reference;
      }
    }

    for (const divergence of lecture.divergences || []) {
      if (divergence.date && divergence.date !== reference) {
        ecartees.add(divergence.date);
        divergence.date = reference;
      }
    }
  }

  return { reference, ecartees: [...ecartees] };
}


// Plusieurs images dans un seul message : une seule fiche.
//
// Une fiche de presence tient rarement sur une page. La suite ne reprend pas
// l'en-tete : le modele n'y trouve aucune date, en devine une, et la journee
// se retrouve coupee en deux -- la moitie des gens sur un jour, l'autre
// moitie sur un jour voisin, tous absents de part et d'autre.
//
// Des pages envoyees ensemble sont la meme fiche. Elles couvrent donc la
// meme journee, celle que porte la premiere page : c'est elle qui a l'en-tete.
// Les autres en heritent, et l'on dit franchement laquelle a ete retenue.
//
// Pour envoyer deux journees differentes, il faut deux messages.
async function extrairePointageLot(chemins, options = {}) {
  if (chemins.length <= 1) {
    const seul = await extrairePointage(chemins[0], options);

    return { ...seul, pages: 1, dates_ecartees: [] };
  }

  const lectures = [];

  for (const chemin of chemins) {
    lectures.push(await lirePages(chemin));
  }

  const { reference, ecartees } = ramenerALaMemeJournee(lectures);

  const resultat = enregistrerLecture({
    retenus: lectures.flatMap((lecture) => lecture.retenus),
    divergences: lectures.flatMap((lecture) => lecture.divergences),
    moteurUnique: lectures.find((lecture) => lecture.moteurUnique)?.moteurUnique || null,
    documentId: options.documentId || null,
  });

  if (ecartees.length) {
    console.log(
      `[extraction] ${chemins.length} pages d'un meme envoi ramenees au ` +
      `${reference} (dates ecartees : ${ecartees.join(", ")}).`
    );
  }

  return {
    ...resultat,
    pages: chemins.length,
    dates_ecartees: ecartees,
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

  const { donnees } = await genererJson({
    tache: "VISION",
    messages: [messageUtilisateur(PROMPT_PLANNING, [chemin])],
    schema: SCHEMA_PLANNING,
    temperature: 0,
  });

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
  const { donnees } = await genererJson({
    tache: "VISION",
    messages: [messageUtilisateur(PROMPT_CLASSEMENT, [chemin])],
    schema: SCHEMA_CLASSEMENT,
    temperature: 0,
  });

  return donnees;
}

module.exports = {
  extrairePointage,
  extrairePointageLot,
  ramenerALaMemeJournee,
  lirePages,
  enregistrerLecture,
  extrairePlanning,
  classerDocument,
  confronter,
  lirePointageUnePasse,
  lirePointageGemini,
};
