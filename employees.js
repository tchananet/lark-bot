require("dotenv").config();

const fs = require("fs");
const { db } = require("./database");

db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    matricule TEXT UNIQUE,
    nom_complet TEXT NOT NULL,
    nom_normalise TEXT NOT NULL UNIQUE,

    service TEXT,
    poste TEXT,

    actif INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Variantes d'ecriture confirmees par un humain. C'est la memoire du
// systeme : une fois "ETOUNOI MARIE" rattache a la bonne personne, la
// question ne se repose plus.
db.exec(`
  CREATE TABLE IF NOT EXISTS employee_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    alias_normalise TEXT NOT NULL UNIQUE,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (employee_id)
      REFERENCES employees(id)
      ON DELETE CASCADE
  )
`);


// Les documents internes designent les personnes par leur nom usuel
// ("BEN", "ASTRIDE") ou par prenom + initiale du nom ("MARIE S."), jamais
// par leur nom complet. Ces colonnes sont ajoutees separement pour ne pas
// casser une base existante.
const colonnesExistantes = new Set(
  db.prepare("PRAGMA table_info(employees)").all().map((c) => c.name)
);

for (const [colonne, type] of [
  ["prenom", "TEXT"],
  ["nom_famille", "TEXT"],
  ["nom_usuel", "TEXT"],
  // "individuel" ou "collectif" : SERVICE RENNOVA signe comme une equipe
  // et doit etre suivi sans entrer dans la ponctualite individuelle.
  ["type", "TEXT DEFAULT 'individuel'"],
]) {
  if (!colonnesExistantes.has(colonne)) {
    db.exec(`ALTER TABLE employees ADD COLUMN ${colonne} ${type}`);
  }
}


// Civilites et titres a retirer : ils varient d'un document a l'autre et
// n'identifient personne.
const CIVILITES = new Set([
  "M", "MR", "MME", "MLLE", "MELLE", "MONSIEUR", "MADAME", "MADEMOISELLE",
  "DR", "PR", "ING", "ME",
]);


// "Mme ETOUNDI Marie-Claire" -> "CLAIRE ETOUNDI MARIE"
//
// Les jetons sont tries pour que l'ordre nom / prenom cesse d'avoir de
// l'importance : les documents RH alternent sans cesse entre
// "ETOUNDI Marie" et "Marie ETOUNDI".
function normaliserNom(nom) {
  if (!nom) {
    return "";
  }

  const sansAccents = String(nom)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

  const jetons = sansAccents
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((jeton) => jeton !== "" && !CIVILITES.has(jeton));

  return jetons.sort().join(" ");
}


function jetonsDe(nomNormalise) {
  return nomNormalise === "" ? [] : nomNormalise.split(" ");
}


// Distance de Levenshtein, pour rattraper les fautes de frappe et les
// erreurs d'OCR ("ETOUNOI" au lieu de "ETOUNDI").
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let precedente = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const courante = [i];

    for (let j = 1; j <= b.length; j++) {
      const cout = a[i - 1] === b[j - 1] ? 0 : 1;

      courante[j] = Math.min(
        courante[j - 1] + 1,
        precedente[j] + 1,
        precedente[j - 1] + cout
      );
    }

    precedente = courante;
  }

  return precedente[b.length];
}


function similarite(a, b) {
  const longueur = Math.max(a.length, b.length);
  return longueur === 0 ? 1 : 1 - levenshtein(a, b) / longueur;
}


