const fs = require("fs");
const path = require("path");

const { genererJson, generer, partieFichier } = require("./ia");
const { prepareDailyBatch } = require("./batch");
const { faitsDePonctualite } = require("./presence");
const { localToday, allocateReportNumber } = require("./database");
const { ecrire } = require("./docx-rapport");
const { extractWord } = require("./extractors");
const { ocr } = require("./mistral");

// ---------------------------------------------------------------------------
// Rapport consolide, en JSON puis en Word
//
// Le modele ne produit pas un document : il produit les DONNEES du document.
// La mise en page, le numero d'ordre, la ville et la signature sont poses par
// le programme, et les chiffres viennent du calcul, jamais du modele.
//
// Un validateur deterministe controle ENSUITE chaque champ que le rendu
// consomme. Le mode strict des schemas n'est pas toujours honore : sans ce
// controle, un champ manquant ressort en "undefined" dans le document final.
// ---------------------------------------------------------------------------

const VILLE = process.env.RAPPORT_VILLE || "Yaoundé";
const SIGNATURE =
  process.env.RAPPORT_SIGNATURE || "LA DIRECTION DES RESSOURCES HUMAINES";
const SIGLE = process.env.RAPPORT_SIGLE || "AM";
const REFERENCE_QUOTIDIEN = process.env.RAPPORT_REFERENCE || "DRH / ADRH";
const REFERENCE_HEBDO = process.env.RAPPORT_REFERENCE_HEBDO || "DRH / DG";

const MOIS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

const JOURS = [
  "dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi",
];

function enFrancais(iso, avecJour = false) {
  const [annee, mois, jour] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(annee, mois - 1, jour));
  const quantieme = jour === 1 ? "1er" : String(jour);
  const base = `${quantieme} ${MOIS[mois - 1]} ${annee}`;

  return avecJour ? `${JOURS[d.getUTCDay()]} ${base}` : base;
}

function veille(iso, jours) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - jours);

  return d.toISOString().slice(0, 10);
}


const SCHEMA_QUOTIDIEN = {
  type: "object",
  properties: {
    intro: { type: "string" },
    synthese: {
      type: "array",
      items: {
        type: "object",
        properties: {
          libelle: { type: "string" },
          valeur: { type: "string" },
          lecture: { type: "string" },
        },
        required: ["libelle", "valeur", "lecture"],
      },
    },
    ponctualite: { type: "string" },
    services: {
      type: "array",
      items: {
        type: "object",
        properties: {
          nom: { type: "string" },
          lignes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                libelle: { type: "string" },
                description: { type: "string" },
                suite: { type: "string" },
              },
              required: ["libelle", "description", "suite"],
            },
          },
        },
        required: ["nom", "lignes"],
      },
    },
    points_attention: {
      type: "array",
      items: {
        type: "object",
        properties: {
          priorite: { type: "string", enum: ["HAUTE", "MOYENNE", "BASSE"] },
          intitule: { type: "string" },
          constat: { type: "string" },
        },
        required: ["priorite", "intitule", "constat"],
      },
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: { service: { type: "string" }, action: { type: "string" } },
        required: ["service", "action"],
      },
    },
    conclusion: { type: "array", items: { type: "string" } },
    donnees_manquantes: { type: "array", items: { type: "string" } },
  },
  required: [
    "intro", "synthese", "ponctualite", "services",
    "points_attention", "actions", "conclusion", "donnees_manquantes",
  ],
};


