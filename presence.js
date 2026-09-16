const { absencePour, estDeSoir, pointagesDuJour, listerEmployes } = require("./hr");
const { enMinutes, enTexte, veilleDe } = require("./temps");

// ---------------------------------------------------------------------------
// Regles de presence ALPHA MOTORS
//
//   Journee normale        : 08h30 - 18h00
//   Journee de permanence  : 08h30 - 20h00 (equipe du soir)
//   Lendemain de permanence: arrivee autorisee a 10h30
//
// Un depart anticipe n'est pas evalue, et un depart tardif n'est jamais
// signale : travailler au-dela de l'heure est courant et ne regarde pas
// ce rapport.
// ---------------------------------------------------------------------------

const ARRIVEE_NORMALE = process.env.RH_HEURE_ARRIVEE || "08:30";
const ARRIVEE_APRES_SOIR = process.env.RH_HEURE_ARRIVEE_APRES_SOIR || "10:30";
const DEPART_NORMAL = process.env.RH_HEURE_DEPART || "18:00";
const DEPART_SOIR = process.env.RH_HEURE_DEPART_SOIR || "20:00";

const TOLERANCE = Number(process.env.RH_TOLERANCE_MINUTES || 15);
const SEUIL_ANOMALIE = Number(process.env.RH_SEUIL_ANOMALIE_MINUTES || 60);

const STATUTS = {
  OK: "OK",
  RETARD: "RETARD",
  ANOMALIE: "ANOMALIE",
  DISTANCE: "À DISTANCE",
  AUTORISEE: "ABSENCE AUTORISÉE",
  MISSION: "EN MISSION",
  ABSENT: "ABSENT",
};

// Fonction pure : toute la logique metier, sans acces base. Testable seule.
function evaluerLigne(contexte) {
  const {
    nom,
    heure_arrivee,
    heure_depart,
    de_soir_ce_jour,
    de_soir_la_veille,
    absence,
    mode_travail,
  } = contexte;

  const arriveePrevue = enMinutes(
    de_soir_la_veille ? ARRIVEE_APRES_SOIR : ARRIVEE_NORMALE
  );
  const departPrevu = enMinutes(de_soir_ce_jour ? DEPART_SOIR : DEPART_NORMAL);

  const arrivee = enMinutes(heure_arrivee);
  const depart = enMinutes(heure_depart);

  const base = {
    nom,
    heure_arrivee: heure_arrivee || null,
    heure_depart: heure_depart || null,
    arrivee_prevue: enTexte(arriveePrevue),
    depart_prevu: enTexte(departPrevu),
    de_soir_ce_jour: !!de_soir_ce_jour,
    de_soir_la_veille: !!de_soir_la_veille,
    retard_minutes: 0,
    question: null,
    note: null,
  };

  // Aucune trace de passage : une justification explicite prime toujours
  // sur le mode de travail par defaut.
  if (arrivee === null && depart === null) {
    if (absence && absence.type === "MISSION") {
      return { ...base, statut: STATUTS.MISSION, detail: absence.motif || "en mission" };
    }

    if (absence) {
      return {
        ...base,
        statut: STATUTS.AUTORISEE,
        detail: absence.motif || absence.type.toLowerCase(),
      };
    }

    if (mode_travail === "DISTANCE") {
      return { ...base, statut: STATUTS.DISTANCE, detail: "travail a distance" };
    }

    return {
      ...base,
      statut: STATUTS.ABSENT,
      detail: "aucune signature",
      question: `${nom} : absent, aucune signature. Absence autorisee, mission ou travail a distance ?`,
    };
  }

  // Une seule des deux signatures : la personne etait la, la feuille est
  // incomplete. C'est un defaut de saisie, pas un fait de presence.
  if (arrivee === null || depart === null) {
    return {
      ...base,
      statut: STATUTS.OK,
      detail: arrivee === null ? `depart ${heure_depart}` : `arrivee ${heure_arrivee}`,
      note: arrivee === null
        ? `${nom} : heure d'arrivee non signee`
        : `${nom} : heure de depart non signee`,
    };
  }

  const retard = arrivee - arriveePrevue;

  if (retard > SEUIL_ANOMALIE) {
    return {
      ...base,
      statut: STATUTS.ANOMALIE,
      retard_minutes: retard,
      detail: `arrivee ${heure_arrivee} au lieu de ${enTexte(arriveePrevue)}`,
      question: `${nom} : arrivee a ${heure_arrivee} au lieu de ${enTexte(arriveePrevue)}. Permission ou mission ?`,
    };
  }

  if (retard > TOLERANCE) {
    return {
      ...base,
      statut: STATUTS.RETARD,
      retard_minutes: retard,
      detail: `${retard} min de retard (attendu ${enTexte(arriveePrevue)})`,
    };
  }

  return {
    ...base,
    statut: STATUTS.OK,
    detail: `${heure_arrivee} - ${heure_depart}`,
  };
}


// Version branchee sur la base : rassemble le contexte de chaque employe
// suivi, puis delegue a la fonction pure.
function evaluerJournee(date) {
  const veille = veilleDe(date);
  const pointages = new Map(
    pointagesDuJour(date).map((p) => [p.employee_id, p])
  );

  const lignes = listerEmployes()
    .filter((employe) => employe.suivi_presence === 1)
    .map((employe) => {
      const pointage = pointages.get(employe.id) || {};

      return evaluerLigne({
        nom: employe.nom_complet,
        employee_id: employe.id,
        heure_arrivee: pointage.heure_arrivee,
        heure_depart: pointage.heure_depart,
        de_soir_ce_jour: estDeSoir(employe.id, date),
        de_soir_la_veille: estDeSoir(employe.id, veille),
        absence: absencePour(employe.id, date),
        mode_travail: employe.mode_travail,
      });
    });

  const compte = {};

  for (const ligne of lignes) {
    compte[ligne.statut] = (compte[ligne.statut] || 0) + 1;
  }

  return {
    date,
    lignes,
    compte,
    questions: lignes.map((l) => l.question).filter(Boolean),
    notes: lignes.map((l) => l.note).filter(Boolean),
  };
}

module.exports = {
  STATUTS,
  evaluerLigne,
  evaluerJournee,
};
