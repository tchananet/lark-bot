// Manipulation des heures de la fiche de presence.
//
// La fiche est remplie a la main : on y trouve 08h33, 8h18, 14:15, 07H58,
// 18H02. Tout est ramene a une seule forme avant d'entrer en base, sinon
// les rapports affichent un melange de notations et les comparaisons de
// chaines deviennent fausses.

function enMinutes(heure) {
  if (heure === null || heure === undefined) {
    return null;
  }

  const trouve = String(heure).trim().match(/^(\d{1,2})\s*[hH:.\s]\s*(\d{1,2})$/);

  if (!trouve) {
    return null;
  }

  const heures = Number(trouve[1]);
  const minutes = Number(trouve[2]);

  if (heures > 23 || minutes > 59) {
    return null;
  }

  return heures * 60 + minutes;
}

function enTexte(minutes) {
  if (minutes === null || minutes === undefined) {
    return null;
  }

  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");

  return `${h}h${m}`;
}

// Retourne la forme normalisee, ou null si la valeur est illisible.
function normaliserHeure(heure) {
  return enTexte(enMinutes(heure));
}

function veilleDe(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);

  return d.toISOString().slice(0, 10);
}

module.exports = { enMinutes, enTexte, normaliserHeure, veilleDe };
