const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");

// ---------------------------------------------------------------------------
// Generation du rapport Word
//
// Le document de reference sert de COQUILLE : on conserve telles quelles ses
// en-tetes, ses pieds de page, son logo, ses marges et ses styles, et on ne
// remplace que le corps.
//
// Pourquoi pas docxtemplater : il faudrait d'abord truffer le document de
// balises {…} a la main, et le nombre de sections varie d'un jour a l'autre
// (seuls les services ayant transmis apparaissent). Generer le corps donne
// ce controle sans toucher a la maquette.
// ---------------------------------------------------------------------------

const MODELE_PAR_DEFAUT =
  process.env.RAPPORT_MODELE_DOCX ||
  path.join(__dirname, "modeles", "rapport-consolide.docx");

const POLICE = process.env.RAPPORT_POLICE || "Times New Roman";

// Word compte les tailles en demi-points : 24 = 12 pt.
const TAILLE_TEXTE = 24;
const TAILLE_TITRE = 28;
const TAILLE_SECTION = 26;
const TAILLE_TABLEAU = 20;


function echapper(valeur) {
  return String(valeur === null || valeur === undefined ? "" : valeur)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


function paragraphe(texte, options = {}) {
  const {
    gras = false,
    taille = TAILLE_TEXTE,
    alignement = null,
    apres = 120,
    italique = false,
    couleur = null,
  } = options;

  // Un saut de ligne dans le texte devient un vrai retour a la ligne Word.
  const morceaux = String(texte === null || texte === undefined ? "" : texte).split("\n");

  const runs = morceaux
    .map((m, i) => (i ? "<w:br/>" : "") + `<w:t xml:space="preserve">${echapper(m)}</w:t>`)
    .join("");

  return (
    "<w:p><w:pPr>" +
    `<w:spacing w:after="${apres}"/>` +
    (alignement ? `<w:jc w:val="${alignement}"/>` : "") +
    "</w:pPr><w:r><w:rPr>" +
    `<w:rFonts w:ascii="${POLICE}" w:hAnsi="${POLICE}"/>` +
    (gras ? "<w:b/>" : "") +
    (italique ? "<w:i/>" : "") +
    (couleur ? `<w:color w:val="${couleur}"/>` : "") +
    `<w:sz w:val="${taille}"/><w:szCs w:val="${taille}"/>` +
    "</w:rPr>" + runs + "</w:r></w:p>"
  );
}


function cellule(texte, largeur, gras) {
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${largeur}" w:type="dxa"/>` +
    "<w:tcBorders>" +
    ["top", "left", "bottom", "right"]
      .map((c) => `<w:${c} w:val="single" w:sz="4" w:color="808080"/>`)
      .join("") +
    "</w:tcBorders></w:tcPr>" +
    paragraphe(texte, { gras, taille: TAILLE_TABLEAU, apres: 0 }) +
    "</w:tc>"
  );
}


// Largeur utile d'une page A4 avec les marges par defaut, en twips.
const LARGEUR_UTILE = 9072;

function tableau(entetes, lignes, proportions) {
  const largeurs = proportions.map((p) => Math.round(LARGEUR_UTILE * p));

  const ligneXml = (valeurs, gras) =>
    "<w:tr>" + valeurs.map((v, i) => cellule(v, largeurs[i], gras)).join("") + "</w:tr>";

  return (
    "<w:tbl><w:tblPr>" +
    `<w:tblW w:w="${LARGEUR_UTILE}" w:type="dxa"/>` +
    '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>' +
    "</w:tblPr><w:tblGrid>" +
    largeurs.map((l) => `<w:gridCol w:w="${l}"/>`).join("") +
    "</w:tblGrid>" +
    ligneXml(entetes, true) +
    lignes.map((l) => ligneXml(l, false)).join("") +
    "</w:tbl>"
  );
}


// ---------------------------------------------------------------------------
// Corps du rapport quotidien
// ---------------------------------------------------------------------------

