const { db } = require("./database");
const { normaliserHeure } = require("./temps");

// ---------------------------------------------------------------------------
// Schema RH
//
// Les employes sont volontairement separes de la table users : users contient
// les comptes Lark qui ENVOIENT des messages, employees contient les personnes
// dont les documents PARLENT. Les deux ensembles se recoupent a peine.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    nom_complet TEXT NOT NULL,
    nom_fiche TEXT,
    cle_nom TEXT NOT NULL UNIQUE,

    service TEXT,
    poste TEXT,
    type_contrat TEXT DEFAULT 'INTERNE',

    mode_travail TEXT NOT NULL DEFAULT 'PRESENTIEL',
    suivi_presence INTEGER NOT NULL DEFAULT 1,
    actif INTEGER NOT NULL DEFAULT 1,

    ordre_fiche INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS employee_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    alias TEXT NOT NULL,
    cle_alias TEXT NOT NULL UNIQUE,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    date TEXT NOT NULL,

    heure_arrivee TEXT,
    heure_depart TEXT,
    heure_depart_pause TEXT,
    heure_retour_pause TEXT,
    observation TEXT,

    source_document_id INTEGER,
    certitude TEXT NOT NULL DEFAULT 'CONFIRMEE',

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (employee_id, date),
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
  )
`);

// Lignes que l'extraction n'a pas su rattacher, ou sur lesquelles les deux
// passes ont diverge. Rien n'entre dans attendance sans etre resolu ici.
db.exec(`
  CREATE TABLE IF NOT EXISTS attendance_review (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    nom_brut TEXT,
    motif TEXT NOT NULL,
    passe_1 TEXT,
    passe_2 TEXT,
    source_document_id INTEGER,
    resolu INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS shift_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    type_poste TEXT NOT NULL DEFAULT 'SOIR',
    source_document_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (employee_id, date, type_poste),
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
  )
`);

// Absences justifiees, stockees en PERIODES : une seule saisie couvre
// plusieurs jours et evite de reposer la question chaque matin.
db.exec(`
  CREATE TABLE IF NOT EXISTS absences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    date_debut TEXT NOT NULL,
    date_fin TEXT NOT NULL,
    motif TEXT,
    declare_par TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS hr_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    message_id TEXT,
    chemin TEXT,
    periode_debut TEXT,
    periode_fin TEXT,
    statut TEXT NOT NULL DEFAULT 'RECU',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Ajouts retro-compatibles sur les bases deja creees.
const COLONNES_AJOUTEES = [
  ["attendance", "champs_incertains TEXT"],
  ["attendance", "champs_corriges TEXT"],
  ["employees", "role TEXT"],
  ["employees", "lark_open_id TEXT"],
  // Renseignee par le registre, jamais devinee : une civilite fausse dans un
  // document signe de la DRH est une faute, l'absence de civilite non.
  ["employees", "civilite TEXT"],
];

