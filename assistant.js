const { analyser } = require("./routeur");
const { extrairePointageLot, extrairePlanning } = require("./extraction");
const { publierRapport } = require("./publication");
const { evaluerJournee, faitsDePonctualite } = require("./presence");
const {
  questionsPourLeRapport,
  questionsOuvertes,
  journeeEnAttente,
  trancher,
} = require("./arbitrage");
const { localReportDate, texteConnu } = require("./database");
const { generer } = require("./ia");
const { inventaire, enFrancais: etatEnFrancais } = require("./inventaire");
const {
  resoudreEmploye,
  enregistrerAbsence,
  revuesEnAttente,
  corrigerPointage,
  comptesLarkPour,
  accorderRoleRH,
  retirerRoleRH,
  listerRH,
} = require("./hr");

// ---------------------------------------------------------------------------
// Conversation avec la DRH
//
// Aucune commande a retenir : on ecrit en francais et le bot decide. La
// verification du role est faite par l'appelant AVANT d'arriver ici, pour
// qu'un message d'un tiers ne declenche jamais le moindre appel au modele.
// ---------------------------------------------------------------------------

const LIBELLES_CHAMPS = {
  heure_arrivee: "heure arrivee",
  heure_depart: "heure depart",
  heure_depart_pause: "depart en pause",
  heure_retour_pause: "retour de pause",
};

const TYPES_ABSENCE = {
  PERMISSION: "permission",
  CONGE: "conge",
  MISSION: "mission",
  MALADIE: "arret maladie",
  FORMATION: "formation",
};


function resumeQuestions(date) {
  const { questions } = evaluerJournee(date);

  if (!questions.length) {
    return "";
  }

  return (
    `\n\nIl reste ${questions.length} point(s) a eclaircir pour le ${date} :\n` +
    questions.map((q, i) => `${i + 1}. ${q}`).join("\n")
  );
}


// Une fiche, meme en plusieurs pages, est une seule fiche.
//
// Chaque image etait lue comme un document independant, qui se datait sur son
// propre en-tete. Or une fiche de presence tient rarement sur une page, et la
// suite ne reprend pas l'en-tete : le modele n'y trouvait aucune date, en
// devinait une, et la journee se retrouvait coupee en deux -- la moitie des
// gens sur un jour, l'autre moitie sur le jour voisin, et tout le monde
// absent de part et d'autre.
//
// Des pages envoyees dans le meme message sont la suite les unes des autres.
// Elles partagent donc la journee de la premiere, celle qui porte l'en-tete.
// La date retenue est annoncee : c'est une deduction, elle doit se voir.
async function traiterPointage(fichiers, repondre) {
  if (!fichiers.length) {
    return;
  }

  await repondre(
    fichiers.length > 1
      ? `Fiche de présence reçue, ${fichiers.length} pages. Lecture en cours, ` +
        `cela prend quelques minutes.`
      : "Fiche de présence reçue, lecture en cours. Cela prend quelques minutes."
  );

  const resultat = await extrairePointageLot(fichiers);

  if (!resultat.dates.length) {
    await repondre("Aucune journée exploitable n'a pu être lue sur cette fiche.");
    return;
  }

  let message =
    `Fiche lue : ${resultat.dates.join(", ")}` +
    (resultat.pages > 1 ? ` (${resultat.pages} pages)` : "") +
    `.\n${resultat.enregistres} pointage(s) enregistré(s).`;

  // La deduction se dit. Si elle est fausse -- deux journees envoyees dans un
  // seul message -- la DRH doit pouvoir s'en apercevoir et renvoyer separement.
  if (resultat.dates_ecartees.length) {
    message +=
      `\n\nLes pages d'un même envoi couvrent la même journée : ` +
      `${resultat.dates_ecartees.join(", ")} a été ramené au ` +
      `${resultat.dates[0]}. Si ce sont bien deux journées différentes, ` +
      `envoyez-les séparément.`;
  }

  // Normalement deux moteurs se relisent l'un l'autre. Quand l'un tombe,
  // la fiche passe quand meme, mais sans ce filet : autant le dire.
  if (resultat.moteur_unique) {
    message +=
      `\n\nAttention : un seul moteur de lecture a répondu ` +
      `(${resultat.moteur_unique}). Les heures n'ont pas été recoupées, ` +
      `vérifiez-les sur la fiche papier.`;
  }

  if (resultat.en_revue) {
    message +=
      `\n${resultat.en_revue} cellule(s) illisible(s), laissée(s) de côté ` +
      `plutôt que devinée(s) :\n` +
      resultat.divergences
        .slice(0, 8)
        .map((d) => `- ${d.date} ${d.nom_brut || ""} : ${d.motif}`)
        .join("\n");
  }

  for (const date of resultat.dates) {
    message += resumeQuestions(date);
  }

  await repondre(message);
}


