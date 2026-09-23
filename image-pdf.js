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
const ECHELLE = Number(process.env.PDF_IMAGE_ECHELLE || 2);


// Le rendu sort en PNG, format sans perte : une page A4 pese deux megaoctets
// pour un contenu qui tient dans trois cents kilooctets en JPEG. Le decodage
// lui-meme est gourmand -- pngjs a deja epuise la memoire sur une page rendue
// en trop grand -- d'ou l'echelle mesuree plus bas et ce repli.
async function reduire(dataUrl) {
  const brut = Buffer.from(dataUrl.split(",")[1], "base64");

  try {
    const image = await Jimp.read(brut);

    image.scaleToFit({ w: COTE, h: COTE });

    const jpeg = await image.getBuffer("image/jpeg", { quality: QUALITE });

    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch (erreur) {
    // Mieux vaut une image lourde qu'aucune image : le modele saura la lire,
    // elle coutera seulement quelques jetons de plus.
    console.warn(
      `[image-pdf] compression impossible (${erreur.message}), ` +
      `page envoyee telle quelle (${Math.round(brut.length / 1024)} Ko).`
    );

    return dataUrl;
  }
}


// Rend chaque page du PDF en JPEG. Renvoie une liste de data URLs, une par
// page, dans l'ordre : une fiche de presence porte souvent deux journees,
// et chacune doit rester identifiable.
async function pagesEnImages(chemin) {
  const parseur = new PDFParse({ data: fs.readFileSync(chemin) });

  try {
    // On extrait l'image DEJA presente dans le PDF plutot que de redessiner
    // la page. Une fiche scannee n'est rien d'autre qu'une photo posee sur
    // une page : la reprendre telle quelle ne perd rien.
    //
    // Redessiner passerait par skia en natif, qui a echoue ici meme ("Create
    // skia surface failed") et alourdirait l'image du conteneur. On ne s'en
    // sert qu'en dernier recours, pour un PDF sans image embarquee -- cas qui
    // ne se presente pas ici, un tel document ayant une couche texte lue bien
    // avant d'arriver jusqu'a nous.
    const extrait = await parseur.getImage();

    const images = [];

    for (const page of (extrait.pages || []).slice(0, MAX_PAGES)) {
      const plusGrande = (page.images || [])
        .filter((i) => i.dataUrl)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];

      if (plusGrande) {
        images.push(await reduire(plusGrande.dataUrl));
      }
    }

    if (images.length) {
      return images;
    }

    const rendu = await parseur.getScreenshot({ scale: ECHELLE });

    for (const page of (rendu.pages || []).slice(0, MAX_PAGES)) {
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