function consigneQuotidien(date) {
  return `Tu prepares le contenu du rapport journalier consolide des activites
d'ALPHA MOTORS Cameroun, etabli par la Direction des Ressources Humaines a
l'attention de la Direction Generale.

Tu ne produis PAS un document : tu produis les DONNEES du document, en JSON.
L'en-tete, le numero d'ordre, la ville, la mise en page et la signature sont
poses ensuite par le programme. Ne les reprends pas.

Journee couverte : ${enFrancais(date, true)}.

REGLE D'IDENTIFICATION
N'utilise JAMAIS l'expediteur pour attribuer une activite : un collaborateur
transmet frequemment le compte rendu d'un autre service, et aucune information
sur l'expediteur ne t'est fournie. Le service concerne et les personnes citees
se deduisent du seul contenu des messages et des pieces jointes.

REGLE DE DATE
Les services transmettent leur compte rendu entre 17h le jour concerne et 16h
le lendemain : un compte rendu recu le matin porte presque toujours sur la
VEILLE. L'heure d'arrivee d'un message n'indique jamais la journee qu'il
couvre ; fie-toi a la date annoncee dans le compte rendu lui-meme. Un compte
rendu portant manifestement sur une autre journee ne doit pas etre compte :
signale-le dans donnees_manquantes.

CHAMPS
intro : une phrase citant uniquement les services ayant reellement transmis.
synthese : un element par indicateur CHIFFRE reellement present. valeur porte
  le chiffre, lecture une courte explication. Calcule les taux de conversion
  quand les elements le permettent : la reference est rendez-vous fixes
  divises par appels emis.
ponctualite : une a trois phrases, en texte suivi. Les donnees de ponctualite
  te sont fournies DEJA CALCULEES : reprends-les telles quelles, n'en deduis
  aucune autre et n'ajoute aucun nom absent. Les noms te sont donnes avec leur
  civilite lorsqu'elle est connue : reprends-les EXACTEMENT, n'en ajoute
  jamais, n'en retire jamais et n'en invente jamais.
  Si la fiche de presence n'a pas ete recue, ecris exactement :
  Fiche de presence non recue pour cette journee.
  Si rien n'est a signaler, ecris : Aucun retard ni absence a signaler.
  Ne cite ni les personnes en regle, ni celles en teletravail, ni les oublis
  de signature.
services : un element par service ayant transmis, dans cet ordre lorsqu'ils
  sont presents : Direction Commerciale & Call Center, Service Informatique,
  Service Apres-Vente, puis les autres. N'ouvre une section QUE pour un
  service dont le compte rendu porte sur la journee couverte et decrit des
  activites precises. Un compte rendu portant sur une autre journee, ou un
  document qui n'est pas un compte rendu d'activite, ne donne AUCUNE section :
  il figure uniquement dans donnees_manquantes. Une section faite de
  generalites ("le service a poursuivi ses activites") est une invention :
  supprime-la. Pour un service d'activites, chaque
  ligne porte un libelle EN MAJUSCULES, une description factuelle, et suite
  vide. Pour le Service Apres-Vente, libelle est le nom du client et suite
  l'action attendue.
points_attention : priorite HAUTE, MOYENNE ou BASSE.
actions : une entree par service concerne.
conclusion : deux ou trois paragraphes. Volume d'activite, ce qui a ete
  concretise ou non, ce qui reste en suspens.
donnees_manquantes : un element par service attendu dont le compte rendu n'est
  pas arrive, et un element par compte rendu portant sur une autre journee.
  Liste vide si tout est la.

REGLES DE FOND
- N'invente jamais un chiffre, un nom, un dossier ni une activite.
- Ne recopie jamais les intitules techniques des donnees fournies : tu
  rediges un document, pas un export.
- Si les donnees recues ne sont manifestement pas des comptes rendus
  d'activite, dis-le dans donnees_manquantes plutot que d'inventer.
- Francais administratif sobre, a la troisieme personne, correctement
  accentue.`;
}