async function traiterPlanning(fichiers, repondre) {
  for (const chemin of fichiers) {
    const resultat = await extrairePlanning(chemin);

    let message =
      `Planning enregistre : ${resultat.enregistres} garde(s) sur ` +
      `${resultat.jours} journee(s).`;

    if (resultat.en_revue) {
      message +=
        `\n${resultat.en_revue} nom(s) non reconnu(s) :\n` +
        resultat.divergences.map((d) => `- ${d.date} : ${d.nom_brut}`).join("\n");
    }

    await repondre(message);
  }
}


// Le 19 septembre, deux messages sans le moindre nom -- "planning de la
// semaine", puis "voila, une nouvelle fois" -- ont produit six absences
// completes, avec noms, dates, types et motifs, toutes inscrites en base. Le
// modele n'avait rien a lire et a comble le vide.
//
// Aucune consigne ne protege de cela de facon fiable. On verifie donc que la
// personne est REELLEMENT nommee dans le message avant d'ecrire quoi que ce
// soit : ce que le message ne dit pas ne peut pas etre enregistre.
function sansAccents(valeur) {
  return String(valeur || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
}

// Ce que l'expediteur a REELLEMENT soumis : son texte, plus le contenu des
// documents qu'il a joints.
//
// Le garde ne regardait que le texte du message. Or un "post" Lark ne portant
// que des fichiers arrive avec un texte vide : le 25 septembre, deux absences
// -- NGA ISABELLE et MARIE SHARONE ETOUNA -- ont ete ecartees alors qu'elles
// etaient nommees dans le planning joint. Trop strict, le garde effacait de
// vraies declarations.
//
// Un nom ecrit dans une piece que l'expediteur a lui-meme envoyee n'est pas
// une invention du modele : c'est une preuve. Seul compte le texte deja
// EXTRAIT et garde en base -- jamais une sortie de modele, sans quoi le garde
// validerait ce qu'il est cense surveiller.
function texteSoumis(texte, fichiers = []) {
  const morceaux = [texte || ""];

  for (const chemin of fichiers) {
    const connu = texteConnu(chemin);

    if (connu) {
      morceaux.push(connu.texte);
    }
  }

  return morceaux.join("\n");
}


function citeDansLeMessage(nom, texte) {
  const corps = sansAccents(texte);

  if (!corps.trim()) {
    return false;
  }

  const mots = sansAccents(nom)
    .split(/[^A-Z0-9]+/)
    .filter((mot) => mot.length > 2);

  // Un seul mot du nom suffit : la DRH ecrit "Isabelle est en formation",
  // pas le nom complet du registre.
  return mots.some((mot) => corps.includes(mot));
}


async function traiterAbsences(absences, expediteur, repondre, texte = "") {
  const enregistrees = [];
  const inconnues = [];
  const inventees = [];

  for (const absence of absences) {
    const { employe } = resoudreEmploye(absence.personne);

    // On ne cree jamais un employe a partir d'un nom cite dans un message :
    // une faute de frappe fabriquerait une personne fantome.
    if (!employe) {
      inconnues.push(absence.personne);
      continue;
    }

    if (!citeDansLeMessage(absence.personne, texte) &&
        !citeDansLeMessage(employe.nom_complet, texte)) {
      inventees.push(employe.nom_complet);
      continue;
    }

    enregistrerAbsence({
      employee_id: employe.id,
      type: absence.type,
      date_debut: absence.date_debut,
      date_fin: absence.date_fin,
      motif: absence.motif || null,
      declare_par: expediteur.nom || expediteur.open_id || "RH",
    });

    const periode =
      absence.date_debut === absence.date_fin
        ? `le ${absence.date_debut}`
        : `du ${absence.date_debut} au ${absence.date_fin}`;

    enregistrees.push(
      `- ${employe.nom_complet} : ${TYPES_ABSENCE[absence.type] || absence.type} ` +
      `${periode}${absence.motif ? ` (${absence.motif})` : ""}`
    );
  }

  let message = "";

  if (enregistrees.length) {
    message += `C'est note :\n${enregistrees.join("\n")}`;
  }

  if (inconnues.length) {
    message +=
      `${message ? "\n\n" : ""}Nom(s) non reconnu(s) dans le registre : ` +
      `${inconnues.join(", ")}. Rien n'a ete enregistre pour eux.`;
  }

  if (inventees.length) {
    console.warn(
      `[assistant] absences ecartees, personne citee ni dans le message ni ` +
      `dans les pieces jointes : ${inventees.join(", ")} -- ` +
      `${texte.trim().length} caracteres fouilles`
    );

    message +=
      `${message ? "\n\n" : ""}Ni votre message ni les pièces ` +
      `jointes ne nomment cette personne. Rien n'a été enregistré. ` +
      `Précisez la personne, la date et le motif.`;
  }

  await repondre(message || "Aucune absence exploitable dans ce message.");
}


// "Isabelle est partie a 16h09" ne porte aucune date : on la retrouve dans
// les cellules encore en attente pour cette personne. Si plusieurs journees
// sont concernees, on demande laquelle plutot que de choisir au hasard.
function dateDeLaCorrection(correction, employe) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(correction.date || "")) {
    return { date: correction.date };
  }

  // Meme raison qu'en base : la revue porte le nom de la fiche, le registre
  // le nom complet. Seul resoudreEmploye, qui consulte les alias, les
  // rapproche.
  const attentes = revuesEnAttente().filter(
    (revue) =>
      revue.motif.includes(correction.champ) &&
      resoudreEmploye(revue.nom_brut).employe?.id === employe.id
  );

  const journees = [...new Set(attentes.map((r) => r.date))];

  if (journees.length === 1) {
    return { date: journees[0] };
  }

  if (journees.length > 1) {
    return {
      date: null,
      question: `${employe.nom_complet} : plusieurs journees sont en attente ` +
        `(${journees.join(", ")}). Laquelle corriger ?`,
    };
  }

  return {
    date: null,
    question: `${employe.nom_complet} : aucune cellule en attente sur ce point. ` +
      `Precisez la date a corriger.`,
  };
}