for (const [table, colonne] of COLONNES_AJOUTEES) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colonne}`);
  } catch (erreur) {
    // La colonne existe deja.
  }
}

db.exec(`CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_shift_date ON shift_schedule(date)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_absences_emp ON absences(employee_id)`);


// ---------------------------------------------------------------------------
// Normalisation et rapprochement des noms
//
// Trois vocabulaires designent les memes personnes :
//   fiche de presence : ETOUNA MARIE
//   planning du soir  : MARIE S.
//   rapports          : Mme Sadia
// La table des alias est le mecanisme principal. Le rapprochement
// automatique n'est qu'un filet, et il ne cree JAMAIS un employe.
// ---------------------------------------------------------------------------

const CIVILITES = /^(M|MR|MME|MLLE|MONSIEUR|MADAME|MADEMOISELLE|DR)$/;

function normaliserNom(valeur) {
  return String(valeur || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((mot) => mot && !CIVILITES.test(mot))
    .join(" ")
    .trim();
}

// Cle insensible a l'ordre : ETOUNA MARIE et MARIE ETOUNA se rejoignent.
function cleNom(valeur) {
  return normaliserNom(valeur).split(" ").filter(Boolean).sort().join(" ");
}

function jetons(valeur) {
  return normaliserNom(valeur).split(" ").filter(Boolean);
}


function resoudreEmploye(nomBrut) {
  const cle = cleNom(nomBrut);

  if (!cle) {
    return { employe: null, methode: "VIDE" };
  }

  const parAlias = db.prepare(`
    SELECT e.* FROM employee_aliases a
    JOIN employees e ON e.id = a.employee_id
    WHERE a.cle_alias = ?
  `).get(cle);

  if (parAlias) {
    return { employe: parAlias, methode: "ALIAS" };
  }

  const exact = db.prepare(`SELECT * FROM employees WHERE cle_nom = ?`).get(cle);

  if (exact) {
    return { employe: exact, methode: "EXACT" };
  }

  // Filet : tous les jetons du nom recu figurent dans un employe, et un seul.
  const recus = jetons(nomBrut);

  const candidats = db.prepare(`SELECT * FROM employees WHERE actif = 1`).all()
    .filter((employe) => {
      const connus = new Set(
        jetons(employe.nom_complet).concat(jetons(employe.nom_fiche))
      );
      return recus.length > 0 && recus.every((mot) => connus.has(mot));
    });

  if (candidats.length === 1) {
    return { employe: candidats[0], methode: "JETONS" };
  }

  return {
    employe: null,
    methode: candidats.length > 1 ? "AMBIGU" : "INCONNU",
    candidats,
  };
}


function ajouterEmploye(donnees) {
  const nomComplet = donnees.nom_complet;

  // Un import ne doit pas defaire ce qui a ete regle ailleurs. Le CSV ne
  // porte pas toujours le mode de travail : sans cette fusion, reimporter
  // le registre remettait les teletravailleurs en presentiel, et ils
  // ressortaient ABSENTS chaque jour.
  const existant = db.prepare(`SELECT * FROM employees WHERE cle_nom = ?`)
    .get(cleNom(nomComplet));

  const modeTravail =
    donnees.mode_travail || existant?.mode_travail || "PRESENTIEL";

  const suiviPresence =
    donnees.suivi_presence === undefined
      ? (existant ? existant.suivi_presence : 1)
      : (donnees.suivi_presence ? 1 : 0);

  const info = db.prepare(`
    INSERT INTO employees
      (nom_complet, nom_fiche, cle_nom, service, poste, type_contrat,
       mode_travail, suivi_presence, ordre_fiche, role, civilite)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cle_nom) DO UPDATE SET
      nom_fiche = COALESCE(excluded.nom_fiche, nom_fiche),
      service = COALESCE(excluded.service, service),
      mode_travail = excluded.mode_travail,
      suivi_presence = excluded.suivi_presence,
      role = COALESCE(excluded.role, role),
      civilite = COALESCE(excluded.civilite, civilite)
  `).run(
    nomComplet,
    donnees.nom_fiche || null,
    cleNom(nomComplet),
    donnees.service || null,
    donnees.poste || null,
    donnees.type_contrat || "INTERNE",
    modeTravail,
    suiviPresence,
    donnees.ordre_fiche || null,
    donnees.role || null,
    donnees.civilite || null
  );

  const employe = db.prepare(`SELECT * FROM employees WHERE cle_nom = ?`)
    .get(cleNom(nomComplet));

  for (const alias of donnees.alias || []) {
    ajouterAlias(employe.id, alias, donnees.source_alias || "SEED");
  }

  // Le nom tel qu'il figure sur la fiche est lui-meme un alias.
  if (donnees.nom_fiche && cleNom(donnees.nom_fiche) !== employe.cle_nom) {
    ajouterAlias(employe.id, donnees.nom_fiche, "FICHE");
  }

  return { employe, cree: info.changes > 0 };
}


function ajouterAlias(employeeId, alias, source) {
  const cle = cleNom(alias);

  if (!cle) {
    return null;
  }

  return db.prepare(`
    INSERT INTO employee_aliases (employee_id, alias, cle_alias, source)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(cle_alias) DO NOTHING
  `).run(employeeId, alias, cle, source || null);
}


// Seule la DRH dialogue avec le bot. Tout le monde peut deposer des
// documents, mais personne d'autre ne recoit de reponse, et personne
// d'autre ne peut declarer une permission au nom d'un tiers.
function comptesAutorisesParConfig() {
  return (process.env.LARK_RH_OPEN_ID || "")
    .split(",")
    .map((valeur) => valeur.trim())
    .filter(Boolean);
}


function estRH(expediteur = {}) {
  const autorises = comptesAutorisesParConfig();

  // Liste de configuration : le socle, qui ne depend d'aucune donnee saisie
  // et permet de reprendre la main si la base est mal renseignee.
  if (expediteur.open_id && autorises.includes(expediteur.open_id)) {
    return true;
  }

  // Habilitations accordees en cours de route. Elles portent sur un compte
  // Lark, jamais sur un nom : un libelle de profil se maquille, un open_id
  // non.
  if (expediteur.open_id) {
    const parCompte = db.prepare(`
      SELECT 1 FROM employees WHERE lark_open_id = ? AND role = 'RH'
    `).get(expediteur.open_id);

    if (parCompte) {
      return true;
    }
  }

  // Repli sur le nom uniquement tant qu'AUCUNE liste n'est configuree, pour
  // qu'une installation neuve ne soit pas verrouillee. Des que
  // LARK_RH_OPEN_ID est renseigne, le nom ne donne plus aucun acces.
  if (autorises.length || !expediteur.nom) {
    return false;
  }

  const { employe } = resoudreEmploye(expediteur.nom);

  return !!employe && employe.role === "RH";
}


// Comptes Lark ayant deja ecrit au bot et dont le nom de profil correspond a
// cet employe. C'est la seule facon de connaitre un open_id : Lark ne le
// livre qu'avec un message.
function comptesLarkPour(employeeId) {
  return db.prepare(`SELECT open_id, name FROM users WHERE name IS NOT NULL`)
    .all()
    .filter((compte) => resoudreEmploye(compte.name).employe?.id === employeeId);
}


function accorderRoleRH(employeeId, openId) {
  return db.prepare(`
    UPDATE employees SET role = 'RH', lark_open_id = ? WHERE id = ?
  `).run(openId, employeeId);
}


function retirerRoleRH(employeeId) {
  return db.prepare(`
    UPDATE employees SET role = NULL WHERE id = ?
  `).run(employeeId);
}


function listerRH() {
  const parConfig = comptesAutorisesParConfig();

  const enBase = db.prepare(`
    SELECT nom_complet, lark_open_id FROM employees
    WHERE role = 'RH' ORDER BY nom_complet
  `).all();

  return { parConfig, enBase };
}


// Memorise le compte Lark d'un employe des qu'il est reconnu, pour que
// l'identification cesse de dependre du libelle du profil.
function lierCompteLark(employeeId, openId) {
  if (!openId) {
    return null;
  }

  return db.prepare(`
    UPDATE employees SET lark_open_id = ? WHERE id = ?
  `).run(openId, employeeId);
}


function listerEmployes({ actifsSeulement = true } = {}) {
  return db.prepare(`
    SELECT * FROM employees
    ${actifsSeulement ? "WHERE actif = 1" : ""}
    ORDER BY COALESCE(ordre_fiche, 9999), nom_complet
  `).all();
}


// ---------------------------------------------------------------------------
// Absences, postes du soir, pointages
// ---------------------------------------------------------------------------

function absencePour(employeeId, date) {
  return db.prepare(`
    SELECT * FROM absences
    WHERE employee_id = ? AND date_debut <= ? AND date_fin >= ?
    ORDER BY id DESC LIMIT 1
  `).get(employeeId, date, date) || null;
}

function enregistrerAbsence(donnees) {
  return db.prepare(`
    INSERT INTO absences
      (employee_id, type, date_debut, date_fin, motif, declare_par)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    donnees.employee_id,
    donnees.type,
    donnees.date_debut,
    donnees.date_fin || donnees.date_debut,
    donnees.motif || null,
    donnees.declare_par || null
  );
}

