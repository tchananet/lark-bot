const { generer } = require("./ia");
const { appeler, declarations } = require("./outils");
const {
  declarationsEcriture,
  appelerEcriture,
  estOutilDEcriture,
  enAttente,
} = require("./outils-ecriture");
const { ajouter, fil, consignes } = require("./conversation");

// ---------------------------------------------------------------------------
// L'assistant qui parle, consulte, et n'agit pas
//
// Le bot fonctionnait par aiguillage : un classificateur rangeait chaque
// message dans une case parmi dix, puis un gestionnaire fige s'executait. Le
// 26 septembre, « Je veux faire le rapport de cette semaine. Est-ce possible ?
// Quels rapports sont deja dispo ? » -- deux questions -- n'a recu aucune
// reponse : le message est parti en DEMANDE_RAPPORT et un rapport
// hebdomadaire a ete publie dans le groupe de suivi.
//
// Ici, le modele choisit ce qu'il consulte, peut enchainer plusieurs outils,
// et REPOND. Une question ne declenche rien.
//
// Il peut aussi ecrire -- produire un rapport, enregistrer une absence,
// corriger une heure -- mais jamais de sa propre initiative. Un outil
// d'ecriture depose une proposition ; la DRH l'accepte au tour suivant. La
// garde qui rend cela reel est arithmetique et non declarative : un humain
// doit avoir parle entre la demande et l'accord (voir actions.js). Une
// consigne seule n'aurait rien empeche -- on l'a vu avec les six absences
// fabriquees du 19 septembre.
//
// Publier dans le groupe reste hors de sa portee. Produire un document et le
// diffuser a la Direction Generale ne se valent pas.
// ---------------------------------------------------------------------------

const TOURS_MAX = Number(process.env.AGENT_TOURS_MAX || 6);

// Ce qui est vrai de l'assistant, pas ce qu'on aimerait qu'il fasse. Une
// consigne qui decrit une capacite absente se traduit par une promesse non
// tenue a la DRH.
function instructions() {
  return [
    "Tu es l'assistant RH d'ALPHA MOTORS Cameroun. Tu parles a la DRH, en",
    "francais, brievement, sans formule de politesse superflue.",
    "",
    "CE QUE TU SAIS",
    "Tu ne sais rien de toi-meme. Tout ce que tu avances doit venir d'un outil",
    "que tu viens d'appeler, ou du message. Tu disposes d'outils de",
    "consultation : etat d'une journee, rapports deja produits, recherche dans",
    "leur contenu, pointages, documents recus, registre du personnel.",
    "",
    "Avant toute question portant sur une date relative -- aujourd'hui, hier,",
    "cette semaine, lundi -- appelle aujourdhui. Ne calcule jamais une date de",
    "tete.",
    "",
    "AGIR : JAMAIS SANS SON ACCORD",
    "Tu disposes aussi d'outils qui ECRIVENT : produire un rapport,",
    "enregistrer une absence, corriger une heure, trancher une absence",
    "supposee, retenir une consigne, accorder ou retirer un acces a",
    "l'assistant. Ils ne font rien immediatement : ils deposent une",
    "PROPOSITION et te rendent un numero.",
    "",
    "La marche a suivre, sans exception :",
    "1. Tu appelles l'outil. Il te rend un resume et un numero.",
    "2. Tu PRESENTES ce resume a la DRH, clairement, et tu t'arretes la.",
    "3. Au tour suivant, si elle accepte, tu appelles confirmer_action avec ce",
    "   numero. Si elle refuse, annuler_action.",
    "",
    "N'appelle jamais confirmer_action dans le meme tour que la proposition :",
    "ce sera refuse. Une confirmation que tu te donnes toi-meme n'en est pas",
    "une.",
    "",
    "Verifie avant de proposer. Avant un rapport, regarde etat_journee et",
    "en_attente_de_decision : proposer de produire un rapport qui ne peut pas",
    "l'etre fait perdre un tour.",
    "",
    "Tu ne peux PAS publier ni envoyer quoi que ce soit dans le groupe de",
    "suivi, ni a personne d'autre que ton interlocuteur. Produire un document",
    "et le diffuser a la Direction Generale ne se valent pas.",
    "N'annonce jamais avoir fait quelque chose que tu n'as pas fait.",
    "",
    "COMMENT REPONDRE",
    "Une question est une question. Se renseigner ne declenche rien. Si un",
    "message contient plusieurs questions, reponds a chacune.",
    "Appelle autant d'outils que necessaire, puis reponds en une fois.",
    "Si un outil ne trouve rien, dis-le : c'est une reponse.",
    "Ne recopie pas les noms techniques des champs -- tu parles, tu n'exportes",
    "pas des donnees.",
  ].join("\n");
}


// Les propositions ouvertes figurent dans le contexte : sans cela, un « oui »
// de la DRH au tour suivant ne se rattache a rien, et l'assistant reproposerait
// la meme chose indefiniment.
function systeme(chatId = null) {
  const morceaux = [instructions()];
  const regles = consignes();

  if (regles.length) {
    morceaux.push(
      "CONSIGNES DE LA DRH, qui priment :\n" +
      regles.map((r) => `- ${r}`).join("\n")
    );
  }

  const ouvertes = chatId ? enAttente(chatId) : [];

  if (ouvertes.length) {
    morceaux.push(
      "PROPOSITIONS EN ATTENTE DE SA REPONSE :\n" +
      ouvertes.map((a) => `- n° ${a.id} : ${a.resume}`).join("\n") +
      "\nSi son message accepte l'une d'elles, appelle confirmer_action avec " +
      "son numero. S'il la refuse, annuler_action. Ne la repropose pas."
    );
  }

  return morceaux.join("\n\n");
}


