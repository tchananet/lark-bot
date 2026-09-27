const { generer } = require("./ia");
const { appeler, declarations } = require("./outils");
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
// et REPOND. Aucun outil n'ecrit : a cette etape il ne peut ni enregistrer ni
// publier quoi que ce soit. Quand on lui demande une action, il dit ce qu'il
// ferait et s'arrete la.
//
// Ce n'est pas une limite provisoire a lever vite : c'est la seule position
// sure tant que la confirmation avant ecriture n'existe pas. Un assistant qui
// se renseigne ne peut rien casser.
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
    "CE QUE TU NE PEUX PAS FAIRE",
    "Tu ne peux RIEN ecrire ni envoyer : ni produire un rapport, ni le publier,",
    "ni enregistrer une absence, ni corriger un pointage. Si on te le demande,",
    "dis franchement que tu ne peux pas encore le faire, et propose ce que tu",
    "peux : montrer ce qui est disponible, ce qui manque, ce qui bloque.",
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


function systeme() {
  const regles = consignes();

  return regles.length
    ? `${instructions()}\n\nCONSIGNES DE LA DRH, qui priment :\n` +
      regles.map((r) => `- ${r}`).join("\n")
    : instructions();
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
  generateur = generer,
  outils = declarations(),
  executer = appeler,
  tracer = () => {},
}) {
  ajouter({ chat_id: chatId, role: "user", contenu: texte });

  const outilsAppeles = [];
  let usage = { prompt_tokens: 0, completion_tokens: 0 };

  for (let tour = 1; tour <= TOURS_MAX; tour++) {
    const messages = [
      { role: "system", content: systeme() },
      ...fil(chatId),
    ];

    const reponse = await generateur({
      tache: "CONVERSATION",
      temperature: 0.2,
      messages,
      outils,
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
        : executer(nom, args);

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
