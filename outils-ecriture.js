const {
  proposer,
  enAttente,
  autoriser,
  conclure,
  annuler,
  MINUTES_DE_VALIDITE,
} = require("./actions");

const { resoudreEmploye, enregistrerAbsence, corrigerPointage } = require("./hr");
const { trancher, questionsOuvertes } = require("./arbitrage");
const { ajouterConsigne } = require("./conversation");
const { TYPES_PRESENCE_CONFIRMEE } = require("./presence");

// ---------------------------------------------------------------------------
// Ce que l'assistant peut FAIRE -- et jamais de sa seule initiative
//
// Ces outils sont separes de outils.js pour que la regle y reste verifiable :
// un test interdit toute ecriture dans le fichier de consultation. Ici, au
// contraire, tout ecrit -- donc tout passe par une proposition.
//
// Aucun n'agit au moment ou le modele l'appelle. Chacun depose une
// proposition, la resume en francais, et rend la main. La DRH accepte au tour
// suivant. La garde qui rend cela reel est dans actions.js : un humain doit
// avoir parle entre la demande et l'accord.
//
// Ce qui manque encore ici : publier dans le groupe. C'est la tranche
// suivante, et elle est separee a dessein -- produire un document et le
// diffuser a la Direction Generale ne se valent pas.
// ---------------------------------------------------------------------------

const JOUR = { type: "string", description: "Journée au format AAAA-MM-JJ" };

const TYPES_ABSENCE = ["PERMISSION", "CONGE", "MISSION", "MALADIE", "FORMATION"];

const CHAMPS_POINTAGE = [
  "heure_arrivee",
  "heure_depart_pause",
  "heure_retour_pause",
  "heure_depart",
];

const LIBELLES_CHAMPS = {
  heure_arrivee: "heure d'arrivée",
  heure_depart_pause: "départ en pause",
  heure_retour_pause: "retour de pause",
  heure_depart: "heure de départ",
};


// Une personne inconnue du registre arrete tout, avant meme la proposition :
// proposer d'ecrire sur un nom qui n'existe pas fait perdre un tour a la DRH.
function exigerEmploye(nom) {
  const { employe, methode } = resoudreEmploye(nom);

  if (!employe) {
    return {
      erreur:
        `« ${nom} » ne correspond a personne au registre du personnel. ` +
        `Verifie l'orthographe avec chercher_personne. Aucune personne n'est ` +
        `creee a partir d'un nom cite dans un message.`,
    };
  }

  return { employe, methode };
}