// Un resultat d'outil part dans le contexte : il doit rester borne. Un
// document de 40 000 caracteres rendu en entier couterait plus cher que la
// question ne le vaut, et le modele n'en lirait que le debut de toute facon.
function borner(valeur, maximum = 6000) {
  const texte = JSON.stringify(valeur);

  return texte.length <= maximum
    ? texte
    : `${texte.slice(0, maximum)}\n[...tronque, ${texte.length} caracteres au total]`;
}


// Un tour de conversation.
//
// generer est injectable pour que la boucle se teste sans reseau : c'est la
// mecanique qu'on veut verifier -- enchainer, s'arreter, ne pas tourner en
// rond -- pas les reponses d'un modele.
async function repondre({
  chatId,
  texte,
  expediteur = {},
  generateur = generer,
  outils = null,
  executer = null,
  tracer = () => {},
}) {
  const contexte = {
    chatId,
    declare_par: expediteur.nom || expediteur.open_id || "RH",
  };

  // Consultation et ecriture sont deux familles distinctes, dans deux
  // fichiers distincts : c'est ce qui permet d'exiger par un test qu'aucune
  // ecriture ne se glisse dans les outils de consultation.
  const aDisposition = outils || [...declarations(), ...declarationsEcriture()];

  const executerOutil =
    executer ||
    ((nom, args) =>
      estOutilDEcriture(nom)
        ? appelerEcriture(nom, args, contexte)
        : appeler(nom, args));

  ajouter({ chat_id: chatId, role: "user", contenu: texte });

  const outilsAppeles = [];
  let usage = { prompt_tokens: 0, completion_tokens: 0 };

  for (let tour = 1; tour <= TOURS_MAX; tour++) {
    const messages = [
      { role: "system", content: systeme(chatId) },
      ...fil(chatId),
    ];

    const reponse = await generateur({
      tache: "CONVERSATION",
      temperature: 0.2,
      messages,
      outils: aDisposition,
    });

    usage = {
      prompt_tokens: (usage.prompt_tokens || 0) + (reponse.usage?.prompt_tokens || 0),
      completion_tokens:
        (usage.completion_tokens || 0) + (reponse.usage?.completion_tokens || 0),
    };

    const appels = reponse.appels || [];

    ajouter({
      chat_id: chatId,
      role: "assistant",
      contenu: reponse.texte || "",
      appels: appels.length ? appels : null,
    });

    // Plus d'outil demande : c'est la reponse.
    if (!appels.length) {
      return {
        texte: (reponse.texte || "").trim(),
        outils: outilsAppeles,
        tours: tour,
        usage,
        modele: reponse.modele,
      };
    }

    for (const appel of appels) {
      const nom = appel.function?.name;
      let args = {};

      try {
        args = JSON.parse(appel.function?.arguments || "{}");
      } catch (erreur) {
        args = { _erreur: `arguments illisibles : ${erreur.message}` };
      }

      const resultat = args._erreur
        ? { erreur: args._erreur }
        : await executerOutil(nom, args);

      outilsAppeles.push({ nom, args, erreur: resultat?.erreur || null });
      tracer({ tour, nom, args, erreur: resultat?.erreur || null });

      ajouter({
        chat_id: chatId,
        role: "tool",
        contenu: borner(resultat),
        outil: nom,
        appel_id: appel.id,
      });
    }
  }

  // Le plafond est atteint : le modele tourne en rond. Mieux vaut le dire que
  // de le laisser consommer sans fin -- et le dire a la DRH, pas seulement
  // dans les logs.
  const aveu =
    "Je n'arrive pas a conclure : j'ai consulte " +
    `${outilsAppeles.length} fois mes outils sans parvenir a une reponse. ` +
    "Reformule ou demande-moi quelque chose de plus precis.";

  ajouter({ chat_id: chatId, role: "assistant", contenu: aveu });

  return {
    texte: aveu,
    outils: outilsAppeles,
    tours: TOURS_MAX,
    usage,
    plafond_atteint: true,
  };
}


module.exports = { repondre, systeme, instructions, borner, TOURS_MAX };


// Essai en ligne de commande, sans passer par Lark :
//   node agent.js "quels rapports sont disponibles ?"
if (require.main === module) {
  const question = process.argv.slice(2).join(" ");

  if (!question) {
    console.log('Usage : node agent.js "ta question"');
    process.exit(0);
  }

  repondre({
    chatId: process.env.AGENT_CHAT_ESSAI || "essai-console",
    texte: question,
    tracer: ({ tour, nom, args, erreur }) =>
      console.log(
        `  [tour ${tour}] ${nom}(${JSON.stringify(args)})` +
        (erreur ? ` -- ${erreur}` : "")
      ),
  })
    .then((r) => {
      console.log(`\n${r.texte}\n`);
      console.log(
        `(${r.tours} tour(s), ${r.outils.length} appel(s) d'outil, ` +
        `${r.usage.prompt_tokens}+${r.usage.completion_tokens} tokens)`
      );
    })
    .catch((erreur) => {
      console.error(erreur);
      process.exitCode = 1;
    });
}
