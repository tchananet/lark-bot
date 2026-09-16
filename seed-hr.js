require("dotenv").config();

const { ajouterEmploye, listerEmployes } = require("./hr");

// Registre initial, repris de la fiche de presence vierge (ordre d'origine).
//
// Les alias ne sont PAS inventes : ce sont uniquement les formes reellement
// observees dans le planning du soir, dans les rapports quotidiens ou
// confirmees par la DRH. Ajouter des prenoms au hasard creerait de faux
// rapprochements avec des noms de clients cites dans les rapports.
const REGISTRE = [
  { nom_complet: "ADANA ASTHORI", alias: ["ASTRIDE", "ADANA ASTRIDE"] },
  { nom_complet: "ALIMATOU SADIA", alias: ["SADIA"] },
  { nom_complet: "BEN AZIR", alias: ["BEN"] },
  { nom_complet: "BINELI CYRILLE" },
  {
    nom_complet: "MARIE SHARONE ETOUNA",
    nom_fiche: "ETOUNA MARIE",
    alias: ["MARIE S.", "MARIE SHARONE"],
  },
  { nom_complet: "MEDJO LOIC" },
  { nom_complet: "FEZZE WILLIAM", alias: ["WILLIAM"] },
  { nom_complet: "NDIANG AVIGAIL", alias: ["AVIGAIL"] },
  { nom_complet: "NGA ISABELLE", alias: ["ISABELLE"] },
  { nom_complet: "NGAKEU GLORIA" },
  { nom_complet: "OBELE HENRI", mode_travail: "DISTANCE" },
  { nom_complet: "TAKAM VANAULD", mode_travail: "DISTANCE" },
  { nom_complet: "TCHANA NETACY" },
  { nom_complet: "TIAKO ALFRED", alias: ["TIAKO ALFRED RUSSEL"] },
  { nom_complet: "YENE STEPHANE" },
  {
    nom_complet: "SERVICE RENNOVA",
    type_contrat: "PRESTATAIRE",
    poste: "Entretien",
  },
  {
    nom_complet: "MARIAH JONES NKOUAKEP",
    nom_fiche: "MARIA JONES",
    alias: ["MARIAH J.", "MARIAH JONES", "MARIAH"],
  },
  { nom_complet: "MAEVA BATEG" },
  { nom_complet: "EVINEBA CLAUDE", alias: ["EVINEBA"] },
  { nom_complet: "EBOUDOU CECILE", alias: ["CECILE"] },
  // Present sur la fiche imprimee, absent du modele Word : le registre doit
  // pouvoir accueillir les arrivees avant que le modele soit reedite.
  { nom_complet: "SOH ROMUALD" },
];

function importer() {
  let crees = 0;

  REGISTRE.forEach((entree, index) => {
    const { cree } = ajouterEmploye({ ...entree, ordre_fiche: index + 1 });

    if (cree) {
      crees++;
    }
  });

  const total = listerEmployes().length;

  console.log(`Registre importe : ${crees} employe(s) cree(s), ${total} au total.`);

  return { crees, total };
}

module.exports = { REGISTRE, importer };

if (require.main === module) {
  importer();
}
