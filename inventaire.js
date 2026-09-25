const fs = require("fs");

const { db } = require("./database");
const { prepareDailyBatch } = require("./batch");
const { faitsDePonctualite } = require("./presence");

// ---------------------------------------------------------------------------
// Ce que le bot a REELLEMENT en main pour une journee
//
// "Dis-moi ce qui est disponible pour lundi et mardi" partait en
// DEMANDE_RAPPORT : le bot fabriquait un document au lieu de repondre. Or la
// question precede le rapport -- on veut savoir s'il vaut la peine de le
// lancer, et ce qui manque encore.
//
// Cette reponse ne coute rien : ni modele, ni lecture de fichier. Elle lit la
// base et le disque, et rien d'autre. Une question d'etat ne doit jamais
// declencher un travail.
// ---------------------------------------------------------------------------

const TZ = process.env.DB_TZ_OFFSET || "+1 hours";

const NUMERO = db.prepare(`SELECT number FROM report_numbers WHERE report_date = ?`);

const EXPEDITEUR = db.prepare(`
  SELECT COALESCE(u.name, m.sender_id) AS nom,
         DATETIME(m.created_at, ?) AS heure
  FROM messages m
  LEFT JOIN users u ON u.open_id = m.sender_id
  WHERE m.message_id = ?
`);

// Le texte deja extrait : sa presence dit que la piece est lisible, sans
// avoir a la relire.
const TEXTE = db.prepare(`
  SELECT moteur, caracteres FROM document_textes WHERE file_path = ?
`);


function inventaire(date) {
  const batch = prepareDailyBatch(date);
  const ponctualite = faitsDePonctualite(date);

  const pieces = [];

  for (const message of batch.messages) {
    for (const piece of message.attachments) {
      const info = EXPEDITEUR.get(TZ, message.message_id) || {};
      const connu = piece.file_path ? TEXTE.get(piece.file_path) : null;

      pieces.push({
        nom: piece.name || "(sans nom)",
        expediteur: info.nom || "?",
        recu: info.heure || null,
        surLeDisque: !!(piece.path && fs.existsSync(piece.path)),
        lu: !!connu,
        moteur: connu ? connu.moteur : null,
        caracteres: connu ? connu.caracteres : null,
      });
    }
  }

  const numero = NUMERO.get(date);

  return {
    date,
    fenetre: batch.fenetre,
    messages: batch.total_messages,
    textes: batch.messages.filter((m) => (m.text || "").trim()).length,
    pieces,
    fiche_recue: ponctualite.fiche_recue,
    effectif: ponctualite.effectif_suivi,
    retards: ponctualite.retards.filter((r) => !r.justifie).length,
    absences: ponctualite.absences_non_justifiees.length,
    rapport_numero: numero ? numero.number : null,
  };
}


// Rendu en francais, pour la conversation. Le ton est celui d'un etat des
// lieux : ce qu'on a, ce qu'on n'a pas, et ce qui empeche d'aller plus loin.
function enFrancais(etat, nomDuJour) {
  const lignes = [`${nomDuJour} — fenêtre du ${etat.fenetre.debut} au ${etat.fenetre.fin}`];

  if (!etat.pieces.length && !etat.messages) {
    lignes.push("  Rien n'est arrivé pour cette journée.");

    return lignes.join("\n");
  }

  if (etat.pieces.length) {
    lignes.push(`  ${etat.pieces.length} document(s) :`);

    for (const piece of etat.pieces) {
      const etatLecture = !piece.surLeDisque
        ? "fichier absent du disque"
        : piece.lu
          ? `lu (${piece.moteur}, ${piece.caracteres} caractères)`
          : "pas encore lu";

      lignes.push(`    • ${piece.nom}`);
      lignes.push(`      ${piece.expediteur}, reçu le ${piece.recu} — ${etatLecture}`);
    }
  } else {
    lignes.push("  Aucun document.");
  }

  if (etat.textes) {
    lignes.push(`  ${etat.textes} message(s) écrits directement dans la conversation.`);
  }

  lignes.push(
    etat.fiche_recue
      ? `  Fiche de présence : reçue — ${etat.retards} retard(s) et ` +
        `${etat.absences} absence(s) non justifiés sur ${etat.effectif} personnes.`
      : "  Fiche de présence : NON REÇUE. La ponctualité manquera au rapport."
  );

  lignes.push(
    etat.rapport_numero
      ? `  Rapport : déjà produit sous le N° ${String(etat.rapport_numero).padStart(3, "0")}.`
      : "  Rapport : pas encore produit."
  );

  return lignes.join("\n");
}

module.exports = { inventaire, enFrancais };
