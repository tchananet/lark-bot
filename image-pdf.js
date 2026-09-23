const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const executer = promisify(execFile);

// ---------------------------------------------------------------------------
// Un PDF scanne, rendu en images
//
// OpenRouter exige 0,50 $ de solde disponible pour OUVRIR une piece jointe
// PDF -- c'est ce qui a bloque la lecture des fiches de presence alors qu'il
// restait 0,28 $. Une IMAGE n'est soumise a aucune condition de ce genre, ne
// coute que ses jetons, et tous les modeles de vision l'acceptent.
//
// Le rendu passe par pdftoppm, de poppler : un binaire eprouve depuis vingt
// ans, appele en ligne de commande. Sur la fiche reelle du 21 et 22
// septembre, quatre pages en 877 millisecondes.
//
// La voie JavaScript qui l'a precede tenait mal : elle passait par une
// bibliotheque graphique native qui echouait a allouer sa surface, et le
// decodage PNG epuisait la memoire sur une page A4. Elle reste en secours
// pour les machines sans poppler -- un poste de developpement, typiquement.
//
// Cela ne concerne que les documents SANS couche texte. Les comptes rendus
// des services sont lus directement par texte-pdf.js, sans rien de tout ceci.
// ---------------------------------------------------------------------------

// 150 points par pouce sur une page A4 donne environ 1750 pixels de large :
// l'ecriture manuscrite reste nette, et le modele n'a pas a redimensionner.
const RESOLUTION = Number(process.env.PDF_IMAGE_DPI || 150);
const QUALITE = Number(process.env.PDF_IMAGE_QUALITE || 80);
const MAX_PAGES = Number(process.env.PDF_IMAGE_MAX_PAGES || 6);


async function parPoppler(chemin) {
  const dossier = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pdfimg-"));
  const prefixe = path.join(dossier, "page");

  try {
    await executer("pdftoppm", [
      "-jpeg",
      "-jpegopt", `quality=${QUALITE}`,
      "-r", String(RESOLUTION),
      "-f", "1",
      "-l", String(MAX_PAGES),
      chemin,
      prefixe,
    ]);

    // pdftoppm numerote page-1.jpg, page-2.jpg... et peut zero-remplir selon
    // le nombre de pages : on trie donc sur le numero, pas sur le nom.
    const fichiers = (await fs.promises.readdir(dossier))
      .filter((f) => f.endsWith(".jpg"))
      .sort((a, b) => Number(a.match(/(\d+)\.jpg$/)[1]) - Number(b.match(/(\d+)\.jpg$/)[1]));

    const images = [];

    for (const fichier of fichiers) {
      const octets = await fs.promises.readFile(path.join(dossier, fichier));

      images.push(`data:image/jpeg;base64,${octets.toString("base64")}`);
    }

    return images;
  } finally {
    await fs.promises.rm(dossier, { recursive: true, force: true }).catch(() => {});
  }
}


// Secours sans poppler : on reprend l'image deja presente dans le PDF. Une
// fiche scannee n'est rien d'autre qu'une photo posee sur une page.
async function parJavaScript(chemin) {
  const { PDFParse } = require("pdf-parse");
  const { Jimp } = require("jimp");

  const parseur = new PDFParse({ data: await fs.promises.readFile(chemin) });

  try {
    const extrait = await parseur.getImage();
    const images = [];

    for (const page of (extrait.pages || []).slice(0, MAX_PAGES)) {
      const plusGrande = (page.images || [])
        .filter((i) => i.dataUrl)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];

      if (!plusGrande) {
        continue;
      }

      const brut = Buffer.from(plusGrande.dataUrl.split(",")[1], "base64");

      try {
        const image = await Jimp.read(brut);

        image.scaleToFit({ w: 1600, h: 1600 });

        const jpeg = await image.getBuffer("image/jpeg", { quality: QUALITE });

        images.push(`data:image/jpeg;base64,${jpeg.toString("base64")}`);
      } catch (erreur) {
        // Mieux vaut une image lourde qu'aucune image.
        images.push(plusGrande.dataUrl);
      }
    }

    return images;
  } finally {
    await parseur.destroy().catch(() => {});
  }
}


async function pagesEnImages(chemin) {
  try {
    return await parPoppler(chemin);
  } catch (erreur) {
    console.warn(
      `[image-pdf] pdftoppm indisponible (${erreur.message.slice(0, 70)}), ` +
      `rendu par JavaScript.`
    );

    return parJavaScript(chemin);
  }
}

module.exports = { pagesEnImages, RESOLUTION, MAX_PAGES };
