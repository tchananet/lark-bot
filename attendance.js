require("dotenv").config();

const { db } = require("./database");

// Horaires officiels. L'equipe de permanence reprend plus tard le
// LENDEMAIN de sa garde : c'est la regle inscrite en bas du planning
// hebdomadaire ("le personnel designe pour le service du soir reprendra
// le travail a 10H30").
const HEURE_NORMALE = process.env.RH_HEURE_ARRIVEE || "08:30";
const HEURE_APRES_GARDE = process.env.RH_HEURE_APRES_GARDE || "10:30";
const TOLERANCE_MINUTES = Number(process.env.RH_TOLERANCE_MINUTES || 0);

// Avant cette heure, une ligne vide sur une fiche partielle signifie
// "pas encore arrive". Apres, elle vaut absence. Le seuil est posterieur
// a 10h30 pour ne pas declarer absente une personne qui rentre de garde.
const HEURE_BASCULE_ABSENCE =
  process.env.RH_HEURE_BASCULE_ABSENCE || "11:00";


db.exec(`
  CREATE TABLE IF NOT EXISTS shift_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    type_poste TEXT NOT NULL DEFAULT 'permanence',
    source_document TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (employee_id, date, type_poste),
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
  )
`);


// Une meme journee est transmise deux fois : partielle le matin, complete
// le lendemain. La cle (employee_id, date) est donc unique et la seconde
// transmission COMPLETE la premiere au lieu de la dupliquer.
db.exec(`
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    date TEXT NOT NULL,

    heure_arrivee TEXT,
    heure_depart_pause TEXT,
    heure_retour_pause TEXT,
    heure_depart TEXT,
    observation TEXT,

    statut_feuille TEXT NOT NULL DEFAULT 'partielle',
    source_document TEXT,
    confiance TEXT,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (employee_id, date),
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
  )
`);


// Tout ce que la lecture n'a pas tranche avec certitude atterrit ici et
// n'entre dans aucun chiffre avant validation humaine.
db.exec(`
  CREATE TABLE IF NOT EXISTS attendance_a_valider (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom_brut TEXT,
    date TEXT,
    champ TEXT,
    valeur_lue_1 TEXT,
    valeur_lue_2 TEXT,
    employee_id INTEGER,
    statut_rapprochement TEXT,
    source_document TEXT,
    resolu INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);


function enMinutes(heure) {
  if (!heure) {
    return null;
  }

  const m = String(heure).trim().match(/^(\d{1,2})\s*[hH:]\s*(\d{1,2})$/);

  if (!m) {
    return null;
  }

  const heures = Number(m[1]);
  const minutes = Number(m[2]);

  if (heures > 23 || minutes > 59) {
    return null;
  }

  return heures * 60 + minutes;
}


function enHeure(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}h${String(m).padStart(2, "0")}`;
}


function jourPrecedent(date) {
  return db.prepare("SELECT DATE(?, '-1 day') AS d").get(date).d;
}


function etaitDeGarde(employeeId, date) {
  const ligne = db.prepare(`
    SELECT 1 FROM shift_schedule
    WHERE employee_id = ? AND date = ?
    LIMIT 1
  `).get(employeeId, date);

  return Boolean(ligne);
}


// Heure a laquelle l'employe etait attendu ce jour-la, compte tenu d'une
// eventuelle garde la veille.
function heureAttendue(employeeId, date) {
  const veille = jourPrecedent(date);

  if (etaitDeGarde(employeeId, veille)) {
    return {
      heure: HEURE_APRES_GARDE,
      motif: `permanence la veille (${veille})`,
    };
  }

  return { heure: HEURE_NORMALE, motif: "horaire normal" };
}


function evaluerPonctualite(employeeId, date, heureArriveeLue) {
  const attendue = heureAttendue(employeeId, date);
  const minutesAttendues = enMinutes(attendue.heure);
  const minutesArrivee = enMinutes(heureArriveeLue);

  if (minutesArrivee === null) {
    return {
      statut: "sans_heure",
      heure_attendue: attendue.heure,
      motif: attendue.motif,
    };
  }

  const ecart = minutesArrivee - minutesAttendues - TOLERANCE_MINUTES;

  return {
    statut: ecart > 0 ? "retard" : "a_l_heure",
    retard_minutes: ecart > 0 ? ecart : 0,
    avance_minutes: ecart < 0 ? -ecart : 0,
    heure_arrivee: enHeure(minutesArrivee),
    heure_attendue: attendue.heure,
    motif: attendue.motif,
  };
}