function corpsQuotidien(d) {
  const bloc = [];
  const ajouter = (...x) => bloc.push(...x);

  ajouter(
    paragraphe(d.numero, { gras: true }),
    paragraphe(`${d.ville}, le ${d.date_redaction}`, { apres: 360 }),
    paragraphe(`RAPPORT JOURNALIER CONSOLIDÉ DES ACTIVITÉS – ${d.titre_date}`, {
      gras: true, taille: TAILLE_TITRE, alignement: "center", apres: 280,
    }),
    paragraphe(d.intro, { apres: 280 })
  );

  let n = 1;
  const titreSection = (libelle) =>
    paragraphe(`${String(n++).padStart(2, "0")} ${libelle}`, {
      gras: true, taille: TAILLE_SECTION, apres: 140,
    });

  ajouter(titreSection("Synthèse générale"));

  if (d.synthese.length) {
    ajouter(
      tableau(
        ["Indicateur", "Résultat", "Lecture"],
        d.synthese.map((s) => [s.libelle, s.valeur, s.lecture]),
        [0.34, 0.16, 0.5]
      ),
      paragraphe("", { apres: 240 })
    );
  } else {
    ajouter(paragraphe("Aucun indicateur chiffré transmis ce jour.", { apres: 240 }));
  }

  ajouter(titreSection("Ponctualité"), paragraphe(d.ponctualite, { apres: 280 }));

  for (const service of d.services) {
    ajouter(titreSection(service.nom));

    for (const l of service.lignes) {
      ajouter(
        paragraphe(
          `• ${l.libelle} — ${l.description}` +
          (l.suite ? ` | Suite attendue : ${l.suite}` : "")
        )
      );
    }

    ajouter(paragraphe("", { apres: 160 }));
  }

  ajouter(titreSection("Points d'attention"));

  for (const p of d.points_attention) {
    ajouter(paragraphe(`• [${p.priorite}] ${p.intitule} — ${p.constat}`));
  }

  // Ce qui n'est pas arrive est dit, jamais comble.
  for (const manque of d.donnees_manquantes || []) {
    ajouter(paragraphe(`• ${manque}`, { italique: true, couleur: "595959" }));
  }

  ajouter(paragraphe("", { apres: 160 }), titreSection("Actions prioritaires"));

  // Un intitule seul, sans une ligne dessous, se lit comme un defaut
  // d impression. On dit plutot ce qu il en est.
  if (d.actions.length) {
    for (const a of d.actions) {
      ajouter(paragraphe(`• ${a.service} — ${a.action}`));
    }
  } else {
    ajouter(paragraphe("Aucune action prioritaire retenue pour cette journée."));
  }

  ajouter(paragraphe("", { apres: 160 }), titreSection("Conclusion"));

  for (const para of d.conclusion) {
    ajouter(paragraphe(para));
  }

  ajouter(
    paragraphe(
      "Le présent rapport est soumis à l'appréciation de la Direction Générale " +
      "pour orientations et suites à donner.",
      { apres: 400 }
    ),
    paragraphe(d.signature, { gras: true, alignement: "right" })
  );

  return bloc.join("");
}


// ---------------------------------------------------------------------------
// Corps du rapport hebdomadaire
// ---------------------------------------------------------------------------

