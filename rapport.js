const fs = require("fs");
const path = require("path");

const { genererJson, generer, partieFichier } = require("./ia");
const { prepareDailyBatch } = require("./batch");
const { faitsDePonctualite } = require("./presence");
const {
  localToday,
  allocateReportNumber,
  texteConnu,
  memoriserTexte,
} = require("./database");
const { ecrire } = require("./docx-rapport");
const { extractWord } = require("./extractors");
const gemini = require("./gemini");
const { lireTextePdf } = require("./texte-pdf");

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
Les pieces jointes qui te sont soumises ont DEJA ete datees par le programme :
celles qui portaient sur une autre journee ont ete retirees du dossier avant
de te parvenir, et le document le mentionnera de lui-meme. Ne te demande donc
plus si une piece concerne bien la journee couverte : elle la concerne. Ne
rejette rien pour un motif de date, et ne mentionne aucune piece absente.
Les messages ecrits directement dans la conversation, eux, ne sont pas dates :
un message recu le matin porte presque toujours sur la VEILLE.

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
  service decrivant des activites precises. Un document qui n'est pas un
  compte rendu d'activite ne donne AUCUNE section : il figure uniquement dans
  donnees_manquantes. Une section faite de generalites ("le service a
  poursuivi ses activites") est une invention : supprime-la. Pour un service
  d'activites, chaque ligne porte un libelle EN MAJUSCULES, une description
  factuelle, et suite vide. Pour le Service Apres-Vente, libelle est le nom du
  client et suite l'action attendue.
points_attention : priorite HAUTE, MOYENNE ou BASSE.
actions : une entree par service concerne.
conclusion : deux ou trois paragraphes. Volume d'activite, ce qui a ete
  concretise ou non, ce qui reste en suspens.
donnees_manquantes : un element par service attendu dont le compte rendu n'est
  pas arrive. Chaque element est une PHRASE COMPLETE, par exemple : Le compte
  rendu de la Direction Commerciale & Call Center n'est pas parvenu pour cette
  journee. Un nom de service seul ne veut rien dire pour qui lit le rapport.
  Liste vide si tout est la. Le programme y ajoute lui-meme les pieces qu'il
  n'a pas su lire et celles qui portaient sur une autre journee : ne les
  devine pas, ne les anticipe pas.

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
      if (vide(a.vigilance)) erreurs.push(`axe sans suite : ${a.axe}`);
    }

    if (!(d.indicateurs || []).length) erreurs.push("aucun indicateur");

    for (const i of d.indicateurs || []) {
      if (vide(i.date)) erreurs.push("indicateur sans date");
    }

    for (const c of d.chantiers_it || []) {
      if (vide(c.chantier) || vide(c.avancement)) erreurs.push("chantier incomplet");
    }

    for (const v of d.sav_rh || []) {
      if (vide(v.volet) || vide(v.situation)) erreurs.push("volet SAV/RH incomplet");
    }

    for (const p of d.priorites || []) {
      if (vide(p.action) || vide(p.responsable)) erreurs.push("priorite incomplete");
    }

    // Le defaut observe le 21 septembre : un tableau entierement en tirets
    // sous une synthese citant 320 appels et 207 contacts a relancer. Les
    // chiffres etaient dans les comptes rendus, le modele ne les avait pas
    // ventiles. C'est verifiable sans le relire.
    const cellules = (d.indicateurs || []).flatMap((i) => [
      i.showroom, i.proformas_ventes, i.call_center, i.relances,
    ]);

    const renseignees = cellules.filter(
      (c) => /\d/.test(String(c || ""))
    ).length;

    const chiffresAilleurs = (d.axes || [])
      .map((a) => `${a.constat} ${a.vigilance}`)
      .concat(d.conclusion || [], d.lecture || "")
      .join(" ");

    if (!renseignees && /\d/.test(chiffresAilleurs)) {
      erreurs.push(
        "tableau d'indicateurs vide alors que la synthese cite des chiffres"
      );
    }

    if (!(d.conclusion || []).length) erreurs.push("conclusion vide");

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

  // "Direction Commerciale & Call Center" tout seul, sans verbe, n'apprend
  // rien a qui lit le rapport : manquant, en retard, illisible ?
  // Compte les mots plutot que les caracteres : "Direction Commerciale & Call
  // Center" est long sans rien dire. Les entrees ajoutees ensuite par le
  // programme ne passent pas ici, elles sont fusionnees apres validation.
  for (const manque of d.donnees_manquantes || []) {
    const mots = String(manque || "").trim().split(/\s+/).filter(Boolean);

    if (mots.length < 6) {
      erreurs.push(`donnee manquante sans explication : ${manque}`);
    }
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

const OCR_ACTIF = process.env.RAPPORT_OCR !== "false";
const MAX_OCTETS_PIECE = Number(process.env.RAPPORT_MAX_OCTETS_PIECE || 15 * 1024 * 1024);

const CONSIGNE_LECTURE =
  `Transcris fidelement le contenu de ce document en texte brut.\n` +
  `Restitue les noms, les heures, les montants et les immatriculations tels\n` +
  `qu'ils sont ecrits. N'ajoute aucun commentaire, aucune interpretation et\n` +
  `aucune conclusion. Si une mention est illisible, ecris [illisible] plutot\n` +
  `que de la deviner.`;

// Trois moteurs, essayes dans l'ordre, et le resultat garde pour toujours.
//
// Le 23 septembre, Mistral et OpenRouter ont refuse en meme temps -- quota
// epuise d'un cote, plafond de cle atteint de l'autre -- et les six comptes
// rendus du lundi sont ressortis "lecture impossible" alors que les PDF
// etaient sur le disque depuis la veille. Deux parades :
//
//   un troisieme moteur, Gemini, qui lit les PDF nativement et dispose d'un
//   palier gratuit ;
//   et surtout la memoire : une lecture reussie une fois ne se refait jamais.
//   Une panne de fournisseur ne peut plus effacer une journee deja lue.
async function lirePiece(chemin, nom) {
  const ext = path.extname(chemin || "").toLowerCase();

  const connu = texteConnu(chemin);

  if (connu) {
    return { texte: connu.texte, usage: {}, moteur: `${connu.moteur}, en memoire` };
  }

  const garder = (texte, moteur) => {
    memoriserTexte({ file_path: chemin, file_name: nom, texte, moteur });

    return { texte, usage: {}, moteur };
  };

  // Word est lu par le programme : ni appel, ni cout, ni risque d'invention.
  if (ext === ".docx") {
    return garder(await extractWord(chemin), "word");
  }

  const echecs = [];

  // Un PDF exporte depuis Word porte deja son texte. Aucun modele n'est
  // necessaire, aucun quota consomme, et ce qu'on en tire est exactement ce
  // que le service a redige -- sans le risque qu'une lecture le deforme.
  // Seule la fiche de presence, vraie photo, n'a aucune couche texte.
  if (ext === ".pdf") {
    try {
      const texte = await lireTextePdf(chemin);

      if (texte) {
        return garder(texte, "pdf");
      }

      echecs.push("PDF : aucune couche texte, document scanne");
    } catch (erreur) {
      echecs.push(`PDF : ${erreur.message}`);
    }
  }

  // Gemini en premier : son palier d entree est gratuit, il lit les PDF
  // nativement, et il ne consomme ni le quota Mistral ni le plafond de la
  // cle OpenRouter. Les deux autres ne servent plus que de secours.
  if (gemini.disponible()) {
    try {
      return garder(await gemini.lire(chemin, CONSIGNE_LECTURE), "gemini");
    } catch (erreur) {
      echecs.push(`Gemini : ${erreur.message}`);
    }
  }

  const partie = partieFichier(chemin);

  if (!partie) {
    throw new Error(
      `Aucun moteur n'a pu lire ce format${echecs.length ? ` -- ${echecs.join(" ; ")}` : ""}`
    );
  }

  try {
    const { texte } = await generer({
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

    return garder(texte, "vision");
  } catch (erreur) {
    echecs.push(`Vision : ${erreur.message}`);
  }

  // Les trois moteurs muets : on dit lesquels et pourquoi, sinon la DRH lit
  // "lecture impossible" sans savoir s'il faut recharger un compte ou
  // renvoyer le fichier.
  throw new Error(echecs.join(" ; "));
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


// ---------------------------------------------------------------------------
// A quelle journee se rapporte un compte rendu
//
// Laisser le modele redacteur en juger produisait un document qui se
// contredit : il ecartait le compte rendu du Call Center en le declarant du
// 16, et en reprenait les chiffres dans la synthese. Une piece est donc datee
// AVANT d'etre soumise, et celle qui porte sur une autre journee ne lui est
// jamais montree. Ce n'est plus une consigne a respecter, c'est une piece
// absente du dossier.
// ---------------------------------------------------------------------------

const SCHEMA_JOURNEE = {
  type: "object",
  properties: {
    date: {
      type: ["string", "null"],
      description: "Journee couverte au format AAAA-MM-JJ, ou null si indeterminable",
    },
    indice: { type: "string" },
    periode: {
      type: "boolean",
      description:
        "true si le document couvre plusieurs journees (bilan hebdomadaire, " +
        "recapitulatif mensuel), false pour un compte rendu d'une seule journee",
    },
  },
  required: ["date", "indice", "periode"],
};

const MOIS_MOTIF =
  "janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre";

function sansSignes(valeur) {
  return String(valeur || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Les dates completes citees dans l'indice, au format ISO. "18 septembre
// 2026" et "18/09/2026" comptent ; "14" tout seul, dans "du 14 au 19", n'est
// pas une date complete et n'est pas compte -- c'est surPlusieursJours qui
// reconnait cette forme.
function datesDeLIndice(indice) {
  const texte = sansSignes(indice);
  const trouvees = [];

  const ajouter = (a, m, j) => {
    const iso = `${a}-${String(m).padStart(2, "0")}-${String(j).padStart(2, "0")}`;

    if (m >= 1 && m <= 12 && j >= 1 && j <= 31 && !trouvees.includes(iso)) {
      trouvees.push(iso);
    }
  };

  for (const t of texte.matchAll(
    new RegExp(`(\\d{1,2})\\s+(${MOIS_MOTIF})\\s+(\\d{4})`, "g")
  )) {
    ajouter(Number(t[3]), MOIS_MOTIF.split("|").indexOf(t[2]) + 1, Number(t[1]));
  }

  for (const t of texte.matchAll(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/g)) {
    const annee = Number(t[3]);

    ajouter(annee < 100 ? 2000 + annee : annee, Number(t[2]), Number(t[1]));
  }

  return trouvees;
}

// "du 14 au 19 septembre", "DU 14 AU 19/09/2026", "semaine du 08 au 14" :
// deux quantiemes relies par "au" suffisent, meme si une seule date complete
// figure dans la mention.
function surPlusieursJours(indice, dates) {
  const texte = sansSignes(indice);

  return (
    dates.length >= 2 ||
    /\bdu\b[\s\S]{0,60}\bau\b/.test(texte) ||
    /\d{1,2}\s*(?:au|a|-|–)\s*\d{1,2}/.test(texte)
  );
}


async function journeeDuComptRendu(piece, dateAttendue) {
  const { donnees } = await genererJson({
    tache: "ROUTAGE",
    temperature: 0,
    schema: SCHEMA_JOURNEE,
    messages: [
      {
        role: "user",
        content:
          `Voici un compte rendu d'activite transmis a ALPHA MOTORS.\n\n` +
          `Sur QUELLE JOURNEE porte-t-il ? Cherche la date annoncee dans le\n` +
          `titre, l'en-tete ou le corps du document. Le nom du fichier est un\n` +
          `indice, jamais une preuve : il est frequemment recopie de la veille.\n` +
          `Si aucune date ne ressort clairement, laisse date vide plutot que\n` +
          `de deviner. Journee du rapport en preparation : ${dateAttendue}.\n\n` +
          `Dans indice, recopie MOT POUR MOT le passage du document qui porte\n` +
          `cette date, et rien d'autre. Si tu n'as trouve aucune date, ecris\n` +
          `indice vide. Ne recopie jamais la presente consigne.\n\n` +
          `periode vaut true si le document couvre PLUSIEURS journees -- un\n` +
          `bilan hebdomadaire, un recapitulatif de la semaine, un cumul sur\n` +
          `plusieurs jours -- meme si son titre ne cite qu'une seule date.\n` +
          `false pour un compte rendu portant sur une seule journee.\n\n` +
          // L'heure d'envoi n'est volontairement pas fournie : le modele s'en
          // servait comme date du compte rendu, ce qui est precisement l'erreur
          // que cette etape doit empecher.
          `NOM DU FICHIER : ${piece.nom}\n\n` +
          `CONTENU :\n${piece.texte.slice(0, 6000)}`,
      },
    ],
  });

  // Le modele repond volontiers la CHAINE "null" plutot que rien. Sans ce
  // filtre, elle serait comparee a la date du rapport, ne correspondrait pas,
  // et ferait ecarter une piece dont on ignore simplement la date.
  const brut = String(donnees?.date || "").trim();
  const indice = donnees?.indice || "";

  // L'indice est le passage recopie du document. Il est bien plus fiable que
  // les deux autres champs, que le modele remplit de travers :
  //
  //   RAPPORT DU 18 09 26.pdf   date: null   indice: "Date : Vendredi 18
  //     septembre 2026" -- il avait trouve la date et ne l'a pas reportee ;
  //   rapport 14:09:2026.pdf    periode: true   indice: "Periode d'analyse :
  //     Lundi 14 Septembre 2026" -- le mot "periode" l'a trompe, alors que la
  //     mention ne nomme qu'un seul jour.
  //
  // On relit donc l'indice nous-memes.
  const dates = datesDeLIndice(indice);

  const periode = surPlusieursJours(indice, dates)
    ? true
    : dates.length === 1
      ? false
      : donnees?.periode === true;

  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(brut)
      ? brut
      : dates.length === 1 && !periode
        ? dates[0]
        : null,
    indice,
    periode,
  };
}

async function trierParJournee(lues, date) {
  const retenues = [];
  const autresJournees = [];

  for (const piece of lues) {
    let journee = null;

    try {
      journee = await journeeDuComptRendu(piece, date);
    } catch (erreur) {
      // Dater est un confort, pas une condition : en cas d'echec la piece
      // est soumise, comme avant.
      console.warn(`[rapport] datation de ${piece.nom} impossible : ${erreur.message}`);
    }

    // Un bilan hebdomadaire porte souvent la date du jour ou il est redige.
    // Il passait donc le controle de date et versait dans le rapport d'une
    // seule journee des chiffres cumules sur toute une semaine. Un document
    // couvrant une periode n'a rien a faire dans un rapport journalier.
    if (journee?.periode) {
      autresJournees.push({
        ...piece,
        journee: null,
        indice: journee.indice,
        motif: "couvre plusieurs journees",
      });

      console.warn(
        `[rapport]   ecartee : ${piece.nom} couvre plusieurs journees ` +
        `(${journee.indice})`
      );

      continue;
    }

    // Une date indeterminee ne fait pas ecarter : mieux vaut un compte rendu
    // de trop qu'un service declare muet a tort.
    if (!journee?.date || journee.date === date) {
      retenues.push(piece);
      continue;
    }

    autresJournees.push({
      ...piece,
      journee: journee.date,
      indice: journee.indice,
      motif: `porte sur la journee du ${enFrancais(journee.date)}`,
    });

    console.warn(
      `[rapport]   ecartee : ${piece.nom} porte sur le ${journee.date} ` +
      `(${journee.indice})`
    );
  }

  return { retenues, autresJournees };
}


// compte ventile les journees par statut interne : RETARD et ANOMALIE y sont
// distincts alors que la liste des retards reunit les deux. Le modele
// recopiait les deux chiffres et le rapport annoncait "1 en retard" au-dessus
// d'une liste de cinq noms. Il n'a pas besoin de ce decompte : les listes
// portent deja tout, et il lui est demande de ne compter lui-meme jamais.
function ponctualiteSoumise(ponctualite) {
  const { compte, ...reste } = ponctualite;

  return reste;
}


const FENETRE_SUIVANTE = process.env.RAPPORT_FENETRE_SUIVANTE !== "false";

async function piecesRetardataires(date) {
  if (!FENETRE_SUIVANTE) {
    return [];
  }

  const lendemain = veille(date, -1);
  const batch = prepareDailyBatch(lendemain);

  if (!batch.messages.some((m) => m.attachments.length)) {
    return [];
  }

  const { lues } = await lirePiecesJointes(batch);
  const rattrapees = [];

  for (const piece of lues) {
    let journee = null;

    try {
      journee = await journeeDuComptRendu(piece, date);
    } catch (erreur) {
      continue;
    }

    if (journee.date === date) {
      console.log(
        `[rapport]   rattrapee : ${piece.nom}, arrivee apres la fermeture ` +
        `de la fenetre (${journee.indice})`
      );

      rattrapees.push(piece);
    }
  }

  return rattrapees;
}


async function construireQuotidien(date) {
  const batch = prepareDailyBatch(date);
  const ponctualite = faitsDePonctualite(date);

  if (batch.total_messages === 0 && !ponctualite.fiche_recue) {
    return { statut: "vide", date };
  }

  const pieces = await lirePiecesJointes(batch);
  const tri = await trierParJournee(pieces.lues, date);

  // Un service en retard de transmission depose son compte rendu apres la
  // fermeture de la fenetre : il n'apparait alors dans AUCUN rapport, ni dans
  // celui de la journee qu'il couvre, deja publie, ni dans celui de la
  // journee ou il arrive, qui l'ecarte a juste titre. On va donc le chercher
  // dans la fenetre suivante -- mais uniquement s'il porte EXPLICITEMENT la
  // date couverte : une piece sans date n'a rien a faire ici.
  const retardataires = await piecesRetardataires(date);

  tri.retenues.push(...retardataires);

  const contexte =
    `${consigneQuotidien(date)}\n\n` +
    `PONCTUALITE (calculee, a reprendre telle quelle) :\n` +
    `${JSON.stringify(ponctualiteSoumise(ponctualite))}\n\n` +
    `COMPTES RENDUS RECUS :\n` +
    `${JSON.stringify(batch.messages.map((m) => ({ heure: m.timestamp, texte: m.text })))}` +
    (tri.retenues.length
      ? `\n\nPIECES JOINTES (transcrites) :\n${JSON.stringify(tri.retenues)}`
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
    ...tri.autresJournees.map(
      (piece) =>
        `${piece.nom} ${piece.motif} et n'est pas repris ici` +
        `${piece.indice ? ` (${piece.indice})` : ""}.`
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


// ---------------------------------------------------------------------------
// Rapport hebdomadaire
//
// La semaine n'est pas la somme des journees : la Direction Generale attend
// une lecture d'ensemble, pas sept rapports agrafes. On rassemble donc les
// comptes rendus des sept journees, puis on demande au modele de degager des
// AXES -- commercial, technique, ressources humaines -- et un tableau
// d'indicateurs jour par jour.
//
// Les chiffres de ponctualite restent calcules : le modele n'en produit
// aucun, il les met en phrases.
// ---------------------------------------------------------------------------

const SCHEMA_HEBDOMADAIRE = {
  type: "object",
  properties: {
    intro: { type: "string" },
    axes: { type: "array", items: {
      type: "object",
      properties: {
        axe: { type: "string" },
        constat: { type: "string" },
        vigilance: { type: "string" },
      },
      required: ["axe", "constat", "vigilance"],
    } },
    indicateurs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          showroom: { type: "string" },
          proformas_ventes: { type: "string" },
          call_center: { type: "string" },
          relances: { type: "string" },
        },
        required: ["date", "showroom", "proformas_ventes", "call_center", "relances"],
      },
    },
    lecture: { type: "string" },
    chantiers_it: { type: "array", items: {
      type: "object",
      properties: {
        chantier: { type: "string" },
        avancement: { type: "string" },
        suite: { type: "string" },
      },
      required: ["chantier", "avancement", "suite"],
    } },
    sav_rh: { type: "array", items: {
      type: "object",
      properties: {
        volet: { type: "string" },
        situation: { type: "string" },
        suite: { type: "string" },
      },
      required: ["volet", "situation", "suite"],
    } },
    priorites: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string" },
          responsable: { type: "string" },
        },
        required: ["action", "responsable"],
      },
    },
    conclusion: { type: "array", items: { type: "string" } },
    donnees_manquantes: { type: "array", items: { type: "string" } },
  },
  required: [
    "intro", "axes", "indicateurs", "lecture", "chantiers_it", "sav_rh",
    "priorites", "conclusion", "donnees_manquantes",
  ],
};


function consigneHebdomadaire(debut, fin) {
  return `Tu prepares le contenu du rapport HEBDOMADAIRE consolide des services
d'ALPHA MOTORS Cameroun, etabli par la Direction des Ressources Humaines a
l'attention de la Direction Generale.

Tu ne produis PAS un document : tu produis les DONNEES du document, en JSON.
L'en-tete, le numero d'ordre, la ville, la mise en page et la signature sont
poses ensuite par le programme.

Periode couverte : du ${enFrancais(debut, true)} au ${enFrancais(fin, true)}.

Ce n'est pas une juxtaposition de sept journees. La Direction Generale attend
une lecture d'ensemble : ce qui progresse, ce qui stagne, ce qui se repete.

DEUX SOURCES TE SONT FOURNIES
Les JOURNEES DE LA PERIODE portent les comptes rendus quotidiens, deja ranges
sous la journee qu'ils couvrent, et les donnees de ponctualite calculees.
Les BILANS HEBDOMADAIRES TRANSMIS PAR LES SERVICES, quand il y en a, sont les
syntheses que les services redigent eux-memes pour la semaine ecoulee. Ils
donnent la vue d'ensemble d'un service ; les journees donnent le detail date.
Croise les deux : un chiffre du bilan hebdomadaire qui se retrouve dans une
journee se range dans le tableau a cette date.

CHAMPS
intro : une phrase situant la periode et les services ayant transmis.
axes : trois a cinq lignes de synthese executive, une par grand domaine
  reellement documente -- Commercial / Showroom, Call Center, Service IT, SAV,
  RH. axe porte le domaine, constat ce qui s'est passe sur la semaine AVEC LES
  CHIFFRES DATES, vigilance le point a surveiller ou la suite attendue.
  N'ouvre pas un axe pour un domaine dont rien n'a ete transmis.
indicateurs : LE TABLEAU EST LA PREMIERE CHOSE QUE LIT LA DIRECTION GENERALE.
  Une ligne par journee documentee, dans l'ordre chronologique, date au format
  JJ/MM. Deux journees peuvent etre reunies sur une ligne, "18-19/09", quand
  leurs chiffres arrivent ensemble.
  CHAQUE CHIFFRE QUE TU CITES DANS UN AXE DOIT SE RETROUVER ICI, a sa date.
  Un tableau de tirets sous une synthese pleine de chiffres est un defaut
  grave : cela veut dire que tu as lu les comptes rendus sans les ventiler.
  showroom : visites, prospects qualifies, essais.
  proformas_ventes : au format "proformas / ventes", par exemple "1 / 0".
  call_center : appels, messages, nouveaux prospects, rendez-vous.
  relances : injoignables, nous revient, pas interesses, anomalies.
  Le tiret ne s'emploie que pour une donnee reellement absente du compte
  rendu de cette journee.
lecture : un ou deux phrases sous le tableau, disant ce que les chiffres
  racontent -- ou se situe l'ecart, quels modeles reviennent.
chantiers_it : une ligne par chantier du Service Informatique reellement
  documente. chantier le sujet, avancement ce qui a ete fait, suite l'etape
  attendue. Liste vide si le service n'a rien transmis.
sav_rh : une ligne par volet du Service Apres-Vente et des Ressources
  Humaines : dossiers clients, livraisons, digitalisation, ponctualite.
  volet le sujet, situation le consolide de la semaine, suite l'etape
  attendue. Liste vide si rien n'a ete transmis.
priorites : trois a six actions pour la semaine suivante, chacune avec son
  responsable -- Commercial, Call Center, IT, SAV, RH. Elles decoulent des
  points de vigilance des axes.
conclusion : deux a quatre paragraphes. Volume d'activite de la semaine, ce
  qui a ete concretise, ce qui reste en suspens.
donnees_manquantes : une phrase complete par journee ou par service dont le
  compte rendu n'est pas parvenu. Liste vide si tout est la.

REGLES DE FOND
- N'invente jamais un chiffre, un nom, un dossier ni une activite.
- Les donnees de ponctualite te sont fournies DEJA CALCULEES : reprends-les
  telles quelles, n'en deduis aucune autre et n'ajoute aucun nom absent.
- Ne recopie jamais les intitules techniques des donnees fournies : tu
  rediges un document, pas un export.
- Francais administratif sobre, a la troisieme personne, correctement
  accentue.
- Texte brut : ni markdown, ni asterisques, ni dieses.`;
}


// veille(iso, -1) avance d'un jour : la semaine part du lundi fourni.
function joursDeLaSemaine(debut) {
  return Array.from({ length: 7 }, (_, i) => veille(debut, -i));
}


// Les comptes rendus arrivent en retard, parfois de plusieurs jours : le
// 21 septembre au matin, le SAV a depose d'un coup ses rapports du 18 et du
// 19. Ranger chaque piece dans la journee de sa FENETRE D'ARRIVEE les aurait
// tous jetes, chacun ne correspondant pas au jour ou il tombait.
//
// Pour la semaine, on procede donc autrement que pour une journee : on lit
// tout ce qui est arrive sur la periode, on date chaque piece une fois, puis
// on la classe sous la journee qu'elle ANNONCE. Une piece du 18 arrivee le 21
// retrouve ainsi sa place.
//
// Les bilans hebdomadaires des services -- ceux que TIAKO et MESSOA
// transmettent le lundi pour la semaine ecoulee -- couvrent une periode et
// non un jour. Ils etaient ecartes du rapport journalier a juste titre ; ici
// ils sont au contraire la matiere premiere.
async function construireHebdomadaire(debut) {
  const jours = joursDeLaSemaine(debut);
  const fin = jours[jours.length - 1];

  // On balaye une fenetre de part et d'autre de la periode. Apres, pour ce
  // qui arrive en retard. Avant, parce qu'un compte rendu mal nomme peut
  // tomber dans la fenetre precedente : le 14 septembre a 11h36, le Call
  // Center a depose un fichier intitule "15:09:2026" dans la fenetre du 13.
  // La datation ne gardera de toute facon que ce qui annonce un jour de la
  // semaine, ces deux fenetres supplementaires ne polluent donc rien.
  const fenetres = [veille(debut, 1), ...jours, veille(fin, -1)];

  const parJour = {};
  const bilansDeServices = [];
  const horsSemaine = [];
  const ignorees = [];
  let coutPieces = 0;

  for (const fenetre of fenetres) {
    const batch = prepareDailyBatch(fenetre);

    if (!batch.total_messages) {
      continue;
    }

    const lecture = await lirePiecesJointes(batch);

    coutPieces += lecture.cout;
    ignorees.push(...lecture.ignorees.map((p) => `${fenetre} : ${p}`));

    if (jours.includes(fenetre)) {
      const textes = batch.messages
        .map((m) => ({ heure: m.timestamp, texte: m.text }))
        .filter((m) => m.texte);

      if (textes.length) {
        (parJour[fenetre] ||= { messages: [], pieces: [] }).messages.push(...textes);
      }
    }

    for (const piece of lecture.lues) {
      let journee = null;

      try {
        journee = await journeeDuComptRendu(piece, fenetre);
      } catch (erreur) {
        console.warn(`[rapport] datation de ${piece.nom} impossible : ${erreur.message}`);
      }

      if (journee?.periode) {
        console.log(`[rapport]   bilan de service : ${piece.nom} (${journee.indice})`);
        bilansDeServices.push({ nom: piece.nom, texte: piece.texte });
        continue;
      }

      // Sans date lisible, la piece revient a la journee de sa fenetre.
      const cible = journee?.date || fenetre;

      if (!jours.includes(cible)) {
        horsSemaine.push({ nom: piece.nom, journee: cible });

        console.warn(
          `[rapport]   hors semaine : ${piece.nom} porte sur le ${cible}`
        );

        continue;
      }

      if (journee?.date && journee.date !== fenetre) {
        console.log(
          `[rapport]   rattachee au ${cible} : ${piece.nom} (arrivee dans la fenetre du ${fenetre})`
        );
      }

      (parJour[cible] ||= { messages: [], pieces: [] }).pieces.push(piece);
    }
  }

  const journees = jours
    .map((jour) => {
      const ponctualite = faitsDePonctualite(jour);
      const contenu = parJour[jour];

      if (!contenu && !ponctualite.fiche_recue) {
        return null;
      }

      return {
        date: jour,
        ponctualite: ponctualiteSoumise(ponctualite),
        messages: contenu?.messages || [],
        pieces: contenu?.pieces || [],
      };
    })
    .filter(Boolean);

  if (!journees.length && !bilansDeServices.length) {
    return { statut: "vide", date: debut, fin };
  }

  const contexte =
    `${consigneHebdomadaire(debut, fin)}\n\n` +
    `JOURNEES DE LA PERIODE :\n${JSON.stringify(journees)}` +
    (bilansDeServices.length
      ? `\n\nBILANS HEBDOMADAIRES TRANSMIS PAR LES SERVICES :\n` +
        `${JSON.stringify(bilansDeServices)}`
      : "");

  let { donnees, usage, modele } = await produireJson(
    contexte, SCHEMA_HEBDOMADAIRE, "HEBDOMADAIRE"
  );

  let erreurs = valider(donnees, "HEBDOMADAIRE");

  if (erreurs.length) {
    console.warn(`[rapport] validation echouee : ${erreurs.join(", ")}. Reprise.`);

    const reprise = await produireJson(
      contexte, SCHEMA_HEBDOMADAIRE, "HEBDOMADAIRE", { precedent: donnees, erreurs }
    );

    donnees = reprise.donnees;
    usage = reprise.usage;
    modele = reprise.modele;
    erreurs = valider(donnees, "HEBDOMADAIRE");
  }

  const numero = allocateReportNumber(debut);

  return {
    statut: erreurs.length ? "defauts" : "ok",
    erreurs,
    pieces_ignorees: [
      ...ignorees,
      ...horsSemaine.map(
        (p) => `${p.nom} porte sur le ${p.journee}, hors de la semaine`
      ),
    ],
    cout_pieces: coutPieces,
    usage,
    modele,
    date: debut,
    fin,
    journees_couvertes: journees.map((j) => j.date),
    document: {
      type: "HEBDOMADAIRE",
      numero: `N° ${String(numero).padStart(3, "0")} / ${SIGLE} / ${REFERENCE_HEBDO}`,
      ville: VILLE,
      date_redaction: enFrancais(localToday()),
      titre_periode:
        `SEMAINE DU ${enFrancais(debut).toUpperCase()} AU ${enFrancais(fin).toUpperCase()}`,
      signature: SIGNATURE,
      ...donnees,
      donnees_manquantes: [
        ...(donnees.donnees_manquantes || []),
        ...ignorees.map((p) => `Piece jointe non lue par le programme : ${p}`),
      ],
    },
  };
}


async function produireHebdomadaire(debut, dossier = ".") {
  const resultat = await construireHebdomadaire(debut);

  if (resultat.statut === "vide") {
    return resultat;
  }

  const chemin = `${dossier}/${nomFichier(resultat.document, debut)}`;
  ecrire(resultat.document, chemin);

  return { ...resultat, chemin };
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
  construireHebdomadaire,
  produireHebdomadaire,
  joursDeLaSemaine,
  SCHEMA_HEBDOMADAIRE,
  journeeDuComptRendu,
  trierParJournee,
  lirePiecesJointes,
  construireQuotidien,
  produireQuotidien,
  valider,
  enFrancais,
  veille,
  SCHEMA_QUOTIDIEN,
};