async function traiterCorrections(corrections, expediteur, repondre, texte = "") {
  const faites = [];
  const impossibles = [];

  for (const correction of corrections) {
    const { employe } = resoudreEmploye(correction.personne);

    if (!employe) {
      impossibles.push(`${correction.personne} : nom inconnu du registre.`);
      continue;
    }

    // Meme garde que pour les absences : une heure de pointage corrigee
    // au nom de quelqu un que le message ne mentionne pas est une invention.
    if (!citeDansLeMessage(correction.personne, texte) &&
        !citeDansLeMessage(employe.nom_complet, texte)) {
      impossibles.push(
        `${employe.nom_complet} : votre message ne le nomme pas. Rien corrige.`
      );
      continue;
    }

    const { date, question } = dateDeLaCorrection(correction, employe);

    if (!date) {
      impossibles.push(question);
      continue;
    }

    try {
      const resultat = corrigerPointage({
        employee_id: employe.id,
        date,
        champ: correction.champ,
        valeur: correction.valeur,
        declare_par: expediteur.nom || expediteur.open_id || "RH",
      });

      faites.push(
        `- ${employe.nom_complet}, ${date} : ` +
        `${LIBELLES_CHAMPS[correction.champ]} = ${resultat.heure}`
      );
    } catch (erreur) {
      impossibles.push(`${employe.nom_complet} : ${erreur.message}`);
    }
  }

  const restantes = revuesEnAttente().length;

  let message = "";

  if (faites.length) {
    message += `Corrige :\n${faites.join("\n")}`;
    message += restantes
      ? `\n\nIl reste ${restantes} cellule(s) a confirmer.`
      : `\n\nPlus aucune cellule en attente.`;
  }

  if (impossibles.length) {
    message += `${message ? "\n\n" : ""}${impossibles.join("\n")}`;
  }

  await repondre(message || "Aucune correction exploitable dans ce message.");
}


