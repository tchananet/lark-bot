const { db } = require("./database");

// ---------------------------------------------------------------------------
// Le fil, et les consignes
//
// Ce sont les deux seules choses qui partent dans le contexte du modele a
// CHAQUE message. Tout le reste -- rapports passes, documents recus,
// pointages -- dort en base et n'est cherche que par un outil, quand la
// question l'exige.
//
// La distinction n'est pas un detail d'implementation : ce qui est dans le
// contexte se paie a chaque tour, meme pour repondre "bonjour". Le fil est
// donc plafonne, et les consignes doivent rester courtes.
//
// Jusqu'ici le bot n'avait aucun fil : chaque message etait traite seul. « Et
// pour mardi ? » ne voulait rien dire, et il ne se souvenait pas de ce qu'il
// venait de repondre.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS conversation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    contenu TEXT,

    -- Les appels d'outils demandes par le modele, tels quels. Sans eux le fil
    -- relu ne tient pas : un resultat d'outil sans l'appel qui l'a demande
    -- est incomprehensible pour le modele.
    appels TEXT,

    -- Pour un resultat d'outil : le nom de l'outil, et l'identifiant de
    -- l'appel auquel il repond. L'identifiant est ce qui relie le resultat a
    -- la demande ; sans lui l'API refuse le fil.
    outil TEXT,
    appel_id TEXT,

    cree_le DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_conversation_chat
    ON conversation(chat_id, id)
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS consignes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    texte TEXT NOT NULL UNIQUE,
    actif INTEGER NOT NULL DEFAULT 1,
    cree_le DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);


// Les consignes de depart : ce que la DRH a deja dit et qui doit tenir. Elles
// etaient ecrites en dur dans le code par moi ; ici, elles peuvent s'ajouter
// sans redeployer.
//
// Volontairement peu nombreuses et courtes : elles se paient a chaque message.
const CONSIGNES_INITIALES = [
  "Ne jamais conclure a une absence sans me demander : une fiche de presence " +
    "ne dit ni les permanences, ni les conges poses la veille, ni les missions.",
  "Aucune remarque d'intendance dans un rapport destine a la Direction " +
    "Generale -- signatures manquantes, cases vides, ecriture illisible. Cela " +
    "se dit en message, pas dans le document.",
  "Plusieurs images dans un meme message sont une seule fiche de presence, " +
    "et couvrent donc une seule journee.",
  "Ne jamais citer une personne, un chiffre ou une date qui ne figure pas " +
    "dans ce qui t'a ete fourni. Une reponse courte qui dit ne pas savoir " +
    "vaut mieux qu'une reponse complete et fausse.",
];

const semer = db.prepare(
  `INSERT INTO consignes (texte) VALUES (?) ON CONFLICT(texte) DO NOTHING`
);

for (const texte of CONSIGNES_INITIALES) {
  semer.run(texte);
}


function consignes() {
  return db
    .prepare(`SELECT texte FROM consignes WHERE actif = 1 ORDER BY id`)
    .all()
    .map((ligne) => ligne.texte);
}


function ajouterConsigne(texte) {
  const propre = String(texte || "").trim();

  return propre ? semer.run(propre) : null;
}


function ajouter({
  chat_id,
  role,
  contenu = null,
  appels = null,
  outil = null,
  appel_id = null,
}) {
  return db.prepare(`
    INSERT INTO conversation (chat_id, role, contenu, appels, outil, appel_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    chat_id,
    role,
    contenu,
    appels ? JSON.stringify(appels) : null,
    outil,
    appel_id
  );
}


// Le fil remis au modele, plafonne.
//
// Sans plafond, la conversation grossit sans fin et chaque message coute plus
// cher que le precedent. On garde les derniers tours, et on coupe au premier
// message d'utilisateur : commencer un fil par un resultat d'outil orphelin
// desoriente le modele plus que de ne rien lui donner.
function fil(chatId, { tours = 14, heures = 12 } = {}) {
  const lignes = db.prepare(`
    SELECT role, contenu, appels, outil, appel_id
    FROM conversation
    WHERE chat_id = ?
      AND cree_le >= DATETIME('now', ?)
    ORDER BY id DESC
    LIMIT ?
  `).all(chatId, `-${heures} hours`, tours).reverse();

  const premier = lignes.findIndex((ligne) => ligne.role === "user");

  if (premier === -1) {
    return [];
  }

  const gardees = lignes.slice(premier);

  // Un appel d'outil sans son resultat laisse le fil en suspens et l'API le
  // refuse. Si le plafond a coupe juste apres la demande, on retire la
  // demande aussi.
  while (gardees.length) {
    const dernier = gardees[gardees.length - 1];

    if (dernier.role === "assistant" && dernier.appels) {
      gardees.pop();
      continue;
    }

    break;
  }

  return gardees.map((ligne) => {
    if (ligne.role === "tool") {
      return {
        role: "tool",
        tool_call_id: ligne.appel_id,
        name: ligne.outil,
        content: ligne.contenu || "",
      };
    }

    if (ligne.role === "assistant") {
      const message = { role: "assistant", content: ligne.contenu || "" };

      if (ligne.appels) {
        message.tool_calls = JSON.parse(ligne.appels);
      }

      return message;
    }

    return { role: ligne.role, content: ligne.contenu || "" };
  });
}


function oublier(chatId) {
  return db.prepare(`DELETE FROM conversation WHERE chat_id = ?`).run(chatId);
}


module.exports = {
  ajouter,
  fil,
  oublier,
  consignes,
  ajouterConsigne,
  CONSIGNES_INITIALES,
};
