const { db } = require("./database");

// ---------------------------------------------------------------------------
// Rien ne s'ecrit sans que la DRH l'ait dit
//
// Un outil qui ecrit ne peut pas s'executer au moment ou le modele le demande.
// Il depose une PROPOSITION, que la DRH accepte ou refuse au tour suivant.
//
// Le piege evident : le modele peut demander l'action puis la confirmer dans
// le meme souffle, et la confirmation ne vaut plus rien. Une consigne ne
// protege pas de cela -- on l'a vu avec les six absences fabriquees du 19
// septembre, ou "n'invente jamais" n'a rien empeche.
//
// La garde est donc arithmetique. Chaque proposition retient le nombre de
// messages que la DRH a envoyes dans ce salon au moment ou elle est nee. Elle
// ne peut etre executee que si ce nombre a AUGMENTE depuis : autrement dit, si
// un etre humain a parle entre la demande et l'accord. Le modele peut appeler
// confirmer_action autant qu'il veut dans son propre tour, il sera refuse.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS actions_en_attente (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    chat_id TEXT NOT NULL,
    outil TEXT NOT NULL,
    args TEXT NOT NULL,
    resume TEXT NOT NULL,

    statut TEXT NOT NULL DEFAULT 'EN_ATTENTE',

    -- Le nombre de messages de la DRH dans ce salon au moment de la
    -- proposition. C'est cette valeur, et elle seule, qui empeche le modele
    -- de se donner son propre accord.
    tour_a_la_proposition INTEGER NOT NULL,

    cree_le DATETIME DEFAULT CURRENT_TIMESTAMP,
    tranche_le DATETIME,
    resultat TEXT
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_actions_chat
    ON actions_en_attente(chat_id, statut)
`);

// Ces motifs partent a la DRH, pas dans un journal : ils s'ecrivent en
// francais correct.
const LIBELLES_STATUT = {
  EN_ATTENTE: "en attente",
  EXECUTEE: "déjà exécutée",
  ANNULEE: "déjà annulée",
  ECHOUEE: "déjà tentée, sans succès",
};


// Une proposition oubliee ne doit pas pouvoir etre executee trois jours plus
// tard sur un simple "oui" qui portait sur autre chose.
const MINUTES_DE_VALIDITE = Number(process.env.ACTION_VALIDITE_MINUTES || 60);


// Le nombre de messages que la DRH a envoyes dans ce salon. Il sert d'horloge
// humaine : il n'avance que quand une personne ecrit.
function tourHumain(chatId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM conversation WHERE chat_id = ? AND role = 'user'
  `).get(chatId).n;
}


function proposer({ chat_id, outil, args, resume }) {
  const info = db.prepare(`
    INSERT INTO actions_en_attente
      (chat_id, outil, args, resume, tour_a_la_proposition)
    VALUES (?, ?, ?, ?, ?)
  `).run(chat_id, outil, JSON.stringify(args), resume, tourHumain(chat_id));

  return { id: info.lastInsertRowid, resume };
}


function enAttente(chatId) {
  return db.prepare(`
    SELECT id, outil, args, resume, cree_le, tour_a_la_proposition
    FROM actions_en_attente
    WHERE chat_id = ?
      AND statut = 'EN_ATTENTE'
      AND cree_le >= DATETIME('now', ?)
    ORDER BY id
  `).all(chatId, `-${MINUTES_DE_VALIDITE} minutes`).map((ligne) => ({
    ...ligne,
    args: JSON.parse(ligne.args),
  }));
}


function action(id) {
  const ligne = db.prepare(
    `SELECT * FROM actions_en_attente WHERE id = ?`
  ).get(id);

  return ligne ? { ...ligne, args: JSON.parse(ligne.args) } : null;
}


// Le seul chemin vers une ecriture. Il refuse plus souvent qu'il n'accepte,
// et c'est le but.
function autoriser(id, chatId) {
  const proposition = action(id);

  if (!proposition) {
    return { autorise: false, motif: `Aucune proposition n° ${id}.` };
  }

  if (proposition.chat_id !== chatId) {
    return {
      autorise: false,
      motif: "Cette proposition vient d'une autre conversation.",
    };
  }

  if (proposition.statut !== "EN_ATTENTE") {
    return {
      autorise: false,
      motif:
        `Proposition n° ${id} ` +
        `${LIBELLES_STATUT[proposition.statut] || proposition.statut}.`,
    };
  }

  const perimee = db.prepare(`
    SELECT cree_le < DATETIME('now', ?) AS vieille
    FROM actions_en_attente WHERE id = ?
  `).get(`-${MINUTES_DE_VALIDITE} minutes`, id).vieille;

  if (perimee) {
    return {
      autorise: false,
      motif:
        `Proposition n° ${id} trop ancienne (plus de ` +
        `${MINUTES_DE_VALIDITE} minutes). Redemande-la.`,
    };
  }

  // Le coeur de la garde : un humain doit avoir parle entre la proposition et
  // l'accord.
  if (tourHumain(chatId) <= proposition.tour_a_la_proposition) {
    return {
      autorise: false,
      motif:
        "La DRH n'a pas encore répondu à cette proposition. Une action ne " +
        "peut pas être confirmée dans le même tour que sa demande : présente-" +
        "la et attends sa réponse.",
    };
  }

  return { autorise: true, proposition };
}


function conclure(id, statut, resultat = null) {
  return db.prepare(`
    UPDATE actions_en_attente
    SET statut = ?, tranche_le = CURRENT_TIMESTAMP, resultat = ?
    WHERE id = ? AND statut = 'EN_ATTENTE'
  `).run(
    statut,
    resultat === null ? null : JSON.stringify(resultat).slice(0, 4000),
    id
  );
}


function annuler(id, chatId) {
  const proposition = action(id);

  if (!proposition || proposition.chat_id !== chatId) {
    return { annule: false, motif: `Aucune proposition n° ${id} ici.` };
  }

  if (proposition.statut !== "EN_ATTENTE") {
    return {
      annule: false,
      motif:
        `Proposition n° ${id} ` +
        `${LIBELLES_STATUT[proposition.statut] || proposition.statut}.`,
    };
  }

  conclure(id, "ANNULEE");

  return { annule: true, resume: proposition.resume };
}


module.exports = {
  LIBELLES_STATUT,
  proposer,
  enAttente,
  action,
  autoriser,
  conclure,
  annuler,
  tourHumain,
  MINUTES_DE_VALIDITE,
};