function estDeSoir(employeeId, date) {
  return !!db.prepare(`
    SELECT 1 FROM shift_schedule
    WHERE employee_id = ? AND date = ? AND type_poste = 'SOIR'
  `).get(employeeId, date);
}

function enregistrerPosteDeSoir(employeeId, date, documentId) {
  return db.prepare(`
    INSERT INTO shift_schedule (employee_id, date, type_poste, source_document_id)
    VALUES (?, ?, 'SOIR', ?)
    ON CONFLICT(employee_id, date, type_poste) DO NOTHING
  `).run(employeeId, date, documentId || null);
}

// Une nouvelle lecture de la meme journee ENRICHIT la ligne, elle ne la
// remplace pas. Deux pertes s'en suivaient autrement :
//   - une fiche renvoyee moins lisible effacait une heure deja lue ;
//   - une correction de la DRH etait defaite par le reenvoi de la fiche.
// Une case que la nouvelle lecture ne dit pas laisse donc l'ancienne en
// place, et une case corrigee a la main n'est jamais retouchee.
function enregistrerPointage(donnees) {
  const existant = db.prepare(`
    SELECT * FROM attendance WHERE employee_id = ? AND date = ?
  `).get(donnees.employee_id, donnees.date);

  const corriges = new Set(
    (existant?.champs_corriges || "").split(",").filter(Boolean)
  );

  const fusionner = (champ) => {
    if (corriges.has(champ)) {
      return existant[champ];
    }

    return normaliserHeure(donnees[champ]) ?? existant?.[champ] ?? null;
  };

  const valeurs = {
    heure_arrivee: fusionner("heure_arrivee"),
    heure_depart: fusionner("heure_depart"),
    heure_depart_pause: fusionner("heure_depart_pause"),
    heure_retour_pause: fusionner("heure_retour_pause"),
  };

  // Une case corrigee a la main n'est plus incertaine, quoi qu'en dise la
  // nouvelle lecture.
  const incertains = (donnees.champs_incertains || []).filter(
    (champ) => !corriges.has(champ)
  );

  return db.prepare(`
    INSERT INTO attendance
      (employee_id, date, heure_arrivee, heure_depart, heure_depart_pause,
       heure_retour_pause, observation, source_document_id, certitude,
       champs_incertains)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(employee_id, date) DO UPDATE SET
      heure_arrivee = excluded.heure_arrivee,
      heure_depart = excluded.heure_depart,
      heure_depart_pause = excluded.heure_depart_pause,
      heure_retour_pause = excluded.heure_retour_pause,
      observation = COALESCE(excluded.observation, observation),
      source_document_id = excluded.source_document_id,
      certitude = excluded.certitude,
      champs_incertains = excluded.champs_incertains
  `).run(
    donnees.employee_id,
    donnees.date,
    valeurs.heure_arrivee,
    valeurs.heure_depart,
    valeurs.heure_depart_pause,
    valeurs.heure_retour_pause,
    donnees.observation || null,
    donnees.source_document_id || null,
    incertains.length ? "A_VERIFIER" : "CONFIRMEE",
    incertains.join(",") || null
  );
}

