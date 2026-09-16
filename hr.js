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
  ["employees", "role TEXT"],
  ["employees", "lark_open_id TEXT"],
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

  const info = db.prepare(`
    INSERT INTO employees
      (nom_complet, nom_fiche, cle_nom, service, poste, type_contrat,
       mode_travail, suivi_presence, ordre_fiche, role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cle_nom) DO UPDATE SET
      nom_fiche = COALESCE(excluded.nom_fiche, nom_fiche),
      service = COALESCE(excluded.service, service),
      mode_travail = excluded.mode_travail,
      suivi_presence = excluded.suivi_presence,
      role = COALESCE(excluded.role, role)
  `).run(
    nomComplet,
    donnees.nom_fiche || null,
    cleNom(nomComplet),
    donnees.service || null,
    donnees.poste || null,
    donnees.type_contrat || "INTERNE",
    donnees.mode_travail || "PRESENTIEL",
    donnees.suivi_presence === false ? 0 : 1,
    donnees.ordre_fiche || null,
    donnees.role || null
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
function estRH(expediteur = {}) {
  const autorises = (process.env.LARK_RH_OPEN_ID || "")
    .split(",")
    .map((valeur) => valeur.trim())
    .filter(Boolean);

  // Une liste explicite d'identifiants Lark fait autorite : c'est le seul
  // critere qu'un libelle de profil ne peut pas usurper.
  if (autorises.length) {
    return autorises.includes(expediteur.open_id);
  }

  if (expediteur.open_id) {
    const parCompte = db.prepare(`
      SELECT 1 FROM employees WHERE lark_open_id = ? AND role = 'RH'
    `).get(expediteur.open_id);

    if (parCompte) {
      return true;
    }
  }

  if (!expediteur.nom) {
    return false;
  }

  const { employe } = resoudreEmploye(expediteur.nom);

  return !!employe && employe.role === "RH";
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

function enregistrerPointage(donnees) {
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
      observation = excluded.observation,
      source_document_id = excluded.source_document_id,
      certitude = excluded.certitude,
      champs_incertains = excluded.champs_incertains
  `).run(
    donnees.employee_id,
    donnees.date,
    normaliserHeure(donnees.heure_arrivee),
    normaliserHeure(donnees.heure_depart),
    normaliserHeure(donnees.heure_depart_pause),
    normaliserHeure(donnees.heure_retour_pause),
    donnees.observation || null,
    donnees.source_document_id || null,
    donnees.certitude || "CONFIRMEE",
    (donnees.champs_incertains || []).join(",") || null
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
  absencePour,
  enregistrerAbsence,
  estDeSoir,
  enregistrerPosteDeSoir,
  enregistrerPointage,
  pointagesDuJour,
  signalerPourRevue,
};