const OUTILS_ECRITURE = [
  // -------------------------------------------------------------------------
  {
    nom: "proposer_production_rapport",
    description:
      "Propose de PRODUIRE le rapport d'une journée ou d'une semaine. Écrit " +
      "un document et l'enregistre, mais ne le publie ni ne l'envoie à " +
      "personne. Vérifie d'abord avec etat_journee qu'il y a de quoi " +
      "écrire, et avec en_attente_de_decision qu'aucune absence n'attend " +
      "d'être tranchée -- sinon la production s'arrêtera d'elle-même.",
    parametres: {
      type: "object",
      properties: {
        date: JOUR,
        portee: {
          type: "string",
          enum: ["JOURNEE", "SEMAINE"],
          description:
            "JOURNEE par défaut. Pour SEMAINE, date doit être le lundi.",
        },
      },
      required: ["date"],
    },

    resumer({ date, portee = "JOURNEE" }) {
      return portee === "SEMAINE"
        ? `Produire le rapport hebdomadaire de la semaine du ${date}.`
        : `Produire le rapport de la journée du ${date}.`;
    },

    async executer({ date, portee = "JOURNEE" }) {
      const { publierRapport } = require("./publication");

      // essaiSeul : le document est ecrit et memorise, rien ne part dans le
      // groupe. La diffusion est un acte distinct.
      const resultat = await publierRapport({ date, portee, essaiSeul: true });

      if (resultat.statut === "en_attente") {
        return {
          produit: false,
          motif: "absences_a_confirmer",
          message: resultat.message,
        };
      }

      if (resultat.statut === "vide") {
        return {
          produit: false,
          motif: "rien_a_ecrire",
          message: `Aucun compte rendu ni fiche de présence pour le ${date}.`,
        };
      }

      if (resultat.statut === "erreur") {
        return { produit: false, motif: "echec", message: resultat.detail || null };
      }

      return {
        produit: true,
        journee: date,
        portee,
        numero: resultat.document?.numero || null,
        fichier: resultat.chemin || null,
        reserves: resultat.reserves || [],
        publie: false,
        message:
          "Document écrit et enregistré. Il n'a été envoyé à personne : la " +
          "publication dans le groupe est une action distincte.",
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    nom: "proposer_absence",
    description:
      "Propose d'enregistrer une absence justifiée : permission, congé, " +
      "mission, arrêt maladie ou formation. Ne jamais l'appeler sur une " +
      "personne que la DRH n'a pas nommée elle-même.",
    parametres: {
      type: "object",
      properties: {
        personne: {
          type: "string",
          description: "Nom tel que la DRH l'a écrit.",
        },
        type: { type: "string", enum: TYPES_ABSENCE },
        date_debut: JOUR,
        date_fin: JOUR,
        motif: { type: "string" },
      },
      required: ["personne", "type", "date_debut"],
    },

    resumer({ personne, type, date_debut, date_fin, motif }) {
      const fin = date_fin && date_fin !== date_debut;

      return (
        `Enregistrer pour ${personne} : ${type.toLowerCase()} ` +
        (fin ? `du ${date_debut} au ${date_fin}` : `le ${date_debut}`) +
        (motif ? ` (${motif})` : "") +
        "."
      );
    },

    verifier({ personne, type }) {
      if (!TYPES_ABSENCE.includes(type)) {
        return { erreur: `Type inconnu : ${type}. Attendu : ${TYPES_ABSENCE.join(", ")}.` };
      }

      return exigerEmploye(personne);
    },

    executer({ personne, type, date_debut, date_fin, motif }, contexte) {
      const { employe, erreur } = exigerEmploye(personne);

      if (erreur) {
        return { erreur };
      }

      enregistrerAbsence({
        employee_id: employe.id,
        type,
        date_debut,
        date_fin: date_fin || date_debut,
        motif: motif || null,
        declare_par: contexte.declare_par,
      });

      return {
        enregistre: true,
        personne: employe.nom_complet,
        type,
        du: date_debut,
        au: date_fin || date_debut,
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    nom: "proposer_correction_pointage",
    description:
      "Propose de corriger une heure sur la fiche de présence d'une " +
      "journée. Ferme du même coup les cellules en revue qui portaient sur " +
      "cette personne et ce champ. Pour effacer une heure, passer une valeur " +
      "vide.",
    parametres: {
      type: "object",
      properties: {
        personne: { type: "string" },
        date: JOUR,
        champ: { type: "string", enum: CHAMPS_POINTAGE },
        valeur: {
          type: "string",
          description: "Heure au format 08h30. Vide pour effacer.",
        },
      },
      required: ["personne", "date", "champ"],
    },

    resumer({ personne, date, champ, valeur }) {
      const libelle = LIBELLES_CHAMPS[champ] || champ;

      return valeur
        ? `Fixer l'${libelle} de ${personne} au ${date} à ${valeur}.`
        : `Effacer l'${libelle} de ${personne} au ${date}.`;
    },

    verifier({ personne, champ }) {
      if (!CHAMPS_POINTAGE.includes(champ)) {
        return { erreur: `Champ non corrigeable : ${champ}.` };
      }

      return exigerEmploye(personne);
    },

    executer({ personne, date, champ, valeur }, contexte) {
      const { employe, erreur } = exigerEmploye(personne);

      if (erreur) {
        return { erreur };
      }

      const resultat = corrigerPointage({
        employee_id: employe.id,
        date,
        champ,
        valeur: valeur || null,
        declare_par: contexte.declare_par,
      });

      return {
        corrige: true,
        personne: employe.nom_complet,
        date,
        champ,
        valeur: resultat.heure,
        cellules_en_revue_fermees: resultat.revues_closes,
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    nom: "proposer_arbitrage_absence",
    description:
      "Propose de trancher une absence supposée que le bot a signalée : " +
      "congé, permission, mission, formation, maladie, permanence, " +
      "télétravail, ABSENT si c'en est bien une, ou PRESENT si la personne " +
      "a travaillé et que seule la fiche ne l'a pas captée -- ne confonds " +
      "jamais PRESENT avec PERMISSION, qui signifie une absence EXCUSÉE. " +
      "Tant qu'il en reste, le rapport de cette journée ne peut pas être " +
      "produit. Lister d'abord avec en_attente_de_decision.",
    parametres: {
      type: "object",
      properties: {
        date: JOUR,
        personne: {
          type: "string",
          description: "Nom exactement tel que en_attente_de_decision le rend.",
        },
        statut: {
          type: "string",
          enum: [
            "ABSENT", "PERMISSION", "CONGE", "MISSION", "MALADIE",
            "FORMATION", "PERMANENCE", "TELETRAVAIL", "PRESENT",
          ],
        },
        motif: { type: "string" },
      },
      required: ["date", "personne", "statut"],
    },

    resumer({ date, personne, statut, motif }) {
      return (
        `Trancher pour ${personne} au ${date} : ${statut.toLowerCase()}` +
        (motif ? ` (${motif})` : "") +
        "."
      );
    },

    verifier({ date, personne }) {
      const ouvertes = questionsOuvertes(date).map((q) => q.nom);

      if (!ouvertes.includes(personne)) {
        return {
          erreur:
            `« ${personne} » n'attend aucune décision pour le ${date}. ` +
            (ouvertes.length
              ? `En attente : ${ouvertes.join(", ")}.`
              : "Aucune absence à trancher ce jour-là."),
        };
      }

      return {};
    },

    executer({ date, personne, statut, motif }, contexte) {
      trancher(date, personne, statut, motif || null);

      // Un justificatif -- ou une presence confirmee -- s'inscrit au
      // registre : sans cela, une relecture ulterieure de cette journee ne
      // trouve toujours aucune fiche pour cette personne et la reclasse
      // ABSENT, comme si la question n'avait jamais ete tranchee.
      if (TYPES_ABSENCE.includes(statut) || TYPES_PRESENCE_CONFIRMEE.has(statut)) {
        const { employe } = resoudreEmploye(personne);

        if (employe) {
          enregistrerAbsence({
            employee_id: employe.id,
            type: statut,
            date_debut: date,
            date_fin: date,
            motif: motif || null,
            declare_par: contexte.declare_par,
          });
        }
      }

      const restantes = questionsOuvertes(date).map((q) => q.nom);

      return {
        tranche: true,
        personne,
        statut,
        restantes,
        rapport_debloque: restantes.length === 0,
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    nom: "proposer_consigne",
    description:
      "Propose de retenir une consigne durable de la DRH -- une règle qui " +
      "doit s'appliquer à tous les échanges futurs, pas une instruction " +
      "ponctuelle. À n'utiliser que si elle le demande explicitement, ou " +
      "corrige une façon de faire.",
    parametres: {
      type: "object",
      properties: {
        texte: {
          type: "string",
          description: "La consigne, en une phrase courte, à la première personne.",
        },
      },
      required: ["texte"],
    },

    resumer({ texte }) {
      return `Retenir cette consigne pour toujours : « ${texte} »`;
    },

    executer({ texte }) {
      ajouterConsigne(texte);

      return { retenue: true, texte };
    },
  },
];


const PAR_NOM = new Map(OUTILS_ECRITURE.map((outil) => [outil.nom, outil]));


// Les deux outils qui tranchent une proposition. Ils ne sont pas dans la liste
// ci-dessus : ils ne proposent rien, ils executent ou renoncent.
const CONFIRMATION = [
  {
    nom: "confirmer_action",
    description:
      "Exécute une proposition que la DRH vient d'accepter. À n'appeler " +
      "qu'après qu'elle ait répondu -- un accord donné dans le même tour que " +
      "la demande sera refusé.",
    parametres: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Numéro de la proposition." },
      },
      required: ["id"],
    },
  },
  {
    nom: "annuler_action",
    description: "Abandonne une proposition que la DRH a refusée.",
    parametres: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
  },
];


function declarationsEcriture() {
  return [...OUTILS_ECRITURE, ...CONFIRMATION].map((outil) => ({
    type: "function",
    function: {
      name: outil.nom,
      description: outil.description,
      parameters: outil.parametres,
    },
  }));
}


// Appeler un outil d'ecriture, c'est-a-dire : deposer une proposition.
async function appelerEcriture(nom, args = {}, contexte = {}) {
  const chatId = contexte.chatId;

  if (!chatId) {
    return { erreur: "Aucune conversation identifiée : impossible de proposer." };
  }

  if (nom === "confirmer_action") {
    const { autorise, motif, proposition } = autoriser(args.id, chatId);

    if (!autorise) {
      return { execute: false, refus: motif };
    }

    const outil = PAR_NOM.get(proposition.outil);

    if (!outil) {
      conclure(proposition.id, "ECHOUEE", { erreur: "outil disparu" });

      return { execute: false, refus: `Outil inconnu : ${proposition.outil}.` };
    }

    try {
      const resultat = await outil.executer(proposition.args, contexte);

      conclure(proposition.id, resultat?.erreur ? "ECHOUEE" : "EXECUTEE", resultat);

      return { execute: !resultat?.erreur, action: proposition.resume, ...resultat };
    } catch (erreur) {
      conclure(proposition.id, "ECHOUEE", { erreur: erreur.message });

      return { execute: false, erreur: erreur.message, action: proposition.resume };
    }
  }

  if (nom === "annuler_action") {
    return annuler(args.id, chatId);
  }

  const outil = PAR_NOM.get(nom);

  if (!outil) {
    return { erreur: `Outil d'écriture inconnu : ${nom}.` };
  }

  const requis = outil.parametres.required || [];
  const absents = requis.filter((cle) => args[cle] === undefined);

  if (absents.length) {
    return { erreur: `Paramètre(s) manquant(s) pour ${nom} : ${absents.join(", ")}` };
  }

  // Une verification AVANT la proposition : proposer d'ecrire sur un nom qui
  // n'existe pas, ou un statut invalide, ferait perdre un tour a la DRH.
  if (outil.verifier) {
    const controle = outil.verifier(args);

    if (controle.erreur) {
      return { erreur: controle.erreur };
    }
  }

  const resume = outil.resumer(args);
  const { id } = proposer({ chat_id: chatId, outil: nom, args, resume });

  return {
    propose: true,
    id,
    resume,
    confirmation_requise: true,
    consigne:
      "Présente cette proposition à la DRH et attends sa réponse. Si elle " +
      `accepte, appelle confirmer_action avec id ${id}. Si elle refuse, ` +
      `annuler_action. Ne confirme jamais dans ce même tour : ce sera refusé.`,
    expire_dans_minutes: MINUTES_DE_VALIDITE,
  };
}


function estOutilDEcriture(nom) {
  return PAR_NOM.has(nom) || nom === "confirmer_action" || nom === "annuler_action";
}


module.exports = {
  OUTILS_ECRITURE,
  CONFIRMATION,
  declarationsEcriture,
  appelerEcriture,
  estOutilDEcriture,
  enAttente,
};