function pointagesDuJour(date) {
  return db.prepare(`
    SELECT a.*, e.nom_complet, e.nom_fiche, e.mode_travail,
           e.suivi_presence, e.ordre_fiche
    FROM attendance a
    JOIN employees e ON e.id = a.employee_id
    WHERE a.date = ?
  `).all(date);
}

const CHAMPS_CORRIGEABLES = new Set([
  "heure_arrivee",
  "heure_depart",
  "heure_depart_pause",
  "heure_retour_pause",
]);


function revuesEnAttente({ date = null, employeeId = null } = {}) {
  return db.prepare(`
    SELECT r.*, e.nom_complet
    FROM attendance_review r
    LEFT JOIN employees e ON e.id = (
      SELECT a.employee_id FROM attendance a
      WHERE a.date = r.date AND a.employee_id = COALESCE(?, a.employee_id)
      LIMIT 1
    )
    WHERE r.resolu = 0
      AND (? IS NULL OR r.date = ?)
    ORDER BY r.date, r.id
  `).all(employeeId, date, date);
}


// Applique une correction de la DRH sur une cellule, puis lève l'incertitude
// qui pesait dessus. La ligne est créée si la journée entière avait ete mise
// de cote, pour qu'une correction ne se perde jamais faute de support.
function corrigerPointage({ employee_id, date, champ, valeur, declare_par }) {
  if (!CHAMPS_CORRIGEABLES.has(champ)) {
    throw new Error(`Champ non corrigeable : ${champ}`);
  }

  const heure = normaliserHeure(valeur);

  if (valeur && !heure) {
    throw new Error(`Heure illisible : ${valeur}`);
  }

  db.prepare(`
    INSERT INTO attendance (employee_id, date, certitude)
    VALUES (?, ?, 'CONFIRMEE')
    ON CONFLICT(employee_id, date) DO NOTHING
  `).run(employee_id, date);

  db.prepare(`UPDATE attendance SET ${champ} = ? WHERE employee_id = ? AND date = ?`)
    .run(heure, employee_id, date);

  const ligne = db.prepare(`
    SELECT champs_incertains, champs_corriges FROM attendance
    WHERE employee_id = ? AND date = ?
  `).get(employee_id, date);

  const restants = (ligne?.champs_incertains || "")
    .split(",")
    .filter(Boolean)
    .filter((c) => c !== champ);

  // La correction est memorisee : un reenvoi ulterieur de la meme fiche ne
  // doit pas defaire ce que la DRH a tranche.
  const corriges = new Set(
    (ligne?.champs_corriges || "").split(",").filter(Boolean)
  );

  corriges.add(champ);

  db.prepare(`
    UPDATE attendance
    SET champs_incertains = ?, champs_corriges = ?, certitude = ?
    WHERE employee_id = ? AND date = ?
  `).run(
    restants.join(",") || null,
    [...corriges].join(","),
    restants.length ? "A_VERIFIER" : "CONFIRMEE",
    employee_id,
    date
  );

  // Ne clore que les revues portant sur CETTE personne ET CE champ. Filtrer
  // sur le seul motif fermait toutes les lignes en litige sur le meme champ
  // ce jour-la : corriger le depart d'une personne ne dit rien de celui des
  // autres. Le rapprochement se fait en JS, car nom_brut porte l'orthographe
  // de la fiche et non celle du registre.
  const candidates = db.prepare(`
    SELECT id, nom_brut, motif FROM attendance_review
    WHERE resolu = 0 AND date = ?
  `).all(date);

  // Le rapprochement passe par resoudreEmploye et donc par la table des
  // alias : la revue porte l'orthographe de la fiche (ETOUNA MARIE) quand
  // le registre porte le nom complet (MARIE SHARONE ETOUNA). Comparer les
  // cles normalisees directement echouerait sur toutes ces personnes.
  const aClore = candidates.filter(
    (revue) =>
      revue.motif.includes(champ) &&
      resoudreEmploye(revue.nom_brut).employe?.id === employee_id
  );

  const fermer = db.prepare(`UPDATE attendance_review SET resolu = 1 WHERE id = ?`);

  for (const revue of aClore) {
    fermer.run(revue.id);
  }

  return { heure, revues_closes: aClore.length, champs_restants: restants };
}


function signalerPourRevue(donnees) {
  return db.prepare(`
    INSERT INTO attendance_review
      (date, nom_brut, motif, passe_1, passe_2, source_document_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    donnees.date || null,
    donnees.nom_brut || null,
    donnees.motif,
    donnees.passe_1 || null,
    donnees.passe_2 || null,
    donnees.source_document_id || null
  );
}

module.exports = {
  normaliserNom,
  cleNom,
  resoudreEmploye,
  ajouterEmploye,
  ajouterAlias,
  listerEmployes,
  estRH,
  lierCompteLark,
  comptesLarkPour,
  accorderRoleRH,
  retirerRoleRH,
  listerRH,
  absencePour,
  enregistrerAbsence,
  estDeSoir,
  enregistrerPosteDeSoir,
  enregistrerPointage,
  pointagesDuJour,
  signalerPourRevue,
  revuesEnAttente,
  corrigerPointage,
};
