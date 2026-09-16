const { analyser } = require("./routeur");
const { extrairePointage, extrairePlanning } = require("./extraction");
const { runDigest } = require("./digest");
const { evaluerJournee } = require("./presence");
const { localReportDate } = require("./database");
const {
  resoudreEmploye,
  enregistrerAbsence,
  revuesEnAttente,
  corrigerPointage,
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


async function traiterPointage(fichiers, repondre) {
  for (const chemin of fichiers) {
    await repondre("Fiche de presence recue, lecture en cours. Cela prend quelques minutes.");

    const resultat = await extrairePointage(chemin);

    if (!resultat.dates.length) {
      await repondre("Aucune journee exploitable n'a pu etre lue sur cette fiche.");
      continue;
    }

    let message =
      `Fiche lue : ${resultat.dates.join(", ")}.\n` +
      `${resultat.enregistres} pointage(s) enregistre(s).`;

    if (resultat.en_revue) {
      message +=
        `\n${resultat.en_revue} cellule(s) illisible(s), laissee(s) de cote ` +
        `plutot que devinee(s) :\n` +
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


async function traiterAbsences(absences, expediteur, repondre) {
  const enregistrees = [];
  const inconnues = [];

  for (const absence of absences) {
    const { employe } = resoudreEmploye(absence.personne);

    // On ne cree jamais un employe a partir d'un nom cite dans un message :
    // une faute de frappe fabriquerait une personne fantome.
    if (!employe) {
      inconnues.push(absence.personne);
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


async function traiterCorrections(corrections, expediteur, repondre) {
  const faites = [];
  const impossibles = [];

  for (const correction of corrections) {
    const { employe } = resoudreEmploye(correction.personne);

    if (!employe) {
      impossibles.push(`${correction.personne} : nom inconnu du registre.`);
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


async function traiterDemandeRapport(date, repondre) {
  const cible = date || localReportDate();

  await repondre(`Generation du rapport du ${cible} en cours...`);

  const resultat = await runDigest({ date: cible });

  if (resultat.status === "empty") {
    await repondre(`Aucun compte rendu enregistre pour le ${cible}.`);
    return;
  }

  if (resultat.status === "error") {
    await repondre(`La generation du rapport du ${cible} a echoue. Voir les logs.`);
    return;
  }

  await repondre("Rapport publie dans le groupe de suivi.");
}


async function traiter({ texte = "", fichiers = [], expediteur = {}, repondre }) {
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
      await traiterAbsences(analyse.absences, expediteur, repondre);
      return analyse;

    case "CORRECTION":
      await traiterCorrections(analyse.corrections, expediteur, repondre);
      return analyse;

    case "DEMANDE_RAPPORT":
      await traiterDemandeRapport(analyse.rapport_date, repondre);
      return analyse;

    case "RAPPORT":
      // Le compte rendu est deja enregistre par la voie normale ; il sera
      // repris dans le rapport consolide. Rien a repondre.
      return analyse;

    default:
      // Salutations et messages sans objet : le silence vaut mieux qu'un
      // accuse de reception a chaque phrase.
      return analyse;
  }
}

module.exports = { traiter };