// Habiliter quelqu'un porte sur son COMPTE Lark, jamais sur son nom. Or
// Lark ne livre un open_id qu'avec un message : tant que la personne n'a
// pas ecrit au bot, son compte est inconnu et rien ne peut lui etre
// accorde. C'est une contrainte de la plateforme, pas un oubli.
async function traiterAcces(acces, expediteur, repondre) {
  const { parConfig, enBase } = listerRH();

  if (acces.action === "LISTER") {
    const lignes = enBase.map(
      (e) => `- ${e.nom_complet}${e.lark_open_id ? "" : " (compte Lark non encore relie)"}`
    );

    await repondre(
      (lignes.length
        ? `Personnes habilitees :\n${lignes.join("\n")}`
        : "Aucune habilitation enregistree en base.") +
      (parConfig.length
        ? `\n\n${parConfig.length} compte(s) habilite(s) par la configuration du serveur.`
        : "")
    );
    return;
  }

  const { employe } = resoudreEmploye(acces.personne);

  if (!employe) {
    await repondre(
      `${acces.personne} : nom inconnu du registre du personnel. ` +
      `Aucune habilitation n'a ete modifiee.`
    );
    return;
  }

  if (acces.action === "RETIRER") {
    retirerRoleRH(employe.id);

    // La liste de configuration prime sur la base : le dire franchement
    // plutot que d'annoncer une revocation qui n'a pas eu lieu.
    const parLaConfig = employe.lark_open_id && parConfig.includes(employe.lark_open_id);

    await repondre(
      parLaConfig
        ? `${employe.nom_complet} : habilitation retiree en base, mais son ` +
          `compte reste autorise par la configuration du serveur ` +
          `(LARK_RH_OPEN_ID). Il faut l'y enlever pour que ce soit effectif.`
        : `${employe.nom_complet} n'a plus acces a l'assistant.`
    );
    return;
  }

  const comptes = comptesLarkPour(employe.id);

  if (!comptes.length) {
    await repondre(
      `${employe.nom_complet} : je ne connais pas encore son compte Lark. ` +
      `Demandez-lui d'ecrire un message au bot, puis redemandez-moi de ` +
      `l'habiliter.`
    );
    return;
  }

  if (comptes.length > 1) {
    await repondre(
      `${employe.nom_complet} : plusieurs comptes Lark correspondent ` +
      `(${comptes.map((c) => c.name).join(", ")}). Precisez lequel habiliter.`
    );
    return;
  }

  accorderRoleRH(employe.id, comptes[0].open_id);

  await repondre(
    `${employe.nom_complet} peut desormais dialoguer avec l'assistant. ` +
    `Habilitation accordee par ${expediteur.nom || "la DRH"}.`
  );
}


// Le lundi de la semaine qui contient cette date. Une demande portant sur
// "la semaine derniere" arrive avec une date quelconque de cette semaine :
// le rapport, lui, part toujours du lundi.
function lundiDeLaSemaine(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const jour = d.getUTCDay();

  d.setUTCDate(d.getUTCDate() - (jour === 0 ? 6 : jour - 1));

  return d.toISOString().slice(0, 10);
}


const JOURS = [
  "dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi",
];

const MOIS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

function nomDuJour(iso) {
  const [annee, mois, jour] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(annee, mois - 1, jour));

  return `${JOURS[d.getUTCDay()]} ${jour} ${MOIS[mois - 1]}`;
}