// "MARIE S." -> { jetons: ["MARIE"], initiales: ["S"] }
// "WILLIAM"  -> { jetons: ["WILLIAM"], initiales: [] }
//
// Un jeton d une seule lettre est une initiale de nom de famille, pas un
// prenom : c est ce qui permet de distinguer deux Marie.
function analyserNomDocument(nom) {
  const sansAccents = String(nom || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

  const bruts = sansAccents
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((j) => j !== "" && !CIVILITES.has(j));

  return {
    jetons: bruts.filter((j) => j.length > 1),
    initiales: bruts.filter((j) => j.length === 1),
  };
}


const SEUIL_PROBABLE = Number(process.env.EMPLOYEE_MATCH_SEUIL || 0.85);


function employesActifs() {
  return db.prepare(`
    SELECT id, matricule, nom_complet, nom_normalise,
           prenom, nom_famille, nom_usuel, type, service, poste
    FROM employees
    WHERE actif = 1
  `).all();
}


// Ne renvoie JAMAIS un employe cree a la volee. Un nom non reconnu
// ressort en "inconnu" ou "ambigu" et devra passer par une validation
// humaine : c'est ce qui evite de fabriquer des employes fantomes a
// partir d'une seule erreur de lecture.
function matchEmployee(nomBrut) {
  const normalise = normaliserNom(nomBrut);

  if (normalise === "") {
    return { statut: "inconnu", nom_brut: nomBrut, nom_normalise: "" };
  }

  const base = { nom_brut: nomBrut, nom_normalise: normalise };

  const exact = db.prepare(`
    SELECT id, matricule, nom_complet, nom_normalise, service, poste
    FROM employees
    WHERE nom_normalise = ? AND actif = 1
  `).get(normalise);

  if (exact) {
    return { ...base, statut: "exact", employee: exact };
  }

  const parAlias = db.prepare(`
    SELECT e.id, e.matricule, e.nom_complet, e.nom_normalise, e.service, e.poste
    FROM employee_aliases a
    JOIN employees e ON e.id = a.employee_id
    WHERE a.alias_normalise = ? AND e.actif = 1
  `).get(normalise);

  if (parAlias) {
    return { ...base, statut: "alias", employee: parAlias };
  }

  const actifs = employesActifs();

  // Nom usuel tel qu'il figure dans les documents internes : "WILLIAM",
  // "BEN", ou prenom + initiale du nom de famille comme "MARIE S.".
  const doc = analyserNomDocument(nomBrut);

  if (doc.jetons.length >= 1) {
    const parUsuel = actifs.filter((employe) => {
      const prenom = normaliserNom(employe.prenom);
      const usuel = normaliserNom(employe.nom_usuel);
      const famille = normaliserNom(employe.nom_famille);

      const jetonsReconnus = doc.jetons.every(
        (jeton) => jeton === prenom || jeton === usuel || jeton === famille
      );

      if (!jetonsReconnus) {
        return false;
      }

      // L'initiale peut viser le nom de famille comme un second prenom :
      // "MARIE S." designe Marie Sharone ETOUNA. On la cherche donc parmi
      // tous les composants du nom, hors ceux deja consommes par les
      // jetons lus.
      const restants = jetonsDe(employe.nom_normalise).filter(
        (jeton) => !doc.jetons.includes(jeton)
      );

      return doc.initiales.every((initiale) =>
        restants.some((jeton) => jeton.startsWith(initiale))
      );
    });

    if (parUsuel.length === 1) {
      return {
        ...base,
        statut: "probable",
        employee: parUsuel[0],
        score: 1,
        raison: doc.initiales.length
          ? "prenom et initiale du nom de famille"
          : "nom usuel",
      };
    }

    if (parUsuel.length > 1) {
      return {
        ...base,
        statut: "ambigu",
        candidats: parUsuel,
        raison: "nom usuel partage par " + parUsuel.length + " employes",
      };
    }
  }

  const jetonsCherches = jetonsDe(normalise);

  // Les scans de fiches de presence sont souvent rognes a gauche : la
  // colonne des noms perd ses premieres lettres ("ANA ASTHORI" au lieu de
  // "ADANA ASTHORI"). Un jeton tronque reste donc compatible avec le jeton
  // complet dont il est la fin.
  const jetonsCompatibles = (lu, attendu) =>
    lu === attendu ||
    (lu.length >= 3 && attendu.endsWith(lu)) ||
    (attendu.length >= 3 && lu.endsWith(attendu)) ||
    (lu.length >= 4 && attendu.startsWith(lu)) ||
    (attendu.length >= 4 && lu.startsWith(attendu));

  const couvre = (source, cible) =>
    source.every((jeton) => cible.some((autre) => jetonsCompatibles(jeton, autre)));

  // Deux situations symetriques, toutes deux courantes :
  //  - le document ne porte qu'une partie du nom ("ASTHORI") ;
  //  - le document porte un prenom de plus que le registre
  //    ("TIAKO ALFRED RUSSEL" pour "TIAKO ALFRED").
  const sousEnsembles = actifs.filter((employe) => {
    const jetonsEmploye = jetonsDe(employe.nom_normalise);

    return (
      couvre(jetonsCherches, jetonsEmploye) ||
      couvre(jetonsEmploye, jetonsCherches)
    );
  });

  if (sousEnsembles.length === 1) {
    return {
      ...base,
      statut: "probable",
      employee: sousEnsembles[0],
      score: 1,
      raison: "nom partiel ou tronque correspondant a un seul employe",
    };
  }

  if (sousEnsembles.length > 1) {
    return {
      ...base,
      statut: "ambigu",
      candidats: sousEnsembles,
      raison: "nom partiel correspondant a " + sousEnsembles.length + " employes",
    };
  }

  // Un seul jeton intact suffit s'il n'appartient qu'a une personne. Sur
  // une fiche rognee a gauche, le nom de famille est ampute mais le prenom
  // reste lisible : "N AZIR" perd "BE" mais "AZIR" ne designe qu'un employe.
  const parJetonUnique = new Map();

  for (const jeton of jetonsCherches.filter((j) => j.length >= 4)) {
    const trouves = actifs.filter((employe) =>
      jetonsDe(employe.nom_normalise).some(
        (autre) =>
          autre === jeton ||
          (jeton.length >= 4 && autre.startsWith(jeton)) ||
          (autre.length >= 4 && jeton.startsWith(autre))
      )
    );

    if (trouves.length === 1) {
      parJetonUnique.set(trouves[0].id, trouves[0]);
    }
  }

  if (parJetonUnique.size === 1) {
    return {
      ...base,
      statut: "probable",
      employee: [...parJetonUnique.values()][0],
      score: 1,
      raison: "jeton discriminant unique dans le registre",
    };
  }

  if (parJetonUnique.size > 1) {
    return {
      ...base,
      statut: "ambigu",
      candidats: [...parJetonUnique.values()],
      raison: "jetons discriminants pointant vers plusieurs employes",
    };
  }

  const classes = actifs
    .map((employe) => ({
      employe,
      score: similarite(normalise, employe.nom_normalise),
    }))
    .sort((a, b) => b.score - a.score);

  const meilleur = classes[0];

  if (meilleur && meilleur.score >= SEUIL_PROBABLE) {
    const second = classes[1];

    if (second && meilleur.score - second.score < 0.05) {
      return {
        ...base,
        statut: "ambigu",
        candidats: [meilleur.employe, second.employe],
        raison: "deux employes aussi proches l'un que l'autre",
      };
    }

    return {
      ...base,
      statut: "probable",
      employee: meilleur.employe,
      score: Number(meilleur.score.toFixed(3)),
      raison: "rapprochement approximatif (faute de frappe ou OCR)",
    };
  }

  return {
    ...base,
    statut: "inconnu",
    meilleur_score: meilleur ? Number(meilleur.score.toFixed(3)) : null,
  };
}


// Enregistre une variante validee par un humain.
function confirmerAlias(nomBrut, employeeId) {
  const normalise = normaliserNom(nomBrut);

  if (normalise === "") {
    throw new Error("Nom vide, alias impossible");
  }

  return db.prepare(`
    INSERT INTO employee_aliases (employee_id, alias_normalise, source)
    VALUES (?, ?, 'validation')
    ON CONFLICT(alias_normalise) DO UPDATE SET
      employee_id = excluded.employee_id
  `).run(employeeId, normalise);
}


function upsertEmployee(data) {
  const normalise = normaliserNom(data.nom_complet);

  if (normalise === "") {
    throw new Error(`Nom invalide : ${JSON.stringify(data.nom_complet)}`);
  }

  return db.prepare(`
    INSERT INTO employees (
      matricule, nom_complet, nom_normalise,
      prenom, nom_famille, nom_usuel, type, service, poste, actif
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)

    ON CONFLICT(nom_normalise) DO UPDATE SET
      matricule = COALESCE(excluded.matricule, matricule),
      nom_complet = excluded.nom_complet,
      prenom = COALESCE(excluded.prenom, prenom),
      nom_famille = COALESCE(excluded.nom_famille, nom_famille),
      nom_usuel = COALESCE(excluded.nom_usuel, nom_usuel),
      type = COALESCE(excluded.type, type),
      service = COALESCE(excluded.service, service),
      poste = COALESCE(excluded.poste, poste),
      updated_at = CURRENT_TIMESTAMP
  `).run(
    data.matricule || null,
    String(data.nom_complet).trim(),
    normalise,
    data.prenom || null,
    data.nom_famille || null,
    data.nom_usuel || null,
    data.type || "individuel",
    data.service || null,
    data.poste || null
  );
}


// CSV attendu : nom_complet;service;poste;matricule
// Le point-virgule est le separateur par defaut d'Excel en francais.
function importerCsv(chemin, separateur = ";") {
  const lignes = fs.readFileSync(chemin, "utf8")
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((ligne) => ligne.trim() !== "");

  if (lignes.length === 0) {
    return { importes: 0, ignores: [] };
  }

  const entetes = lignes[0]
    .split(separateur)
    .map((e) => e.trim().toLowerCase());

  const colonne = (...noms) => {
    for (const nom of noms) {
      const index = entetes.indexOf(nom);
      if (index !== -1) return index;
    }
    return -1;
  };

  const iNom = Math.max(0, colonne("nom_complet", "nom complet", "nom"));
  const iService = colonne("service");
  const iPoste = colonne("poste");
  const iMatricule = colonne("matricule");
  const iPrenom = colonne("prenom", "prénom");
  const iFamille = colonne("nom_famille", "nom de famille");
  const iUsuel = colonne("nom_usuel", "nom usuel");
  const iType = colonne("type");

  let importes = 0;
  const ignores = [];

  for (const ligne of lignes.slice(1)) {
    const champs = ligne.split(separateur).map((c) => c.trim());

    try {
      upsertEmployee({
        nom_complet: champs[iNom],
        service: iService === -1 ? null : champs[iService],
        poste: iPoste === -1 ? null : champs[iPoste],
        matricule: iMatricule === -1 ? null : champs[iMatricule],
        prenom: iPrenom === -1 ? null : champs[iPrenom],
        nom_famille: iFamille === -1 ? null : champs[iFamille],
        nom_usuel: iUsuel === -1 ? null : champs[iUsuel],
        type: iType === -1 ? null : champs[iType],
      });

      importes++;
    } catch (error) {
      ignores.push({ ligne, raison: error.message });
    }
  }

  return { importes, ignores };
}


module.exports = {
  normaliserNom,
  analyserNomDocument,
  matchEmployee,
  confirmerAlias,
  upsertEmployee,
  importerCsv,
  employesActifs,
  similarite,
};


if (require.main === module) {
  const [commande, ...args] = process.argv.slice(2);

  if (commande === "import") {
    const resultat = importerCsv(args[0]);
    console.log(`${resultat.importes} employes importes.`);
    for (const ignore of resultat.ignores) {
      console.log("  ignore :", ignore.ligne, "->", ignore.raison);
    }
  } else if (commande === "match") {
    console.log(JSON.stringify(matchEmployee(args.join(" ")), null, 2));
  } else if (commande === "liste") {
    for (const employe of employesActifs()) {
      console.log(
        `${String(employe.id).padStart(3)} | ` +
        `${employe.nom_complet.padEnd(26)} | ` +
        `${(employe.service || "-").padEnd(22)} | ${employe.nom_normalise}`
      );
    }
  } else {
    console.log("Usage : node employees.js import <fichier.csv>");
    console.log("        node employees.js match <nom>");
    console.log("        node employees.js liste");
  }
}
