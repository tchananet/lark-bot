const { analyser } = require("./routeur");
const { extrairePointage, extrairePlanning } = require("./extraction");
const { runDigest } = require("./digest");
const { evaluerJournee } = require("./presence");
const { localReportDate } = require("./database");
const { resoudreEmploye, enregistrerAbsence } = require("./hr");

// ---------------------------------------------------------------------------
// Conversation avec la DRH
//
// Aucune commande a retenir : on ecrit en francais et le bot decide. La
// verification du role est faite par l'appelant AVANT d'arriver ici, pour
// qu'un message d'un tiers ne declenche jamais le moindre appel au modele.
// ---------------------------------------------------------------------------

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