// Un constat, pas un document. Aucun appel au modele, aucune lecture de
// fichier : on regarde ce qui est en base et on le dit.
async function traiterEtat(dates, repondre) {
  const journees = dates.length ? dates : [localReportDate()];

  const etats = journees.map((date) =>
    etatEnFrancais(inventaire(date), nomDuJour(date))
  );

  const manquantes = journees.filter((date) => {
    const etat = inventaire(date);

    return !etat.pieces.length && !etat.messages;
  });

  let message = etats.join("\n\n");

  if (manquantes.length < journees.length) {
    message +=
      "\n\nDites-moi quelle journée produire, et je lance le rapport.";
  }

  await repondre(message);
}


// Demander avant de conclure a une absence.
//
// Une fiche de presence ne dit pas tout : ni les permanences, ni les conges
// poses la veille, ni les missions. Une case vide y ressemble trait pour
// trait a une absence, et le rapport du 24 septembre en annoncait six sur
// vingt-trois -- un chiffre qui part a la Direction Generale et que la fiche
// seule ne permet pas d'affirmer.
//
// Le programme ne peut pas trancher : l'information n'est nulle part dans ce
// qu'il detient. Il s'arrete donc et demande. Une fois la journee tranchee,
// elle ne redemande plus rien.
const LIBELLES_STATUT = {
  ABSENT: "absence confirmée",
  PERMISSION: "permission",
  CONGE: "congé",
  MISSION: "mission",
  MALADIE: "arrêt maladie",
  FORMATION: "formation",
  PERMANENCE: "permanence",
  TELETRAVAIL: "télétravail",
};

// Les statuts qui valent justification : ils s'inscrivent au registre des
// absences. ABSENT ferme la question sans rien inscrire, et PERMANENCE comme
// TELETRAVAIL ne sont pas des absences du tout.
const JUSTIFICATIFS = new Set([
  "PERMISSION", "CONGE", "MISSION", "MALADIE", "FORMATION",
]);



