const fs = require("fs");
const { PDFParse } = require("pdf-parse");

// ---------------------------------------------------------------------------
// Le texte deja present dans le PDF
//
// Les comptes rendus des services sont des exports Word : ils portent une
// couche de texte, verifiable a la presence de polices embarquees. Les lire
// ne demande aucun modele, aucun reseau, aucun quota -- quelques dizaines de
// millisecondes en local.
//
// Seule la fiche de presence est une vraie photo, sans une seule police :
// celle-la demande un modele de vision, et elle seule.
//
// C'est donc la premiere chose a essayer. Ce qui en sort est identique a ce
// que le service a redige, sans le risque qu'un modele relise de travers.
// ---------------------------------------------------------------------------

// En dessous, ce n'est pas un document : c'est le residu d'une page scannee,
// un numero de page, un filigrane. Mieux vaut passer au modele de vision.
const MINIMUM = Number(process.env.PDF_TEXTE_MINIMUM || 200);

function exploitable(texte) {
  const nu = (texte || "").trim();

  if (nu.length < MINIMUM) {
    return false;
  }

  // Un PDF dont la couche texte est corrompue rend des suites de symboles.
  // Sans ce controle, on servirait du charabia au modele redacteur en
  // croyant lui donner un compte rendu.
  const lettres = (nu.match(/[a-zA-ZÀ-ÿ]/g) || []).length;

  return lettres / nu.length > 0.5;
}


async function lireTextePdf(chemin) {
  const parseur = new PDFParse({ data: fs.readFileSync(chemin) });

  try {
    const resultat = await parseur.getText();
    const texte = (resultat.text || "").trim();

    return exploitable(texte) ? texte : null;
  } finally {
    // Sans cela le processus garde les pages en memoire d'un rapport a
    // l'autre, et le conteneur enfle jusqu'a se faire tuer.
    await parseur.destroy().catch(() => {});
  }
}

module.exports = { lireTextePdf, exploitable };
