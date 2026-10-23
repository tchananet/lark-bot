const { pointagesDuJour, revuesEnAttente } = require("./hr");
const { enMinutes } = require("./temps");
const { DEPART_SOIR } = require("./presence");
const odoo = require("./odoo");

// ---------------------------------------------------------------------------
// Pousser la presence confirmee vers Odoo (x_manual.attendance)
//
// Decision prise avec la DRH : une journee ne part vers Odoo que lorsqu'elle
// est propre -- plus aucune cellule en litige entre les deux lectures. Les
// journees encore en revue restent en local jusqu'a leur resolution ; les
// renvoyer trop tot a Odoo y ecrirait des heures pas encore sures.
//
// Un echec de synchronisation (Odoo injoignable, identifiants absents) ne
// doit jamais faire echouer l'enregistrement local : la base SQLite reste la
// source de verite, Odoo n'en est qu'un miroir. Le prochain appel (nouvelle
// fiche, correction) retentera naturellement.
// ---------------------------------------------------------------------------

function journeeEstPropre(date) {
  return revuesEnAttente({ date }).length === 0;
}


// Africa/Douala est a UTC+1 toute l'annee (pas d'heure d'ete) : Odoo stocke
// ses datetime en UTC, donc l'heure locale de la fiche doit etre decalee
// avant l'ecriture, sans quoi chaque pointage apparaitrait une heure plus
// tard cote Odoo.
function versDatetimeOdoo(date, heureLocale) {
  const minutes = enMinutes(heureLocale);

  if (minutes === null) {
    return null;
  }

  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");

  const iso = new Date(`${date}T${hh}:${mm}:00+01:00`).toISOString();

  return iso.slice(0, 19).replace("T", " ");
}


// La garde se lit sur l'heure de depart REELLEMENT pointee, pas sur le
// planning de permanence (shift_schedule) : les echanges de garde entre
// collegues sont frequents et rendent ce planning rapidement faux. Un
// depart a l'heure de la releve du soir ou plus tard vaut garde, quel que
// soit qui etait prevu au planning.
const SEUIL_GARDE_MINUTES = enMinutes(DEPART_SOIR);

function estEnGarde(heureDepart) {
  const minutes = enMinutes(heureDepart);

  return minutes !== null && SEUIL_GARDE_MINUTES !== null && minutes >= SEUIL_GARDE_MINUTES;
}


async function trouverOuCreerFiche(date) {
  const existantes = await odoo.lire("x_manual.attendance", [["x_date_2", "=", date]], ["id"], 1);

  if (existantes.length) {
    return existantes[0].id;
  }

  return odoo.creer("x_manual.attendance", {
    x_name: `Fiche de presence - ${date}`,
    x_date_2: date,
  });
}


async function trouverLigne(ficheId, employeOdooId) {
  const existantes = await odoo.lire(
    "x_manual.attendance.line",
    [["x_attendance_sheet_id", "=", ficheId], ["x_employee_id", "=", employeOdooId]],
    ["id"],
    1
  );

  return existantes[0]?.id || null;
}


async function synchroniserJournee(date) {
  if (!journeeEstPropre(date)) {
    return { date, synchronise: false, motif: "cellules_en_revue" };
  }

  const lignes = pointagesDuJour(date);

  if (!lignes.length) {
    return { date, synchronise: false, motif: "rien_a_synchroniser" };
  }

  const ficheId = await trouverOuCreerFiche(date);

  let ecrites = 0;
  const echecs = [];

  for (const ligne of lignes) {
    try {
      const employeOdoo = await odoo.resoudreEmployeOdoo(ligne.nom_complet);

      if (!employeOdoo) {
        echecs.push(`${ligne.nom_complet} : aucun employe Odoo correspondant`);
        continue;
      }

      const valeurs = {
        x_check_in: versDatetimeOdoo(date, ligne.heure_arrivee),
        x_check_out: versDatetimeOdoo(date, ligne.heure_depart),
        x_studio_de_garde_aujourdhui: estEnGarde(ligne.heure_depart),
      };

      const ligneId = await trouverLigne(ficheId, employeOdoo.id);

      if (ligneId) {
        await odoo.ecrire("x_manual.attendance.line", ligneId, valeurs);
      } else {
        await odoo.creer("x_manual.attendance.line", {
          x_name: `${ligne.nom_complet} - ${date}`,
          x_attendance_sheet_id: ficheId,
          x_employee_id: employeOdoo.id,
          ...valeurs,
        });
      }

      ecrites++;
    } catch (erreur) {
      echecs.push(`${ligne.nom_complet} : ${erreur.message}`);
    }
  }

  return { date, synchronise: true, ecrites, echecs };
}


module.exports = { journeeEstPropre, versDatetimeOdoo, estEnGarde, synchroniserJournee };