// Lire la reponse de la DRH, sans jamais deborder de la question posee.
//
// Le modele ne peut se prononcer que sur les noms deja en attente : il ne
// peut ni en ajouter, ni toucher une autre journee. S'il ne reconnait aucune
// reponse, le message repart vers le routage normal -- la DRH a le droit de
// parler d'autre chose pendant qu'une question est ouverte.
async function lireReponseAbsences(texte, expediteur, repondre) {
  const date = journeeEnAttente();

  if (!date || !texte.trim()) {
    return false;
  }

  const ouvertes = questionsOuvertes(date);

  if (!ouvertes.length) {
    return false;
  }

  const consigne =
    `La DRH a ete interrogee sur des personnes sans pointage ni justificatif ` +
    `pour la journee du ${date}. Voici la question posee, puis sa reponse.\n\n` +
    `PERSONNES EN ATTENTE :\n${ouvertes.map((q) => q.nom).join("\n")}\n\n` +
    `REPONSE :\n${texte.trim()}\n\n` +
    `Pour CHACUNE des personnes ci-dessus, donne le statut que la reponse lui ` +
    `attribue. Statuts possibles : ABSENT, PERMISSION, CONGE, MISSION, ` +
    `MALADIE, FORMATION, PERMANENCE, TELETRAVAIL, ou INCONNU si la reponse ne ` +
    `dit rien de cette personne.\n` +
    `Une formule comme "les autres sont absents" ou "le reste absent" ` +
    `s'applique a toutes celles que la reponse n'a pas nommees.\n` +
    `Si le message ne repond pas du tout a la question, mets INCONNU partout.\n` +
    `N'ajoute aucun nom qui ne figure pas dans la liste.\n\n` +
    `Reponds en JSON strict : ` +
    `{"reponses":[{"nom":"...","statut":"...","motif":"..."}]}`;

  let brut;

  try {
    const { texte: json } = await generer({
      tache: "ROUTAGE",
      temperature: 0,
      messages: [{ role: "user", content: consigne }],
    });

    brut = JSON.parse((json || "").replace(/^\s*```(json)?|```\s*$/g, "").trim());
  } catch (erreur) {
    console.warn(`[assistant] reponse absences illisible : ${erreur.message}`);

    return false;
  }

  const attendus = new Map(ouvertes.map((q) => [q.nom, q]));
  const tranchees = [];

  for (const reponse of brut.reponses || []) {
    // Un nom hors de la question est ignore : le modele n'a pas le droit
    // d'elargir ce qui lui a ete soumis.
    if (!attendus.has(reponse.nom) || reponse.statut === "INCONNU") {
      continue;
    }

    if (!LIBELLES_STATUT[reponse.statut]) {
      continue;
    }

    trancher(date, reponse.nom, reponse.statut, reponse.motif || null);

    // Un justificatif s'inscrit au registre : il vaudra pour le rapport, et
    // pour tous ceux qui relisent cette journee ensuite.
    if (JUSTIFICATIFS.has(reponse.statut)) {
      const { employe } = resoudreEmploye(reponse.nom);

      if (employe) {
        enregistrerAbsence({
          employee_id: employe.id,
          type: reponse.statut,
          date_debut: date,
          date_fin: date,
          motif: reponse.motif || null,
          declare_par: expediteur.nom || expediteur.open_id || "RH",
        });
      }
    }

    tranchees.push(`${reponse.nom} : ${LIBELLES_STATUT[reponse.statut]}`);
  }

  // Aucune personne reconnue : le message parlait d'autre chose.
  if (!tranchees.length) {
    return false;
  }

  const restantes = questionsOuvertes(date);

  await repondre(
    `C'est noté pour le ${date} :\n${tranchees.map((t) => `• ${t}`).join("\n")}` +
    (restantes.length
      ? `\n\nIl reste à trancher : ${restantes.map((r) => r.nom).join(", ")}.`
      : `\n\nTout est tranché. Demande-moi le rapport du ${date} quand tu veux.`)
  );

  return true;
}


async function traiterDemandeRapport(date, repondre, portee = "JOURNEE") {
  const hebdomadaire = portee === "SEMAINE";

  const cible = hebdomadaire
    ? lundiDeLaSemaine(date || localReportDate())
    : date || localReportDate();

  // La question se pose AVANT d'annoncer une generation : il serait absurde
  // de dire "rapport en cours" pour repondre ensuite qu'il n'a pas commence.
  // Le meme garde existe dans publierRapport, qui couvre le cron ; celui-ci
  // ne sert qu'a repondre dans le bon ordre.
  if (!hebdomadaire) {
    const attente = questionsPourLeRapport(cible);

    if (attente.questions.length) {
      await repondre(attente.message);
      return;
    }
  }

  await repondre(
    hebdomadaire
      ? `Génération du rapport hebdomadaire de la semaine du ${cible} en cours. ` +
        `Sept journées à relire, comptez quelques minutes.`
      : `Génération du rapport du ${cible} en cours...`
  );

  const resultat = await publierRapport({ date: cible, portee });

  // Filet : si la question s'est ouverte entre-temps, rien ne part.
  if (resultat.statut === "en_attente") {
    await repondre(resultat.message);
    return;
  }

  if (resultat.statut === "vide") {
    await repondre(
      hebdomadaire
        ? `Aucun compte rendu sur la semaine du ${cible}.`
        : `Aucun compte rendu ni fiche de présence pour le ${cible}.`
    );

    return;
  }

  if (resultat.statut === "erreur") {
    await repondre(`La génération du rapport du ${cible} a échoué. Voir les logs.`);
    return;
  }

  await repondre(
    "Rapport publié dans le groupe de suivi." +
    (resultat.reserves && resultat.reserves.length
      ? `

À vérifier : ${resultat.reserves.join(", ")}`
      : "")
  );
}


