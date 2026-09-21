const { genererJson, messageUtilisateur } = require("./ia");
const { localToday } = require("./database");

// ---------------------------------------------------------------------------
// Routage par intention
//
// Pas de commandes a retenir : la DRH ecrit en francais et le bot decide de
// ce qu'il doit faire. Les documents sont classes d'apres leur contenu, pas
// d'apres leur nom de fichier.
// ---------------------------------------------------------------------------

const INTENTIONS = [
  "POINTAGE",
  "PLANNING",
  "RAPPORT",
  "PERMISSION",
  "CORRECTION",
  "DEMANDE_RAPPORT",
  "GESTION_ACCES",
  "AUTRE",
];

const SCHEMA = {
  type: "object",
  properties: {
    intention: { type: "string", enum: INTENTIONS },
    certitude: { type: "string", enum: ["HAUTE", "MOYENNE", "BASSE"] },
    explication: { type: "string" },
    absences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          personne: { type: "string" },
          type: {
            type: "string",
            enum: ["PERMISSION", "CONGE", "MISSION", "MALADIE", "FORMATION"],
          },
          date_debut: { type: "string" },
          date_fin: { type: "string" },
          motif: { type: "string" },
        },
        required: ["personne", "type", "date_debut", "date_fin", "motif"],
      },
    },
    corrections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          personne: { type: "string" },
          date: { type: "string" },
          champ: {
            type: "string",
            enum: [
              "heure_arrivee",
              "heure_depart",
              "heure_depart_pause",
              "heure_retour_pause",
            ],
          },
          valeur: { type: "string" },
        },
        required: ["personne", "date", "champ", "valeur"],
      },
    },
    acces: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["AJOUTER", "RETIRER", "LISTER", "AUCUNE"] },
        personne: { type: "string" },
      },
      required: ["action", "personne"],
    },
    rapport_date: { type: "string" },
    rapport_portee: { type: "string", enum: ["JOURNEE", "SEMAINE", ""] },
  },
  required: [
    "intention",
    "certitude",
    "explication",
    "absences",
    "corrections",
    "acces",
    "rapport_date",
    "rapport_portee",
  ],
};


