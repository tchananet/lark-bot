require("dotenv").config();

const fs = require("fs");
const path = require("path");

const { ajouterEmploye, ajouterAlias, resoudreEmploye, listerEmployes } = require("./hr");

// ---------------------------------------------------------------------------
// Import du registre du personnel depuis un CSV
//
// Le registre vivait dans seed-hr.js, donc dans le code : une embauche
// demandait un commit. Il vit desormais dans un fichier que la DRH edite.
//
// Colonnes attendues, separees par des points-virgules :
//   nom_complet;nom_famille;prenom;nom_usuel;type;service;poste;civilite;mode_travail
// Les deux dernieres sont facultatives.
//
//   type      : individuel | collectif (RENNOVA est une societe de menage,
//               inscrite sous son nom : pas de civilite, pas de prenom)
//   civilite  : M. | Mme. Laissee vide, aucune civilite n'est employee dans
//               les rapports : mieux vaut n'en mettre aucune que se tromper.
//   mode_travail : PRESENTIEL | DISTANCE
// ---------------------------------------------------------------------------

const CHEMIN_PAR_DEFAUT =
  process.env.RH_FICHIER_EMPLOYES || path.join(__dirname, "employes.csv");

const CIVILITES_VALIDES = new Set(["M.", "Mme", "M", "MME", "MME."]);

// Formes relevees dans les documents reels et absentes du CSV. Le planning
// du soir ecrit MARIE S. et MARIAH J. ; la fiche de presence imprimee porte
// ADANA ASTHORI, sans le E final du registre. Sans ces equivalences, ces
// personnes cessent d'etre reconnues.
//
// Le CSV reste la source : ces formes ne font que s'y ajouter, et la colonne
// alias permet d'en declarer d'autres sans toucher au code.
const ALIAS_OBSERVES = {
  "ADANA ASTHORIE": ["ADANA ASTHORI", "ASTRIDE", "ADANA ASTRIDE"],
  "ETOUNA MARIE SHARONE": ["ETOUNA MARIE", "MARIE S.", "MARIE SHARONE"],
  "MARIA JONES": ["MARIAH J.", "MARIAH JONES", "MARIAH JONES NKOUAKEP"],
  "TIAKO ALFRED": ["TIAKO ALFRED RUSSEL"],
};

function normaliserCivilite(valeur) {
  const brut = String(valeur || "").trim();

  if (!brut) {
    return null;
  }

  if (!CIVILITES_VALIDES.has(brut) && !CIVILITES_VALIDES.has(brut.toUpperCase())) {
    return null;
  }

  return /^mme/i.test(brut) ? "Mme" : "M.";
}


function lireCsv(chemin) {
  const lignes = fs.readFileSync(chemin, "utf8")
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim());

  if (!lignes.length) {
    return [];
  }

  const entetes = lignes[0].split(";").map((e) => e.trim().toLowerCase());

  return lignes.slice(1).map((ligne) => {
    const valeurs = ligne.split(";");
    const enregistrement = {};

    entetes.forEach((cle, i) => {
      enregistrement[cle] = (valeurs[i] || "").trim();
    });

    return enregistrement;
  });
}


function importer(chemin = CHEMIN_PAR_DEFAUT) {
  if (!fs.existsSync(chemin)) {
    throw new Error(`Fichier du personnel introuvable : ${chemin}`);
  }

  const entrees = lireCsv(chemin);
  const sansCivilite = [];

  let crees = 0;
  let index = 0;

  for (const e of entrees) {
    if (!e.nom_complet) {
      continue;
    }

    index++;

    const collectif = /collectif/i.test(e.type || "");
    const civilite = collectif ? null : normaliserCivilite(e.civilite);

    if (!collectif && !civilite) {
      sansCivilite.push(e.nom_complet);
    }

    // Le nom d'usage et le prenom sont des alias : le planning du soir ecrit
    // ASTRIDE ou MARIE S. la ou la fiche de presence ecrit le nom complet.
    // La colonne alias accepte plusieurs formes separees par des virgules.
    const alias = [
      e.nom_usuel,
      e.prenom,
      ...String(e.alias || "").split(",").map((a) => a.trim()),
      ...(ALIAS_OBSERVES[e.nom_complet.toUpperCase().trim()] || []),
    ].filter(Boolean);

    const { cree, employe } = ajouterEmploye({
      nom_complet: e.nom_complet,
      nom_fiche: e.nom_fiche || null,
      service: e.service || null,
      poste: e.poste || null,
      type_contrat: collectif ? "PRESTATAIRE" : "INTERNE",
      mode_travail: /distance/i.test(e.mode_travail || "") ? "DISTANCE" : "PRESENTIEL",
      civilite,
      ordre_fiche: index,
      alias,
      source_alias: "CSV",
    });

    if (cree) {
      crees++;
    }
  }

  const total = listerEmployes().length;

  console.log(`Registre importe depuis ${path.basename(chemin)}`);
  console.log(`  ${entrees.length} ligne(s) lue(s), ${crees} employe(s) cree(s), ${total} au total.`);

  if (sansCivilite.length) {
    console.log(
      `\n  ${sansCivilite.length} personne(s) sans civilite renseignee.\n` +
      `  Les rapports les nommeront sans M. ni Mme, ce qui reste correct :\n` +
      `  ${sansCivilite.join(", ")}`
    );
  }

  return { lues: entrees.length, crees, total, sansCivilite };
}

module.exports = { importer, lireCsv, normaliserCivilite, CHEMIN_PAR_DEFAUT };

if (require.main === module) {
  importer(process.argv[2]);
}
