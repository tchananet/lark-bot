const fs = require("fs");
const { PDFParse } = require("pdf-parse");
const { Jimp } = require("jimp");

// ---------------------------------------------------------------------------
// Un PDF scanne, rendu en images
//
// OpenRouter exige 0,50 $ de solde disponible pour OUVRIR une piece jointe
// PDF -- c'est ce qui a bloque la lecture des fiches de presence. Une IMAGE,
// elle, n'est soumise a aucune condition de ce genre et ne coute que ses
// jetons : quelques centiemes de centime.
//
// Rendre les pages en JPEG contourne donc la contrainte, ouvre tous les
// modeles de vision plutot que la poignee qui accepte les fichiers, et reduit
// la charge utile : 8,4 Mo de PNG deviennent 330 Ko.
//
// Cela ne concerne que les documents SANS couche texte. Les comptes rendus
// des services, eux, sont lus directement par texte-pdf.js.
// ---------------------------------------------------------------------------

// Au-dela, le modele redimensionne lui-meme et on aura paye le transport
// pour rien. En deca, l'ecriture manuscrite devient illisible.
const COTE = Number(process.env.PDF_IMAGE_COTE || 1600);
const QUALITE = Number(process.env.PDF_IMAGE_QUALITE || 80);
const MAX_PAGES = Number(process.env.PDF_IMAGE_MAX_PAGES || 6);


async function reduire(dataUrl) {
  const image = await Jimp.read(Buffer.from(dataUrl.split(",")[1], "base64"));

  image.scaleToFit({ w: COTE, h: COTE });

  const jpeg = await image.getBuffer("image/jpeg", { quality: QUALITE });

  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}


// Rend chaque page du PDF en JPEG. Renvoie une liste de data URLs, une par
// page, dans l'ordre : une fiche de presence porte souvent deux journees,
// et chacune doit rester identifiable.
async function pagesEnImages(chemin) {
  const parseur = new PDFParse({ data: fs.readFileSync(chemin) });

  try {
    const rendu = await parseur.getScreenshot({ scale: 2 });
    const pages = (rendu.pages || []).slice(0, MAX_PAGES);

    const images = [];

    for (const page of pages) {
      if (page.dataUrl) {
        images.push(await reduire(page.dataUrl));
      }
    }

    return images;
  } finally {
    // Sans cela le rendu reste en memoire d'un document a l'autre et le
    // conteneur enfle jusqu'a se faire tuer.
    await parseur.destroy().catch(() => {});
  }
}

module.exports = { pagesEnImages, COTE, MAX_PAGES };