// Les faits dont la conversation a le droit de parler.
//
// Un modele a qui l'on ne donne rien ne repond pas "je ne sais pas" : il
// comble. Interroge sur la ponctualite sans aucune piece jointe, il a cite un
// "Rapport d'activite du 04/02/2025 (document joint)" qui n'existait pas, une
// plainte de M. KENGNE et une demission de Mme TCHINDA -- trois personnes
// inventees, dans un contexte RH.
//
// La consigne "n'invente jamais" ne suffit pas, on l'a deja vu avec les
// absences fabriquees du 19 septembre. Le remede est le meme : ne jamais
// l'interroger a vide. On lui remet les chiffres REELS des derniers jours,
// calcules en base, et il n'a plus de vide a combler.
function faitsRecents(jours = 7) {
  const { inventaire } = require("./inventaire");

  const releves = [];
  let date = localReportDate();

  for (let i = 0; i < jours; i++) {
    const etat = inventaire(date);

    releves.push({
      journee: date,
      documents_recus: etat.pieces.map((p) => p.nom),
      services_manquants: (etat.attendus.manquants || []).map((a) => a.libelle),
      fiche_de_presence: etat.fiche_recue ? "recue" : "non recue",
      retards_non_justifies: etat.retards,
      absences_non_justifiees: etat.absences,
      rapport_produit: etat.rapport_numero ? `N° ${etat.rapport_numero}` : "non",
    });

    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    date = d.toISOString().slice(0, 10);
  }

  return releves;
}


