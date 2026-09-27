const path = require("path");

const {
  db,
  texteConnu,
  localToday,
  localReportDate,
  reportWindow,
} = require("./database");

const { faitsDePonctualite } = require("./presence");
const { inventaire, enFrancais: etatEnFrancais } = require("./inventaire");
const { resoudreEmploye, listerEmployes, revuesEnAttente } = require("./hr");
const { questionsOuvertes } = require("./arbitrage");
const { rapportsProduits, rapport, chercherDansRapports } = require("./memoire");
const { etatDesAttendus } = require("./attendus");
const { prepareDailyBatch } = require("./batch");

// ---------------------------------------------------------------------------
// Ce que l'assistant peut CONSULTER
//
// Le bot fonctionnait par aiguillage : un classificateur rangeait chaque
// message dans une case parmi dix, puis un gestionnaire figé s'exécutait. Deux
// questions dans une phrase n'en produisaient qu'une réponse, et « est-ce
// possible ? » a suffi pour publier un rapport hebdomadaire dans le groupe --
// une action irréversible, en réponse à une question.
//
// Ces outils remplacent l'aiguillage. Le modèle choisit quoi appeler, et peut
// en appeler plusieurs. Aucun n'écrit quoi que ce soit : ils lisent la base et
// le disque. Se renseigner ne doit jamais rien déclencher.
//
// Les traitements déterministes -- lecture des fiches à deux moteurs,
// confrontation, recadrage des pages d'un même envoi, validateurs du rapport,
// garde des absences -- restent en dessous, inchangés. Ce sont eux qui rendent
// le bot digne de confiance ; un modèle qui redéciderait lui-même les dates
// referait toutes les fautes qu'on a corrigées.
// ---------------------------------------------------------------------------

const JOUR = { type: "string", description: "Journée au format AAAA-MM-JJ" };


function lundiDe(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const jour = d.getUTCDay();

  d.setUTCDate(d.getUTCDate() - (jour === 0 ? 6 : jour - 1));

  return d.toISOString().slice(0, 10);
}


function decalerJours(date, n) {
  const d = new Date(`${date}T00:00:00Z`);

  d.setUTCDate(d.getUTCDate() + n);

  return d.toISOString().slice(0, 10);
}