function corpsHebdomadaire(d) {
  const bloc = [];
  const ajouter = (...x) => bloc.push(...x);

  ajouter(
    paragraphe(d.numero, { gras: true }),
    paragraphe(`${d.ville}, le ${d.date_redaction}`, { apres: 360 }),
    paragraphe(`RAPPORT HEBDOMADAIRE CONSOLIDÉ DES SERVICES — ${d.titre_periode}`, {
      gras: true, taille: TAILLE_TITRE, alignement: "center", apres: 280,
    }),
    paragraphe(d.intro, { apres: 280 })
  );

  let n = 1;
  const titreSection = (libelle) =>
    paragraphe(`${String(n++).padStart(2, "0")} ${libelle}`, {
      gras: true, taille: TAILLE_SECTION, apres: 140,
    });

  ajouter(
    titreSection("Synthèse exécutive"),
    tableau(
      ["Axe", "Constat hebdomadaire", "Point de vigilance / suite"],
      d.axes.map((a) => [a.axe, a.constat, a.vigilance]),
      [0.22, 0.42, 0.36]
    ),
    paragraphe("", { apres: 240 }),

    titreSection("Indicateurs commerciaux consolidés"),
    tableau(
      ["Date", "Showroom", "Proformas / ventes", "Call Center", "Relances / anomalies"],
      d.indicateurs.map((i) => [
        i.date, i.showroom, i.proformas_ventes, i.call_center, i.relances,
      ]),
      [0.1, 0.22, 0.16, 0.28, 0.24]
    )
  );

  // La ligne de lecture sous le tableau : ce que les chiffres racontent.
  if (d.lecture) {
    ajouter(paragraphe(`Lecture : ${d.lecture}`, { apres: 240 }));
  } else {
    ajouter(paragraphe("", { apres: 240 }));
  }

  if ((d.chantiers_it || []).length) {
    ajouter(
      titreSection("Service Informatique — consolidation"),
      tableau(
        ["Chantier", "Avancement", "Suite"],
        d.chantiers_it.map((c) => [c.chantier, c.avancement, c.suite]),
        [0.24, 0.44, 0.32]
      ),
      paragraphe("", { apres: 240 })
    );
  }

  if ((d.sav_rh || []).length) {
    ajouter(
      titreSection("SAV et suivi RH"),
      tableau(
        ["Volet", "Situation consolidée", "Suite"],
        d.sav_rh.map((s) => [s.volet, s.situation, s.suite]),
        [0.18, 0.5, 0.32]
      ),
      paragraphe("", { apres: 240 })
    );
  }

  ajouter(titreSection("Priorités de la semaine suivante"));

  if ((d.priorites || []).length) {
    ajouter(
      tableau(
        ["N°", "Action", "Responsable"],
        d.priorites.map((p, i) => [String(i + 1), p.action, p.responsable]),
        [0.07, 0.68, 0.25]
      )
    );
  } else {
    ajouter(paragraphe("Aucune priorité particulière retenue pour la semaine suivante."));
  }

  // Ce qui n'est pas arrive est dit, jamais comble.
  for (const manque of d.donnees_manquantes || []) {
    ajouter(paragraphe(`• ${manque}`, { italique: true, couleur: "595959" }));
  }

  ajouter(paragraphe("", { apres: 240 }), titreSection("Conclusion"));

  for (const para of d.conclusion) {
    ajouter(paragraphe(para));
  }

  ajouter(
    paragraphe(
      "Le présent rapport est soumis à l'appréciation de la Direction Générale " +
      "pour orientations et suites à donner.",
      { apres: 400 }
    ),
    paragraphe(d.signature, { gras: true, alignement: "right" })
  );

  return bloc.join("");
}



// ---------------------------------------------------------------------------
// Assemblage
// ---------------------------------------------------------------------------

function rendre(donnees, options = {}) {
  const modele = options.modele || MODELE_PAR_DEFAUT;

  if (!fs.existsSync(modele)) {
    throw new Error(
      `Modele Word introuvable : ${modele}. ` +
      `Deposez-y le rapport de reference, ses en-tetes et son logo seront repris.`
    );
  }

  const zip = new PizZip(fs.readFileSync(modele));
  const documentXml = zip.file("word/document.xml").asText();

  // On conserve le sectPr d'origine : il porte les references vers les
  // en-tetes et pieds de page, donc le logo et les mentions legales.
  const sectPr = (documentXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/) || [""])[0];

  const attributsBody = (documentXml.match(/<w:body[^>]*>/) || ["<w:body>"])[0];

  const corps =
    donnees.type === "HEBDOMADAIRE"
      ? corpsHebdomadaire(donnees)
      : corpsQuotidien(donnees);

  const nouveau = documentXml.replace(
    /<w:body[^>]*>[\s\S]*<\/w:body>/,
    `${attributsBody}${corps}${sectPr}</w:body>`
  );

  zip.file("word/document.xml", nouveau);

  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}


function ecrire(donnees, chemin, options = {}) {
  fs.writeFileSync(chemin, rendre(donnees, options));
  return chemin;
}

module.exports = { rendre, ecrire, MODELE_PAR_DEFAUT };