// Sur une feuille partielle, une case vide ne vaut absence que si la
// feuille a ete transmise apres l'heure de bascule.
function interpreterLigneVide(statutFeuille, heureTransmission) {
  if (statutFeuille === "finale") {
    return "absent";
  }

  const transmission = enMinutes(heureTransmission);
  const bascule = enMinutes(HEURE_BASCULE_ABSENCE);

  if (transmission === null || transmission < bascule) {
    return "en_attente";
  }

  return "absent";
}


function enregistrerGarde(employeeId, date, options = {}) {
  return db.prepare(`
    INSERT INTO shift_schedule (employee_id, date, type_poste, source_document)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(employee_id, date, type_poste) DO NOTHING
  `).run(
    employeeId,
    date,
    options.type_poste || "permanence",
    options.source_document || null
  );
}


// La transmission du lendemain complete celle du matin : on ne remplace
// une valeur existante que si la nouvelle est renseignee.
function enregistrerPointage(data) {
  return db.prepare(`
    INSERT INTO attendance (
      employee_id, date,
      heure_arrivee, heure_depart_pause, heure_retour_pause, heure_depart,
      observation, statut_feuille, source_document, confiance
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

    ON CONFLICT(employee_id, date) DO UPDATE SET
      heure_arrivee = COALESCE(excluded.heure_arrivee, heure_arrivee),
      heure_depart_pause = COALESCE(excluded.heure_depart_pause, heure_depart_pause),
      heure_retour_pause = COALESCE(excluded.heure_retour_pause, heure_retour_pause),
      heure_depart = COALESCE(excluded.heure_depart, heure_depart),
      observation = COALESCE(excluded.observation, observation),
      statut_feuille = excluded.statut_feuille,
      source_document = excluded.source_document,
      confiance = excluded.confiance,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    data.employee_id,
    data.date,
    data.heure_arrivee || null,
    data.heure_depart_pause || null,
    data.heure_retour_pause || null,
    data.heure_depart || null,
    data.observation || null,
    data.statut_feuille || "partielle",
    data.source_document || null,
    data.confiance || null
  );
}


// Etat de la journee, employe par employe. Les entites collectives
// (SERVICE RENNOVA) sont suivies mais exclues de la ponctualite.
function journee(date) {
  const lignes = db.prepare(`
    SELECT
      e.id AS employee_id,
      e.nom_complet,
      e.service,
      COALESCE(e.type, 'individuel') AS type,
      p.heure_arrivee,
      p.heure_depart,
      p.heure_depart_pause,
      p.heure_retour_pause,
      p.observation,
      p.statut_feuille,
      p.confiance
    FROM employees e
    LEFT JOIN attendance p
      ON p.employee_id = e.id AND p.date = ?
    WHERE e.actif = 1
    ORDER BY e.nom_complet
  `).all(date);

  return lignes.map((ligne) => {
    if (ligne.type === "collectif") {
      return { ...ligne, ponctualite: { statut: "non_applicable" } };
    }

    const ponctualite = evaluerPonctualite(
      ligne.employee_id,
      date,
      ligne.heure_arrivee
    );

    // Une heure de depart sans heure d arrivee ne veut pas dire absent :
    // la personne etait la mais n a pas signe en arrivant. C est un
    // defaut de pointage, pas une absence, et il ne faut pas le compter
    // comme tel.
    if (ponctualite.statut === "sans_heure" && ligne.heure_depart) {
      return {
        ...ligne,
        ponctualite: {
          ...ponctualite,
          statut: "arrivee_non_signee",
        },
      };
    }

    return { ...ligne, ponctualite };
  });
}


module.exports = {
  enMinutes,
  enHeure,
  jourPrecedent,
  etaitDeGarde,
  heureAttendue,
  evaluerPonctualite,
  interpreterLigneVide,
  enregistrerGarde,
  enregistrerPointage,
  journee,
  HEURE_NORMALE,
  HEURE_APRES_GARDE,
};