function prompt(aujourdhui, aDesPiecesJointes) {
  return `Tu orientes les messages recus par l'assistant RH d'ALPHA MOTORS.
Determine ce que l'expediteur attend, puis renseigne les champs utiles.

Date du jour : ${aujourdhui}.
${aDesPiecesJointes ? "Le message comporte une piece jointe, fournie ci-dessous." : "Le message ne comporte aucune piece jointe."}

INTENTIONS POSSIBLES
POINTAGE : une fiche de presence, tableau de noms avec heures d'arrivee et de
  depart, le plus souvent manuscrite et signee.
PLANNING : un planning de permanence ou d'equipe du soir, associant des jours
  a des personnes de garde.
RAPPORT : un compte rendu d'activite redige par un service.
PERMISSION : le message declare qu'une ou plusieurs personnes etaient ou
  seront absentes, en permission, en conge, en mission, malades ou en
  formation. Cela couvre aussi une reponse aux questions posees par le bot.
CORRECTION : le message rectifie une heure lue sur la fiche de presence.
  Typiquement une reponse a une cellule que le bot a signalee comme
  illisible : "Isabelle est partie a 16h09", "non, Marie est arrivee a
  08h22", "Gloria a fini a 17h46".
DEMANDE_RAPPORT : le message reclame un rapport, une synthese ou un
  recapitulatif, pour une date donnee ou pour la derniere journee.
GESTION_ACCES : le message demande d habiliter quelqu un a dialoguer avec
  l assistant, de lui retirer cette habilitation, ou de savoir qui en
  dispose. Exemples : "ajoute Gloria aux RH", "Isabelle peut aussi utiliser
  le bot", "retire Ben des RH", "qui a acces au bot ?".
AUTRE : tout le reste, y compris les salutations et les messages sans objet.

NE CONFONDS PAS PERMISSION ET CORRECTION
PERMISSION explique POURQUOI quelqu'un n'etait pas la ou est arrive tard.
CORRECTION dit que l'heure inscrite en base est FAUSSE et donne la bonne.
"Bineli avait une permission" est une PERMISSION.
"Bineli est arrive a 09h15, pas 15h40" est une CORRECTION.

CHAMPS A RENSEIGNER
absences : une entree par personne ET par periode citee. Le nom est recopie
  tel qu'il est ecrit, sans le completer. Les dates sont au format AAAA-MM-JJ,
  resolues par rapport a la date du jour : "hier", "ce matin", "du 14 au 18"
  doivent devenir des dates reelles. Pour une seule journee, date_debut et
  date_fin sont identiques. Le motif reprend les mots de l'expediteur ; s'il
  n'y en a pas, laisse une chaine vide.
  Laisse la liste vide pour toute intention autre que PERMISSION.
corrections : une entree par heure rectifiee, uniquement pour CORRECTION.
  personne : le nom tel qu'il est ecrit, sans le completer.
  champ : heure_arrivee pour une arrivee, heure_depart pour un depart,
    heure_depart_pause pour un depart en pause, heure_retour_pause pour un
    retour de pause. "est partie", "a fini", "est sortie" designent un
    depart ; "est arrivee", "a commence" designent une arrivee.
  valeur : l'heure corrigee, recopiee telle quelle (16h09, 8h22, 17:46).
  date : AAAA-MM-JJ si le message la precise. Si aucune date n'est donnee,
    laisse une chaine vide : la journee sera deduite des cellules en
    attente. N'invente jamais une date pour combler le champ.
  Laisse la liste vide pour toute intention autre que CORRECTION.
acces : uniquement pour GESTION_ACCES.
  action : AJOUTER pour habiliter, RETIRER pour revoquer, LISTER pour
    enumerer les personnes habilitees. AUCUNE sinon.
  personne : le nom cite, recopie tel quel. Chaine vide pour LISTER.
  Pour toute autre intention, action vaut AUCUNE et personne une chaine vide.
rapport_portee : uniquement pour DEMANDE_RAPPORT. SEMAINE si le message
  demande un bilan portant sur une semaine entiere -- "la semaine derniere",
  "le rapport hebdomadaire", "du 14 au 20". JOURNEE pour une seule journee.
  Chaine vide pour toute autre intention.
rapport_date : uniquement pour DEMANDE_RAPPORT, au format AAAA-MM-JJ. Pour
  une JOURNEE, la journee demandee. Pour une SEMAINE, le LUNDI de la semaine
  demandee. Chaine vide si rien n'est precise ou si l'intention est autre.

REGLES
- Ne devine pas une intention a partir du nom du fichier : lis son contenu.
- Si le message ne demande rien et n'annonce rien, reponds AUTRE.
- certitude vaut BASSE des que plusieurs lectures sont plausibles.
- explication : une phrase, en francais, disant ce que tu as compris.`;
}


async function analyser({ texte = "", fichiers = [] } = {}) {
  const aujourdhui = localToday();

  const consigne = prompt(aujourdhui, fichiers.length > 0);
  const corps = texte.trim() ? `${consigne}\n\nMESSAGE RECU :\n${texte.trim()}` : consigne;

  const { donnees: analyse } = await genererJson({
    tache: "ROUTAGE",
    messages: [messageUtilisateur(corps, fichiers)],
    schema: SCHEMA,
    temperature: 0,
  });

  return {
    intention: INTENTIONS.includes(analyse.intention) ? analyse.intention : "AUTRE",
    certitude: analyse.certitude || "BASSE",
    explication: analyse.explication || "",
    // Une absence sans personne ni date est inexploitable : on la jette
    // plutot que d'ecrire une ligne incomplete en base.
    corrections: (analyse.corrections || []).filter(
      (c) => c.personne && c.champ && c.valeur
    ),
    absences: (analyse.absences || []).filter(
      (a) => a.personne && /^\d{4}-\d{2}-\d{2}$/.test(a.date_debut || "")
    ),
    acces:
      analyse.acces && analyse.acces.action && analyse.acces.action !== "AUCUNE"
        ? analyse.acces
        : null,
    rapport_date: /^\d{4}-\d{2}-\d{2}$/.test(analyse.rapport_date || "")
      ? analyse.rapport_date
      : null,

    // Par defaut une journee : c'est la demande courante, et se tromper vers
    // le rapport du jour coute moins cher qu'une semaine entiere produite
    // pour rien.
    rapport_portee: analyse.rapport_portee === "SEMAINE" ? "SEMAINE" : "JOURNEE",
  };
}

module.exports = { analyser, INTENTIONS, SCHEMA, prompt };