const OUTILS = [
  // -------------------------------------------------------------------------
  {
    nom: "aujourdhui",
    description:
      "La date du jour, la dernière journée dont la fenêtre de collecte est " +
      "fermée (et donc la seule rapportable), et les bornes de la semaine. " +
      "À appeler avant toute question contenant « aujourd'hui », « hier », " +
      "« cette semaine » ou un jour de la semaine. Une journée dont la " +
      "collecte est encore ouverte ne peut pas être rapportée, et une " +
      "semaine non terminée ne peut pas donner de bilan hebdomadaire.",
    parametres: { type: "object", properties: {} },

    executer() {
      const today = localToday();
      const journee = localReportDate();
      const lundi = lundiDe(today);

      return {
        date_du_jour: today,
        derniere_journee_reportable: journee,
        fenetre_de_collecte: reportWindow(journee),
        semaine_en_cours: { lundi, dimanche: decalerJours(lundi, 6) },
        semaine_precedente: {
          lundi: decalerJours(lundi, -7),
          dimanche: decalerJours(lundi, -1),
        },
        // Une semaine non terminée ne peut pas donner un bilan hebdomadaire
        // complet : le dire évite d'en produire un qui se plaindra lui-même
        // de journées manquantes.
        semaine_en_cours_terminee: decalerJours(lundi, 6) < today,
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    nom: "etat_journee",
    description:
      "Ce que le bot a réellement en main pour une journée : documents reçus " +
      "et lus, comptes rendus attendus qui manquent, fiche de présence, " +
      "numéro du rapport s'il a déjà été produit. Ne déclenche aucun travail " +
      "et ne coûte rien. À utiliser pour répondre « qu'est-ce qui est " +
      "disponible ? » avant d'envisager de produire quoi que ce soit.",
    parametres: {
      type: "object",
      properties: { date: JOUR },
      required: ["date"],
    },

    executer({ date }) {
      const etat = inventaire(date);

      return {
        date,
        fenetre: etat.fenetre,
        documents: etat.pieces.map((piece) => ({
          nom: piece.nom,
          expediteur: piece.expediteur,
          recu: piece.recu,
          lu: piece.lu,
          moteur: piece.moteur,
          caracteres: piece.caracteres,
        })),
        messages_ecrits: etat.textes,
        comptes_rendus_manquants: (etat.attendus.manquants || [])
          .map((a) => a.libelle),
        fiche_de_presence: etat.fiche_recue ? "reçue" : "non reçue",
        effectif_suivi: etat.effectif,
        retards_non_justifies: etat.retards,
        absences_non_justifiees: etat.absences,
        rapport_deja_produit: etat.rapport_numero
          ? `N° ${String(etat.rapport_numero).padStart(3, "0")}`
          : null,
        resume: etatEnFrancais(etat, date),
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    nom: "rapports_disponibles",
    description:
      "Les rapports DÉJÀ produits sur une période, quotidiens et " +
      "hebdomadaires. Répond à « quels rapports sont disponibles ? » sans " +
      "rien produire.",
    parametres: {
      type: "object",
      properties: {
        du: JOUR,
        au: JOUR,
        portee: {
          type: "string",
          enum: ["JOURNEE", "SEMAINE"],
          description: "Facultatif : ne garder qu'un type de rapport.",
        },
      },
    },

    executer({ du = null, au = null, portee = null }) {
      const produits = rapportsProduits({ du, au, portee });

      return {
        periode: { du, au },
        nombre: produits.length,
        rapports: produits.map((r) => ({
          portee: r.portee,
          journee: r.date_debut,
          jusquau: r.date_fin,
          numero: r.numero,
          produit_le: r.cree_le,
          fichier: r.chemin ? path.basename(r.chemin) : null,
        })),
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    nom: "lire_rapport",
    description:
      "Le texte intégral d'un rapport déjà produit. Volumineux : ne " +
      "l'appeler que si un extrait ne suffit pas.",
    parametres: {
      type: "object",
      properties: {
        date: JOUR,
        portee: { type: "string", enum: ["JOURNEE", "SEMAINE"] },
      },
      required: ["date"],
    },

    executer({ date, portee = "JOURNEE" }) {
      const trouve = rapport({ portee, date });

      if (!trouve) {
        return { trouve: false, message: `Aucun rapport ${portee} pour le ${date}.` };
      }

      return {
        trouve: true,
        portee: trouve.portee,
        journee: trouve.date_debut,
        numero: trouve.numero,
        produit_le: trouve.cree_le,
        texte: trouve.texte,
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    nom: "chercher_dans_rapports",
    description:
      "Cherche des mots dans tous les rapports déjà produits et rend des " +
      "extraits. C'est la mémoire du bot : à utiliser pour « combien de " +
      "ventes en septembre ? », « qu'est-ce qui bloquait la semaine " +
      "dernière ? », ou pour comparer deux périodes.",
    parametres: {
      type: "object",
      properties: {
        mots: {
          type: "string",
          description:
            "Mots à chercher, séparés par des espaces. Tous doivent figurer " +
            "dans le rapport. Préférer des mots précis : « ventes », " +
            "« véhicule », un nom de client.",
        },
        du: JOUR,
        au: JOUR,
      },
      required: ["mots"],
    },

    executer({ mots, du = null, au = null }) {
      return chercherDansRapports({ mots, du, au });
    },
  },

  // -------------------------------------------------------------------------
  {
    nom: "pointages",
    description:
      "Les pointages d'une journée, personne par personne, avec les retards " +
      "et absences déjà calculés. Les absences dites « non justifiées » sont " +
      "des cases vides sur la fiche : elles n'établissent rien tant que la " +
      "DRH ne les a pas tranchées.",
    parametres: {
      type: "object",
      properties: { date: JOUR },
      required: ["date"],
    },

    executer({ date }) {
      const faits = faitsDePonctualite(date);

      if (!faits.fiche_recue) {
        return {
          date,
          fiche_recue: false,
          message:
            "Aucune fiche de présence pour cette journée. Rien ne peut être " +
            "dit de la ponctualité.",
        };
      }

      const lignes = db.prepare(`
        SELECT e.nom_complet AS nom, a.heure_arrivee, a.heure_depart_pause,
               a.heure_retour_pause, a.heure_depart, a.observation, a.certitude
        FROM attendance a
        JOIN employees e ON e.id = a.employee_id
        WHERE a.date = ?
        ORDER BY e.nom_complet
      `).all(date);

      return {
        date,
        fiche_recue: true,
        effectif_suivi: faits.effectif_suivi,
        retards: faits.retards,
        absences_non_justifiees: faits.absences_non_justifiees,
        absences_justifiees: faits.absences_justifiees,
        a_distance: faits.a_distance,
        lignes,
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    nom: "documents_recus",
    description:
      "Les documents reçus sur une période, avec leur expéditeur et l'état " +
      "de leur lecture. Un document « lu » a son texte en base : il n'a plus " +
      "jamais besoin d'être relu.",
    parametres: {
      type: "object",
      properties: { du: JOUR, au: JOUR },
      required: ["du"],
    },

    executer({ du, au = null }) {
      const fin = au || du;

      const lignes = db.prepare(`
        SELECT a.file_name AS nom, a.file_path AS chemin,
               a.attachment_type AS type,
               COALESCE(u.name, m.sender_id) AS expediteur,
               m.created_at AS recu,
               t.moteur, t.caracteres
        FROM attachments a
        JOIN messages m ON m.message_id = a.message_id
        LEFT JOIN users u ON u.open_id = m.sender_id
        LEFT JOIN document_textes t ON t.file_path = a.file_path
        WHERE DATE(m.created_at) BETWEEN ? AND ?
        ORDER BY m.created_at
      `).all(du, fin);

      return {
        periode: { du, au: fin },
        nombre: lignes.length,
        documents: lignes.map((l) => ({
          nom: l.nom || `(image ${path.basename(l.chemin || "")})`,
          chemin: l.chemin,
          type: l.type,
          expediteur: l.expediteur,
          recu: l.recu,
          lu: !!l.moteur,
          moteur: l.moteur,
          caracteres: l.caracteres,
        })),
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    nom: "lire_document",
    description:
      "Le texte d'un document déjà lu, par son chemin. Volumineux : passer " +
      "par documents_recus d'abord pour choisir lequel.",
    parametres: {
      type: "object",
      properties: {
        chemin: {
          type: "string",
          description: "Chemin exact, tel que rendu par documents_recus.",
        },
        depuis: {
          type: "integer",
          description: "Caractère de départ, pour lire un document par tranches.",
        },
        longueur: {
          type: "integer",
          description: "Nombre de caractères à rendre. 8000 par défaut.",
        },
      },
      required: ["chemin"],
    },

    executer({ chemin, depuis = 0, longueur = 8000 }) {
      const connu = texteConnu(chemin);

      if (!connu) {
        return {
          trouve: false,
          message:
            "Ce document n'a pas encore été lu, ou le chemin est inexact. " +
            "Utiliser documents_recus pour obtenir les chemins.",
        };
      }

      const total = connu.texte.length;
      const tranche = connu.texte.slice(depuis, depuis + longueur);

      return {
        trouve: true,
        chemin,
        moteur: connu.moteur,
        caracteres_total: total,
        depuis,
        suite_disponible: depuis + tranche.length < total,
        texte: tranche,
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    nom: "chercher_personne",
    description:
      "Retrouve une personne dans le registre du personnel à partir d'un nom " +
      "approximatif, tel qu'il est écrit sur une fiche. Ne crée jamais " +
      "personne.",
    parametres: {
      type: "object",
      properties: {
        nom: { type: "string", description: "Nom, même approximatif." },
      },
      required: ["nom"],
    },

    executer({ nom }) {
      const { employe, methode } = resoudreEmploye(nom);

      if (!employe) {
        return {
          trouve: false,
          nom_cherche: nom,
          methode,
          message: "Aucune personne de ce nom au registre.",
        };
      }

      return {
        trouve: true,
        nom_cherche: nom,
        methode,
        personne: {
          nom_complet: employe.nom_complet,
          service: employe.service,
          poste: employe.poste,
          mode_travail: employe.mode_travail,
          suivi_presence: !!employe.suivi_presence,
        },
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    nom: "personnel",
    description:
      "Le registre du personnel : qui est suivi en présence, dans quel " +
      "service. À utiliser pour compter un effectif ou lister un service.",
    parametres: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Facultatif : ne garder qu'un service.",
        },
      },
    },

    executer({ service = null }) {
      const tous = listerEmployes();

      const gardes = service
        ? tous.filter(
            (e) => (e.service || "").toLowerCase().includes(service.toLowerCase())
          )
        : tous;

      return {
        effectif_total: tous.length,
        suivis_en_presence: tous.filter((e) => e.suivi_presence === 1).length,
        nombre_rendu: gardes.length,
        personnes: gardes.map((e) => ({
          nom_complet: e.nom_complet,
          service: e.service,
          poste: e.poste,
          mode_travail: e.mode_travail,
          suivi_presence: !!e.suivi_presence,
        })),
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    nom: "en_attente_de_decision",
    description:
      "Ce qui attend un arbitrage de la DRH : cellules illisibles de la " +
      "fiche, et absences supposées non encore confirmées. Tant qu'il reste " +
      "des absences à confirmer, le rapport de cette journée ne peut pas " +
      "être produit.",
    parametres: {
      type: "object",
      properties: { date: JOUR },
      required: ["date"],
    },

    executer({ date }) {
      const revues = revuesEnAttente({ date });
      const absences = questionsOuvertes(date);

      return {
        date,
        absences_a_confirmer: absences.map((a) => a.nom),
        rapport_bloque: absences.length > 0,
        cellules_en_revue: revues.length,
        cellules: revues.slice(0, 25).map((r) => ({
          personne: r.nom_brut,
          motif: r.motif,
          lecture_1: r.passe_1,
          lecture_2: r.passe_2,
        })),
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    nom: "comptes_rendus_attendus",
    description:
      "Qui doit transmettre un compte rendu pour une journée, ce qui est " +
      "arrivé et ce qui manque.",
    parametres: {
      type: "object",
      properties: { date: JOUR },
      required: ["date"],
    },

    executer({ date }) {
      const batch = prepareDailyBatch(date);
      const etat = etatDesAttendus(date, batch.fenetre);

      return {
        date,
        jour_chome: etat.jourChome,
        arrives: (etat.arrives || []).map((a) => a.libelle),
        manquants: (etat.manquants || []).map((a) => ({
          libelle: a.libelle,
          responsable: a.nom,
        })),
        partiels: (etat.partiels || []).map((p) => ({
          libelle: p.libelle,
          recus: p.recu,
          attendus: p.quantite,
        })),
      };
    },
  },
];


const PAR_NOM = new Map(OUTILS.map((outil) => [outil.nom, outil]));


// Appeler un outil par son nom. Un nom inconnu ou un argument manquant rend
// une erreur lisible plutot que de jeter : le modele doit pouvoir corriger et
// reessayer, pas faire tomber la conversation.
function appeler(nom, args = {}) {
  const outil = PAR_NOM.get(nom);

  if (!outil) {
    return {
      erreur: `Outil inconnu : ${nom}. Disponibles : ` +
        OUTILS.map((o) => o.nom).join(", "),
    };
  }

  const requis = outil.parametres.required || [];
  const absents = requis.filter((cle) => args[cle] === undefined);

  if (absents.length) {
    return { erreur: `Paramètre(s) manquant(s) pour ${nom} : ${absents.join(", ")}` };
  }

  try {
    return outil.executer(args);
  } catch (erreur) {
    return { erreur: `${nom} a échoué : ${erreur.message}` };
  }
}


// La declaration que l'on remet au modele. Aucun outil n'ecrit : c'est la
// garantie que se renseigner ne declenche rien.
function declarations() {
  return OUTILS.map((outil) => ({
    type: "function",
    function: {
      name: outil.nom,
      description: outil.description,
      parameters: outil.parametres,
    },
  }));
}


module.exports = { OUTILS, appeler, declarations };


// Essai en ligne de commande : node outils.js <nom> '<json>'
if (require.main === module) {
  const [nom, json] = process.argv.slice(2);

  if (!nom) {
    console.log("Outils en lecture seule :\n");

    for (const outil of OUTILS) {
      const params = Object.keys(outil.parametres.properties || {});

      console.log(`  ${outil.nom}(${params.join(", ")})`);
    }

    console.log("\nEssai : node outils.js etat_journee '{\"date\":\"2026-09-25\"}'");
  } else {
    let args = {};

    try {
      args = json ? JSON.parse(json) : {};
    } catch (erreur) {
      console.error(`JSON invalide : ${erreur.message}`);
      process.exit(1);
    }

    console.log(JSON.stringify(appeler(nom, args), null, 2));
  }
}