// Un modele prive de document en invente un. Quand rien n'est joint, aucune
// reponse ne peut s'appuyer sur "le document" : si elle le fait, elle est
// fausse par construction et ne doit pas partir.
function parleDUnDocumentAbsent(reponse) {
  return /\b(document|piece|rapport)\s+(joint|ci-joint|transmis|fourni)|d['’]apr[eè]s\s+le\s+(document|rapport)/i
    .test(reponse || "");
}


// Repondre au CONTENU, quand rien d'autre ne s'applique.
//
// Un document qui ne tombe dans aucune categorie connue ne declenchait rien :
// la DRH envoyait une piece et recevait le silence. Or le texte est deja
// extrait a l'arrivee et garde en base -- il ne coute donc rien de s'en
// servir pour repondre.
//
// Le modele ne dispose que du document joint, ou a defaut des releves
// ci-dessus. Il n'a acces ni au registre du personnel, ni au detail des
// pointages : une question sur ces sujets releve d'une autre intention, et il
// doit le dire plutot que d'improviser.
async function traiterConversation(texte, fichiers, repondre) {
  const documents = [];

  for (const chemin of fichiers) {
    const connu = texteConnu(chemin);

    if (connu) {
      documents.push({
        nom: require("path").basename(chemin),
        texte: connu.texte.slice(0, 12000),
      });
    }
  }

  // Ni document lisible, ni question : le silence vaut mieux qu'un accuse de
  // reception a chaque bonjour.
  if (!documents.length && texte.trim().length < 15) {
    return;
  }

  const faits = documents.length ? null : faitsRecents();

  const consigne =
    `Tu es l'assistant RH d'ALPHA MOTORS Cameroun. Tu reponds a la DRH dans\n` +
    `une conversation, en francais, brievement et sans formule de politesse\n` +
    `superflue.\n\n` +
    `CE QUE TU SAIS, ET RIEN D'AUTRE\n` +
    (documents.length
      ? `Les documents joints ci-dessous, et le message.\n`
      : `AUCUN DOCUMENT N'EST JOINT A CE MESSAGE. Ne parle donc jamais d'un\n` +
        `document joint, d'un rapport transmis ou d'une piece fournie : il n'y\n` +
        `en a pas. Tu disposes des RELEVES ci-dessous, calcules en base, et du\n` +
        `message.\n`) +
    `\nTu n'as acces a rien de plus : ni au registre du personnel, ni au detail\n` +
    `des pointages, ni au texte des rapports. Si la question demande autre\n` +
    `chose, dis-le franchement et propose de demander l'etat d'une journee ou\n` +
    `un rapport.\n\n` +
    `N'invente JAMAIS un nom, un chiffre, une date ou un incident. Si tu es\n` +
    `tente de citer une personne, verifie qu'elle figure bien dans ce qui\n` +
    `t'est fourni ; sinon ne la cite pas. Mieux vaut une reponse courte qui\n` +
    `dit ne pas savoir qu'une reponse complete et fausse.\n\n` +
    (documents.length
      ? `DOCUMENTS JOINTS :\n${JSON.stringify(documents)}\n\n`
      : `RELEVES DES DERNIERS JOURS :\n${JSON.stringify(faits)}\n\n`) +
    `MESSAGE :\n${texte.trim() || "(aucun texte, seulement la piece jointe)"}`;

  const { texte: reponse } = await generer({
    tache: "RAPPORT",
    temperature: 0.2,
    messages: [{ role: "user", content: consigne }],
  });

  const propre = (reponse || "").trim();

  // Dernier filet : sans piece jointe, une reponse qui s'appuie sur "le
  // document" est fausse par construction. On prefere ne rien affirmer.
  if (!documents.length && parleDUnDocumentAbsent(propre)) {
    console.warn(
      `[assistant] reponse ecartee, elle invoque un document absent : ` +
      `${propre.slice(0, 120)}`
    );

    await repondre(
      `Je n'ai pas de document sous les yeux pour répondre à cela, et je ne ` +
      `veux rien avancer au hasard. Joignez la pièce concernée, ou demandez-moi ` +
      `l'état d'une journée ou un rapport.`
    );

    return;
  }

  await repondre(propre || "Je n'ai rien pu tirer de ce message.");
}


async function traiter({ texte = "", fichiers = [], expediteur = {}, repondre }) {
  // Une question posee attend sa reponse : on la lit avant de router, sans
  // quoi "Isabelle est en permanence" partirait en declaration d'absence et
  // la question resterait ouverte. Si le message ne repond a rien, il suit
  // son chemin normal.
  if (await lireReponseAbsences(texte, expediteur, repondre)) {
    return { intention: "REPONSE_ABSENCES", certitude: "HAUTE" };
  }

  const analyse = await analyser({ texte, fichiers });

  console.log(
    `[assistant] intention ${analyse.intention} (${analyse.certitude}) : ${analyse.explication}`
  );

  switch (analyse.intention) {
    case "POINTAGE":
      await traiterPointage(fichiers, repondre);
      return analyse;

    case "PLANNING":
      await traiterPlanning(fichiers, repondre);
      return analyse;

    case "PERMISSION":
      await traiterAbsences(
        analyse.absences, expediteur, repondre, texteSoumis(texte, fichiers)
      );
      return analyse;

    case "CORRECTION":
      await traiterCorrections(
        analyse.corrections, expediteur, repondre, texteSoumis(texte, fichiers)
      );
      return analyse;

    case "GESTION_ACCES":
      if (analyse.acces) {
        await traiterAcces(analyse.acces, expediteur, repondre);
      }
      return analyse;

    case "ETAT":
      await traiterEtat(analyse.etat_dates || [], repondre);
      return analyse;

    case "DEMANDE_RAPPORT":
      await traiterDemandeRapport(
        analyse.rapport_date,
        repondre,
        analyse.rapport_portee
      );
      return analyse;

    case "RAPPORT":
      // Le compte rendu est deja enregistre par la voie normale et sera repris
      // dans le rapport consolide. On accuse quand meme reception : la DRH a
      // le droit de savoir que sa piece est arrivee et a ete lue.
      await repondre(
        `Compte rendu reçu et enregistré. Il sera repris dans le rapport ` +
        `consolidé de la journée qu'il couvre.`
      );
      return analyse;

    case "QUESTION":
      await traiterConversation(texte, fichiers, repondre);
      return analyse;

    default:
      // Salutations et messages sans objet. On repond quand meme s il y a une
      // piece jointe : un document envoye sans un mot merite mieux que le
      // silence.
      if (fichiers.length) {
        await traiterConversation(texte, fichiers, repondre);
      }

      return analyse;
  }
}

module.exports = { traiter, texteSoumis, citeDansLeMessage };
