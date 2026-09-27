const { db } = require("./database");

// ---------------------------------------------------------------------------
// Ce que le bot a deja ecrit, et qu'il pouvait oublier
//
// Jusqu'ici seul le NUMERO d'un rapport etait garde en base. Le texte, lui,
// n'existait que dans un .docx sur le disque -- illisible pour le programme.
// Consequence : "combien de ventes en septembre ?" ou "compare cette semaine
// a la precedente" etaient hors de portee, alors que la reponse avait deja
// ete ecrite, parfois plusieurs fois.
//
// Le contenu est donc conserve deux fois : le JSON tel qu'il a ete produit,
// pour pouvoir le relire champ par champ, et un rendu a plat pour la
// recherche. C'est du texte, quelques kilo-octets par jour.
//
// Rien de tout cela ne part dans le contexte du modele. Il va le chercher par
// un outil, et seulement quand la question l'exige.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS rapports_produits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    portee TEXT NOT NULL,
    date_debut TEXT NOT NULL,
    date_fin TEXT,

    numero TEXT,
    titre TEXT,
    chemin TEXT,

    document TEXT NOT NULL,
    texte TEXT NOT NULL,

    cree_le DATETIME DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (portee, date_debut)
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_rapports_date
    ON rapports_produits(date_debut)
`);


// Un rapport regenere remplace le precedent : c'est le meme rapport, corrige.
// Garder les deux ferait ressortir deux verites pour une seule journee.
function memoriserRapport({
  portee,
  date_debut,
  date_fin = null,
  numero = null,
  titre = null,
  chemin = null,
  document,
  texte,
}) {
  if (!portee || !date_debut || !document) {
    return null;
  }

  return db.prepare(`
    INSERT INTO rapports_produits
      (portee, date_debut, date_fin, numero, titre, chemin, document, texte)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(portee, date_debut) DO UPDATE SET
      date_fin = excluded.date_fin,
      numero   = excluded.numero,
      titre    = excluded.titre,
      -- Un rapport regenere sans chemin ne doit pas perdre le fichier deja
      -- ecrit : on garde l ancien plutot que de le remplacer par rien.
      chemin   = COALESCE(excluded.chemin, chemin),
      document = excluded.document,
      texte    = excluded.texte,
      cree_le  = CURRENT_TIMESTAMP
  `).run(
    portee,
    date_debut,
    date_fin,
    numero,
    titre,
    chemin,
    JSON.stringify(document),
    texte || ""
  );
}


function rapportsProduits({ du = null, au = null, portee = null } = {}) {
  const conditions = [];
  const valeurs = [];

  if (du) {
    conditions.push("date_debut >= ?");
    valeurs.push(du);
  }

  if (au) {
    conditions.push("date_debut <= ?");
    valeurs.push(au);
  }

  if (portee) {
    conditions.push("portee = ?");
    valeurs.push(portee);
  }

  const ou = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  return db.prepare(`
    SELECT portee, date_debut, date_fin, numero, titre, chemin,
           LENGTH(texte) AS caracteres, cree_le
    FROM rapports_produits
    ${ou}
    ORDER BY date_debut DESC
  `).all(...valeurs);
}


function rapport({ portee = "JOURNEE", date }) {
  const ligne = db.prepare(`
    SELECT * FROM rapports_produits WHERE portee = ? AND date_debut = ?
  `).get(portee, date);

  if (!ligne) {
    return null;
  }

  return { ...ligne, document: JSON.parse(ligne.document) };
}


// Un extrait autour de chaque occurrence, pas le rapport entier : une
// recherche qui renvoie six rapports complets coute plus cher que la question
// ne le vaut, et noie la reponse.
function extraits(texte, mot, largeur = 220, maximum = 3) {
  const trouves = [];
  const cible = texte.toLowerCase();
  const cherche = mot.toLowerCase();

  let position = cible.indexOf(cherche);

  while (position !== -1 && trouves.length < maximum) {
    const debut = Math.max(0, position - Math.floor(largeur / 2));
    const fin = Math.min(texte.length, position + cherche.length + largeur / 2);

    trouves.push(
      (debut > 0 ? "…" : "") +
      texte.slice(debut, fin).replace(/\s+/g, " ").trim() +
      (fin < texte.length ? "…" : "")
    );

    position = cible.indexOf(cherche, position + cherche.length);
  }

  return trouves;
}


// Recherche par mots, pas par sens : a un rapport par jour, un LIKE suffit et
// ne coute rien. Des embeddings seraient plus fins et se paieraient a chaque
// question, pour un corpus qui tient dans une poignee de megaoctets.
function chercherDansRapports({ mots, du = null, au = null, limite = 6 }) {
  const termes = String(mots || "")
    .split(/[\s,;]+/)
    .map((mot) => mot.trim())
    .filter((mot) => mot.length > 2);

  if (!termes.length) {
    return { termes: [], resultats: [] };
  }

  const conditions = termes.map(() => "texte LIKE ?");
  const valeurs = termes.map((terme) => `%${terme}%`);

  if (du) {
    conditions.push("date_debut >= ?");
    valeurs.push(du);
  }

  if (au) {
    conditions.push("date_debut <= ?");
    valeurs.push(au);
  }

  const lignes = db.prepare(`
    SELECT portee, date_debut, date_fin, numero, texte
    FROM rapports_produits
    WHERE ${conditions.join(" AND ")}
    ORDER BY date_debut DESC
    LIMIT ?
  `).all(...valeurs, limite);

  return {
    termes,
    resultats: lignes.map((ligne) => ({
      portee: ligne.portee,
      date_debut: ligne.date_debut,
      date_fin: ligne.date_fin,
      numero: ligne.numero,
      extraits: termes.flatMap((terme) => extraits(ligne.texte, terme)),
    })),
  };
}


module.exports = {
  memoriserRapport,
  rapportsProduits,
  rapport,
  chercherDansRapports,
  extraits,
};