// Le validateur couvre TOUT ce que le rendu consomme. Un champ non verifie
// ressort en "undefined" dans le document final.
// Un nom peut etre ecrit "Mme ETOUNA MARIE SHARONE" d'un cote et
// "Mme MARIE SHARONE ETOUNA" de l'autre : on exige que tous les mots du nom
// soient presents, sans imposer leur ordre.
function nomPresent(nom, texte) {
  const mots = (nom || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\b(MME|MLLE|M|MR|DR)\.?\b/g, " ")
    .split(/[^A-Z0-9]+/)
    .filter((mot) => mot.length > 1);

  if (!mots.length) {
    return true;
  }

  const corps = (texte || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();

  return mots.every((mot) => corps.includes(mot));
}


const CIVILITES = /^(MME|MLLE|MR|M|DR)$/;

function motsDuNom(nom) {
  return (nom || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

// Le registre ne connait pas la civilite de tout le monde. Quand elle manque,
// le modele en met une d'autorite, et se trompe une fois sur deux : un
// document adresse a la Direction Generale ne peut pas appeler quelqu'un
// "M." au hasard. On ne compare donc pas les civilites, on verifie qu'aucune
// n'est apparue devant un nom qui n'en portait pas.
function civilitesInventees(attendus, texte) {
  const sansCivilite = new Set();
  const avecCivilite = new Set();

  for (const personne of attendus) {
    const mots = motsDuNom(personne.nom);

    if (!mots.length) {
      continue;
    }

    const porteUneCivilite = CIVILITES.test(mots[0]);
    const propres = porteUneCivilite ? mots.slice(1) : mots;

    for (const mot of propres) {
      (porteUneCivilite ? avecCivilite : sansCivilite).add(mot);
    }
  }

  const nu = (texte || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();

  const fautives = new Set();

  for (const trouve of nu.matchAll(/\b(MME|MLLE|MR|M|DR)\.?\s+([A-Z][A-Z0-9'-]*)/g)) {
    const suivant = trouve[2];

    if (sansCivilite.has(suivant) && !avecCivilite.has(suivant)) {
      fautives.add(`${trouve[1]}. ${suivant}`);
    }
  }

  return [...fautives];
}


function valider(d, type, ponctualite = null) {
  const erreurs = [];
  const vide = (v) => !String(v || "").trim();

  if (vide(d.intro)) erreurs.push("intro vide");
  if (!(d.conclusion || []).length) erreurs.push("conclusion vide");

  for (const p of d.points_attention || []) {
    if (!["HAUTE", "MOYENNE", "BASSE"].includes(p.priorite)) {
      erreurs.push(`priorite invalide : ${p.priorite}`);
    }
    if (vide(p.intitule)) erreurs.push("point d'attention sans intitule");
    if (vide(p.constat)) erreurs.push("point d'attention sans constat");
  }

  if (type === "HEBDOMADAIRE") {
    if (!(d.axes || []).length) erreurs.push("aucun axe");
    for (const a of d.axes || []) {
      if (vide(a.axe) || vide(a.constat)) erreurs.push("axe incomplet");
    }
    return erreurs;
  }

  if (vide(d.ponctualite)) erreurs.push("ponctualite vide");

  // Le modele resume parfois une longue liste de noms au lieu de la reprendre :
  // une personne absente du rapport passe alors inapercue. Les retards et
  // absences non justifies sont calcules, donc verifiables un a un.
  if (ponctualite && !vide(d.ponctualite)) {
    const attendus = [
      ...(ponctualite.retards || []).filter((r) => !r.justifie),
      ...(ponctualite.absences_non_justifiees || []),
    ];

    const oublies = attendus
      .map((personne) => personne.nom)
      .filter((nom) => nom && !nomPresent(nom, d.ponctualite));

    if (oublies.length) {
      erreurs.push(`ponctualite : nom(s) omis - ${oublies.join(", ")}`);
    }

    const inventees = civilitesInventees(attendus, d.ponctualite);

    if (inventees.length) {
      erreurs.push(`ponctualite : civilite inventee pour ${inventees.join(", ")}`);
    }
  }

  for (const s of d.synthese || []) {
    if (vide(s.libelle)) erreurs.push("indicateur sans libelle");
    if (vide(s.valeur)) erreurs.push(`indicateur sans valeur : ${s.libelle}`);
  }

  for (const s of d.services || []) {
    if (vide(s.nom)) erreurs.push("service sans nom");
    for (const l of s.lignes || []) {
      if (vide(l.libelle)) erreurs.push(`ligne sans libelle dans ${s.nom}`);
      if (vide(l.description)) erreurs.push(`ligne sans description dans ${s.nom}`);
    }
  }

  for (const a of d.actions || []) {
    if (vide(a.service) || vide(a.action)) erreurs.push("action incomplete");
  }

  // Un rapport qui releve des points d attention sans rien demander a
  // personne ne sert a rien : la Direction Generale attend des suites.
  if ((d.points_attention || []).length && !(d.actions || []).length) {
    erreurs.push("des points d attention sont releves mais aucune action n est proposee");
  }

  // Le JSON recopie se cherche dans les textes REDIGES, pas dans la
  // structure : stringifier l'objet entier trouve forcement des accolades.
  const redige = [
    d.intro, d.ponctualite, ...(d.conclusion || []),
    ...(d.services || []).flatMap((s) => (s.lignes || []).map((l) => l.description)),
  ].join(" ");

  if (/\{"|\[\{|"[a-z_]+"\s*:/.test(redige)) erreurs.push("JSON technique recopie");

  return erreurs;
}


async function produireJson(consigne, schema, type, corrections = null) {
  const messages = [{ role: "user", content: consigne }];

  if (corrections) {
    messages.push(
      { role: "assistant", content: JSON.stringify(corrections.precedent) },
      {
        role: "user",
        content:
          `Le document precedent comporte ces defauts :\n- ${corrections.erreurs.join("\n- ")}\n\n` +
          `Corrige UNIQUEMENT ces points et renvoie le JSON complet.`,
      }
    );
  }

  const { donnees, usage, modele } = await genererJson({
    tache: "RAPPORT",
    messages,
    schema,
    temperature: 0.2,
  });

  return { donnees, usage, modele };
}


// ---------------------------------------------------------------------------
// Pieces jointes
//
// Beaucoup de comptes rendus arrivent en photo ou en PDF : sans cette etape,
// le rapport ne verrait que la legende du message.
//
// Le modele qui redige le rapport est un modele de texte : on ne lui envoie
// pas les fichiers. Chaque piece est d'abord LUE par le modele de vision, qui
// n'en rend que le texte. C'est aussi moins cher, l'image n'etant transmise
// qu'une seule fois au lieu d'accompagner chaque reprise.
// ---------------------------------------------------------------------------

const MAX_PIECES = Number(process.env.RAPPORT_MAX_PIECES || 20);
const MAX_OCTETS_PIECE = Number(process.env.RAPPORT_MAX_OCTETS_PIECE || 15 * 1024 * 1024);

const CONSIGNE_LECTURE =
  `Transcris fidelement le contenu de ce document en texte brut.\n` +
  `Restitue les noms, les heures, les montants et les immatriculations tels\n` +
  `qu'ils sont ecrits. N'ajoute aucun commentaire, aucune interpretation et\n` +
  `aucune conclusion. Si une mention est illisible, ecris [illisible] plutot\n` +
  `que de la deviner.`;

async function lirePiece(chemin, nom) {
  const ext = path.extname(chemin || "").toLowerCase();

  // Word est lu par le programme : ni appel, ni cout, ni risque d'invention.
  if (ext === ".docx") {
    return { texte: await extractWord(chemin), usage: {} };
  }

  // Mistral OCR d'abord : c'est un moteur de reconnaissance dedie, il coute
  // bien moins cher que le modele de vision et il ne depend pas du lecteur de
  // PDF d'OpenRouter, qui se met en limitation de debit sans prevenir et fait
  // alors disparaitre un compte rendu du rapport.
  try {
    const pages = await ocr(chemin);

    const texte = pages
      .map((page) => (page.markdown || "").trim())
      .filter(Boolean)
      .join("\n\n");

    if (texte) {
      return { texte, usage: {}, moteur: "ocr" };
    }
  } catch (erreur) {
    console.warn(
      `[rapport] OCR indisponible pour ${nom} (${erreur.message}). ` +
      `Lecture par le modele de vision.`
    );
  }

  const partie = partieFichier(chemin);

  if (!partie) {
    return null;
  }

  const { texte, usage } = await generer({
    tache: "VISION",
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: CONSIGNE_LECTURE },
          { type: "text", text: `\nDOCUMENT : ${nom}` },
          partie,
        ],
      },
    ],
  });

  return { texte, usage, moteur: "vision" };
}

async function lirePiecesJointes(batch) {
  const lues = [];
  const ignorees = [];
  const usages = [];

  for (const message of batch.messages) {
    for (const piece of message.attachments) {
      const nom = piece.name || path.basename(piece.path || "");

      if (!piece.path || !fs.existsSync(piece.path)) {
        ignorees.push(`${nom} (fichier absent du disque)`);
        continue;
      }

      if (lues.length >= MAX_PIECES) {
        ignorees.push(`${nom} (au-dela de ${MAX_PIECES} pieces jointes)`);
        continue;
      }

      if (fs.statSync(piece.path).size > MAX_OCTETS_PIECE) {
        ignorees.push(`${nom} (trop volumineux)`);
        continue;
      }

      try {
        const lecture = await lirePiece(piece.path, nom);

        if (!lecture || !(lecture.texte || "").trim()) {
          ignorees.push(`${nom} (format ${path.extname(nom) || "inconnu"} non lisible)`);
          continue;
        }

        lues.push({
          nom,
          heure: message.timestamp,
          texte: lecture.texte.trim(),
          moteur: lecture.moteur || "?",
        });
        usages.push(lecture.usage || {});
      } catch (erreur) {
        // Une piece illisible ne doit pas emporter le rapport entier : on la
        // signale et le document sort sans elle.
        console.error(`[rapport] lecture de ${nom} impossible :`, erreur.message);
        ignorees.push(`${nom} (lecture impossible)`);
      }
    }
  }

  const cout = usages.reduce((total, u) => total + Number(u.cost || 0), 0);

  if (lues.length || ignorees.length) {
    console.log(
      `[rapport] pieces jointes : ${lues.length} lue(s), ` +
      `${ignorees.length} ignoree(s), $${cout.toFixed(6)}`
    );

    // Le detail, et pas seulement le compte : un service declare muet alors
    // que son fichier etait bien la doit se retrouver ici.
    for (const lue of lues) {
      console.log(
        `[rapport]   lue     : ${lue.nom} ` +
        `(${lue.moteur}, ${lue.texte.length} caracteres)`
      );
    }

    for (const ignoree of ignorees) {
      console.warn(`[rapport]   ignoree : ${ignoree}`);
    }
  }

  return { lues, ignorees, cout };
}


async function construireQuotidien(date) {
  const batch = prepareDailyBatch(date);
  const ponctualite = faitsDePonctualite(date);

  if (batch.total_messages === 0 && !ponctualite.fiche_recue) {
    return { statut: "vide", date };
  }

  const pieces = await lirePiecesJointes(batch);

  const contexte =
    `${consigneQuotidien(date)}\n\n` +
    `PONCTUALITE (calculee, a reprendre telle quelle) :\n` +
    `${JSON.stringify(ponctualite)}\n\n` +
    `COMPTES RENDUS RECUS :\n` +
    `${JSON.stringify(batch.messages.map((m) => ({ heure: m.timestamp, texte: m.text })))}` +
    (pieces.lues.length
      ? `\n\nPIECES JOINTES (transcrites) :\n${JSON.stringify(pieces.lues)}`
      : "");

  let { donnees, usage, modele } = await produireJson(contexte, SCHEMA_QUOTIDIEN, "QUOTIDIEN");
  let erreurs = valider(donnees, "QUOTIDIEN", ponctualite);

  // Une seule reprise : si le modele ne corrige pas ce qu'on lui montre
  // precisement, insister ne servira pas davantage.
  if (erreurs.length) {
    console.warn(`[rapport] validation echouee : ${erreurs.join(", ")}. Reprise.`);

    const reprise = await produireJson(contexte, SCHEMA_QUOTIDIEN, "QUOTIDIEN", {
      precedent: donnees,
      erreurs,
    });

    donnees = reprise.donnees;
    usage = reprise.usage;
    modele = reprise.modele;
    erreurs = valider(donnees, "QUOTIDIEN", ponctualite);
  }

  const numero = allocateReportNumber(date);

  // Une piece que le programme n'a pas su lire doit figurer DANS le document,
  // pas seulement dans le message qui l'accompagne : sinon le rapport affirme
  // qu'un service n'a rien transmis alors que son fichier etait bien la, et
  // rien dans le document ne permet de s'en apercevoir.
  const manquantes = [
    ...(donnees.donnees_manquantes || []),
    ...pieces.ignorees.map(
      (piece) => `Piece jointe non lue par le programme : ${piece}`
    ),
  ];

  return {
    statut: erreurs.length ? "defauts" : "ok",
    erreurs,
    pieces_ignorees: pieces.ignorees,
    cout_pieces: pieces.cout,
    usage,
    modele,
    date,
    document: {
      type: "QUOTIDIEN",
      numero: `N° ${String(numero).padStart(3, "0")} / ${SIGLE} / ${REFERENCE_QUOTIDIEN}`,
      ville: VILLE,
      date_redaction: enFrancais(localToday()),
      titre_date: enFrancais(date).toUpperCase(),
      signature: SIGNATURE,
      ...donnees,
      donnees_manquantes: manquantes,
    },
  };
}


function nomFichier(document, date) {
  const suffixe = date.replace(/-/g, "_");

  return document.type === "HEBDOMADAIRE"
    ? `Rapport_Hebdomadaire_Alpha_Motors_${suffixe}.docx`
    : `Rapport_Consolide_Alpha_Motors_${suffixe}.docx`;
}


async function produireQuotidien(date, dossier = ".") {
  const resultat = await construireQuotidien(date);

  if (resultat.statut === "vide") {
    return resultat;
  }

  const chemin = `${dossier}/${nomFichier(resultat.document, date)}`;
  ecrire(resultat.document, chemin);

  return { ...resultat, chemin };
}

module.exports = {
  lirePiece,
  lirePiecesJointes,
  construireQuotidien,
  produireQuotidien,
  valider,
  enFrancais,
  veille,
  SCHEMA_QUOTIDIEN,
};
