require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { extractWord } = require("./extractors");

const cron = require("node-cron");
const Lark = require("@larksuiteoapi/node-sdk");
const { traiter } = require("./assistant");
const { publierRapport } = require("./publication");
const {
  saveMessage,
  saveAttachment,  saveUser,   claimMessage,
  releaseMessage,
  exclureDuRapport,

} = require("./database");
const { estRH } = require("./hr");
const { consigner } = require("./journal");
const { demarrer: demarrerInterface } = require("./serveur");


const config = {
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,

  // IMPORTANT : application Lark internationale
  domain: Lark.Domain.Lark,
};

const client = new Lark.Client(config);

const wsClient = new Lark.WSClient(config);

async function downloadResource(messageId, fileKey, type, fileName) {
  const downloadDir = path.join(__dirname, "downloads");

  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  const response = await client.im.v1.messageResource.get({
    path: {
      message_id: messageId,
      file_key: fileKey,
    },
    params: {
      type: type,
    },
  });

  const finalName =
    fileName ||
    `${fileKey}${type === "image" ? ".jpg" : ""}`;

  const outputPath = path.join(downloadDir, finalName);

  await response.writeFile(outputPath);

  console.log("Fichier sauvegardé :", outputPath);

  return outputPath;
}


function parsePostContent(content) {
  const result = {
    text: [],
    images: [],
    files: [],
    links: [],
  };

  const blocks = content.content_v2 || content.content || [];

  for (const row of blocks) {
    for (const item of row) {
      if (item.tag === "text" && item.text) {
        result.text.push(item.text);
      }

      if (item.tag === "img" && item.image_key) {
        result.images.push(item.image_key);
      }

      // Un document joint a un message redige -- le cas normal quand on
      // ecrit "voici le planning" ET qu'on attache le PDF -- arrive sous
      // cette balise. Elle etait ignoree : le texte etait enregistre, le
      // fichier disparaissait sans un mot.
      if ((item.tag === "file" || item.tag === "media") && item.file_key) {
        result.files.push({
          file_key: item.file_key,
          file_name: item.file_name || `${item.file_key}.bin`,
        });
      }

      if (item.tag === "a" && item.href) {
        result.links.push({
          text: item.text || "",
          href: item.href,
        });
      }
    }
  }

  return result;
}



async function sendImageToReportGroup(imagePath) {
  try {
    const upload = await client.im.v1.image.create({
      data: {
        image_type: "message",
        image: fs.readFileSync(imagePath),
      },
    });


    // const imageKey = upload.data?.image_key;
    const imageKey = upload.image_key || '';

    console.log("UPLOAD IMAGE RESPONSE:");
console.dir(upload, { depth: null });

    if (!imageKey) {
      console.error("Impossible de récupérer image_key après upload");
      return;
    }

    await client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: process.env.LARK_REPORT_CHAT_ID,
        msg_type: "image",
        content: JSON.stringify({
          image_key: imageKey,
        }),
      },
    });

    console.log("✓ Image envoyée au groupe");
  } catch (error) {
    console.error("Erreur envoi image au groupe :", error);
  }
}

// Lark n'accepte qu'une liste fermée de file_type à l'upload.
const LARK_FILE_TYPES = {
  ".pdf": "pdf",
  ".doc": "doc",
  ".docx": "doc",
  ".xls": "xls",
  ".xlsx": "xls",
  ".ppt": "ppt",
  ".pptx": "ppt",
  ".mp4": "mp4",
  ".opus": "opus",
};

function larkFileType(fileName) {
  return (
    LARK_FILE_TYPES[path.extname(fileName || "").toLowerCase()] ||
    "stream"
  );
}

async function sendFileToReportGroup(filePath, fileName, options = {}) {
  try {
    const fileType = options.fileType || larkFileType(fileName);

    const upload = await client.im.v1.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        ...(options.duration ? { duration: options.duration } : {}),
        file: fs.createReadStream(filePath),
      },
    });

    const fileKey = upload?.file_key;

    if (!fileKey) {
      console.error(
        "Impossible de récupérer file_key après upload :",
        fileName
      );
      return;
    }

    await client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: process.env.LARK_REPORT_CHAT_ID,
        msg_type: fileType === "opus" ? "audio" : "file",
        content: JSON.stringify({
          file_key: fileKey,
        }),
      },
    });

    console.log("✓ Fichier envoyé au groupe :", fileName);
  } catch (error) {
    console.error("Erreur envoi fichier au groupe :", error);
  }
}

async function enrichUserFromLark(openId) {
  try {
    const response = await client.contact.v3.user.get({
      path: {
        user_id: openId,
      },
      params: {
        user_id_type: "open_id",
      },
    });

    console.log("USER LARK:");
    console.log(JSON.stringify(response, null, 2));

    return response.data?.user || null;
  } catch (error) {
    console.error("Erreur récupération utilisateur Lark :", error);
    return null;
  }
}


async function sendReportHeader(senderName, type, text = "") {
  await sendToReportGroup(
    `Nouveau message reçu\n\n` +
    `De : ${senderName}\n` +
    `Type : ${type}\n\n` +
    (text ? text : "")
  );
}

async function sendTextToChat(chatId, text) {
  try {
    await client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({
          text,
        }),
      },
    });
  } catch (error) {
    console.error("Erreur envoi vers le chat", chatId, ":", error);
  }
}

async function sendToReportGroup(text) {
  await sendTextToChat(process.env.LARK_REPORT_CHAT_ID, text);
  console.log("✓ Copie envoyée au groupe de suivi");
}


// Accuses de reception et politesses : rien a archiver, rien a relayer.
const ACQUITTEMENTS =
  /^(ok+|oui|non|merci|mercii+|bonjour|bonsoir|salut|coucou|bien|bien recu|recu|note|notee|d'accord|daccord|parfait|super|nickel|top|ca marche|entendu|compris)\W*$/i;

// Longueur en deca de laquelle un message texte n'est pas considere comme un
// compte rendu. Les documents, images et notes vocales sont toujours relayes.
const RELAI_LONGUEUR_MIN = Number(process.env.RELAI_LONGUEUR_MIN || 30);

function estSignificatif(message, parsedContent) {
  if (message.message_type !== "text") {
    return true;
  }

  const texte = (parsedContent.text || "").trim();

  if (!texte || ACQUITTEMENTS.test(texte)) {
    return false;
  }

  // Un texte court contenant des chiffres est probablement un releve
  // ("152 appels, 8 RDV") : on ne le jette pas sur sa seule longueur.
  if (/\d/.test(texte)) {
    return true;
  }

  return texte.length >= RELAI_LONGUEUR_MIN;
}


async function handleMessage(data) {
    const debutTraitement = Date.now();
    const message = data.message;
    const sender = data.sender;

    // Ne jamais traiter les messages du groupe de supervision
    if (message.chat_id === process.env.LARK_REPORT_CHAT_ID) {
      console.log("Message du groupe de suivi ignoré.");
      return;
    }

    // Ne jamais traiter deux fois le même message Lark
    const isNewMessage = claimMessage(message.message_id);

    if (!isNewMessage) {
      console.log(
        `Message déjà traité, ignoré : ${message.message_id}`
      );
      return;
    }

    console.log(
      `Nouveau message accepté : ${message.message_id}`
    );


    if (message.chat_id === process.env.LARK_REPORT_CHAT_ID) {
        console.log("Message du groupe de suivi ignoré.");
        return;
    }

    // Enrichir AVANT d'enregistrer, sinon on écrase le profil
    // avec des valeurs vides à chaque message.
    const larkUser = await enrichUserFromLark(
        sender.sender_id.open_id
    );

    saveUser({
        open_id: sender.sender_id.open_id,
        user_id: sender.sender_id.user_id,
        union_id: sender.sender_id.union_id,
        name: larkUser?.name,
        email: larkUser?.email,
        department: larkUser?.department_ids?.join(", "),
    });

    const senderName =  larkUser?.name || sender.sender_id.open_id;

    if (larkUser) {
        console.log("Nom :", larkUser.name);
        console.log("Email :", larkUser.email);
        console.log("Départements :", larkUser.department_ids);
    }

    
    let content = message.content;
    const parsedContent = JSON.parse(message.content);

    // Fichiers telecharges pendant le traitement, remis ensuite a
    // l'assistant si l'expediteur est la DRH.
    const fichiersRecus = [];

    const expediteur = {
      open_id: sender.sender_id.open_id,
      nom: larkUser?.name || null,
    };

    const rh = estRH(expediteur);

    // Le relai est DIFFERE. Pour la DRH, la decision depend de l'intention
    // du message, qui n'est connue qu'apres analyse : une conversation avec
    // le bot ne regarde pas le groupe, un compte rendu si. On empile donc
    // les envois et on tranche une fois le message traite.
    //
    // Le message reste enregistre en base dans tous les cas : seul le relai
    // vers le groupe de suivi est conditionnel.
    const relais = [];

    const relayerTexte = (t) => relais.push(() => sendToReportGroup(t));
    const relayerEntete = (...a) => relais.push(() => sendReportHeader(...a));
    const relayerImage = (p) => relais.push(() => sendImageToReportGroup(p));
    const relayerFichier = (...a) => relais.push(() => sendFileToReportGroup(...a));

    async function viderLesRelais(doitRelayer, motif) {
      if (!doitRelayer) {
        console.log(
          `Message non relaye au groupe (${motif}) : ${message.message_id}`
        );
        return;
      }

      for (const envoyer of relais) {
        await envoyer();
      }
    }

    if (message.message_type === "text") {
        const text = parsedContent.text;

        console.log("Contenu :", text);

        saveMessage({
            message_id: message.message_id,
            chat_id: message.chat_id,
            sender_id: sender.sender_id.open_id,
            message_type: "text",
            content: text,
        });


        await relayerTexte(text);

        console.log("✓ Message enregistré");
    }

    if (message.message_type === "file") {
        const filePath = await downloadResource(
            message.message_id,
            parsedContent.file_key,
            "file",
            parsedContent.file_name
        );
        saveMessage({
            message_id: message.message_id,
            chat_id: message.chat_id,
            sender_id: sender.sender_id.open_id,
            message_type: "file",
            file_name: parsedContent.file_name,
            file_path: filePath,
        });

        saveAttachment({
            message_id: message.message_id,
            attachment_type: "file",
            file_name: parsedContent.file_name,
            file_key: parsedContent.file_key,
            file_path: filePath,
        });


        fichiersRecus.push(filePath);

        await relayerEntete(
            senderName,
            "Fichier",
            parsedContent.file_name
        );

        await relayerFichier(
            filePath,
            parsedContent.file_name
        );

        console.log("✓ Fichier enregistré");
    }

    if (message.message_type === "audio") {
        const audioPath = await downloadResource(
            message.message_id,
            parsedContent.file_key,
            "file",
            `${message.message_id}.opus`
        );

        saveMessage({
            message_id: message.message_id,
            chat_id: message.chat_id,
            sender_id: sender.sender_id.open_id,
            message_type: "audio",
        });

        saveAttachment({
            message_id: message.message_id,
            attachment_type: "audio",
            file_key: parsedContent.file_key,
            file_path: audioPath,
        });

        await relayerEntete(
            senderName,
            "Note vocale"
        );

        await relayerFichier(
            audioPath,
            `${message.message_id}.opus`,
            {
                fileType: "opus",
                duration: parsedContent.duration,
            }
        );

        console.log("✓ Audio enregistré :", audioPath);
        }

    if (message.message_type === "image") {
        const imagePath = await downloadResource(
            message.message_id,
            parsedContent.image_key,
            "image",
            `${message.message_id}.jpg`
        );
        

        saveMessage({
            message_id: message.message_id,
            chat_id: message.chat_id,
            sender_id: sender.sender_id.open_id,
            message_type: "image",
            file_path: imagePath,
        });
        saveAttachment({
            message_id: message.message_id,
            attachment_type: "image",
            file_key: parsedContent.image_key,
            file_path: imagePath,
        });

        fichiersRecus.push(imagePath);

        await relayerEntete(
            senderName,
            "Image"
        );

        await relayerImage(imagePath);

        console.log("✓ Image enregistrée");
    }


    if (message.message_type === "post") {
        const post = parsePostContent(parsedContent);

        console.log("POST détecté");
        console.log("Texte :", post.text.join("\n"));
        console.log("Images :", post.images);
        console.log("Liens :", post.links);

        const textContent = post.text.join("\n");

        
        saveMessage({
            message_id: message.message_id,
            chat_id: message.chat_id,
            sender_id: sender.sender_id.open_id,
            message_type: "post",
            content: textContent,
        });

        await relayerEntete(
            senderName,
            "Message riche",
            textContent
        );


        for (let i = 0; i < post.images.length; i++) {
            const imageKey = post.images[i];

            const imagePath = await downloadResource(
                message.message_id,
                imageKey,
                "image",
                `${message.message_id}_${i + 1}.jpg`
            );

            saveAttachment({
                message_id: message.message_id,
                attachment_type: "image",
                file_key: imageKey,
                file_path: imagePath,
            });

            // Sans cette ligne, une photo de fiche envoyee avec un
            // commentaire n'etait jamais soumise a la lecture : elle
            // finissait dans le groupe et nulle part ailleurs.
            fichiersRecus.push(imagePath);

            await relayerImage(imagePath);
            }

        for (const fichier of post.files) {
            const filePath = await downloadResource(
                message.message_id,
                fichier.file_key,
                "file",
                fichier.file_name
            );

            saveAttachment({
                message_id: message.message_id,
                attachment_type: "file",
                file_name: fichier.file_name,
                file_key: fichier.file_key,
                file_path: filePath,
            });

            fichiersRecus.push(filePath);

            await relayerFichier(filePath, fichier.file_name);

            console.log("✓ Fichier du message riche enregistré :", fichier.file_name);
            }

        }


    // Seule la DRH dialogue avec le bot. Le controle a ete fait plus haut,
    // avant le relai vers le groupe, et donc avant le moindre appel au
    // modele : un compte rendu ordinaire ne fait rien analyser du tout.
    const entree = {
      message_id: message.message_id,
      chat_id: message.chat_id,
      expediteur_open_id: expediteur.open_id,
      expediteur_nom: expediteur.nom,
      est_rh: rh,
      type_message: message.message_type,
      fichiers: fichiersRecus.map((f) => path.basename(f)),
    };

    if (rh) {
      const texte =
        message.message_type === "text" ? parsedContent.text || "" : "";

      try {
        const analyse = await traiter({
          texte,
          fichiers: fichiersRecus,
          expediteur,
          repondre: (reponse) => sendTextToChat(message.chat_id, reponse),
        });

        // Seul un vrai compte rendu part au groupe. Une permission, une
        // correction, une demande de rapport ou une simple conversation
        // s'adressent au bot et n'ont rien a y faire.
        const estUnRapport = analyse?.intention === "RAPPORT";

        await viderLesRelais(
          estUnRapport,
          `DRH, intention ${analyse?.intention || "inconnue"}`
        );

        // Meme raisonnement pour le rapport consolide : sans cela, toute la
        // conversation avec le bot atterrissait dans le rapport du jour, ou
        // le modele tentait d'en faire du compte rendu d'activite.
        if (!estUnRapport) {
          exclureDuRapport(message.message_id);
        }

        consigner({
          ...entree,
          intention: analyse?.intention,
          certitude: analyse?.certitude,
          explication: analyse?.explication,
          relaye: estUnRapport,
          duree_ms: Date.now() - debutTraitement,
        });
      } catch (erreur) {
        // Le message est consigne comme en echec avant d'etre relance :
        // sinon une panne du modele ne laisserait aucune trace consultable.
        consigner({
          ...entree,
          resultat: "ERREUR",
          detail: (erreur?.message || String(erreur)).slice(0, 500),
          duree_ms: Date.now() - debutTraitement,
        });

        throw erreur;
      }
    } else {
      console.log(
        `Expediteur non RH (${expediteur.nom || expediteur.open_id}) : ` +
        `message enregistre, aucune reponse.`
      );

      // Pour les autres, pas d'analyse d'intention : ce serait un appel au
      // modele pour chaque message du personnel. Le filtre reste la simple
      // mesure de portee du message.
      const aDeLaPortee = estSignificatif(message, parsedContent);

      await viderLesRelais(aDeLaPortee, "message sans portee");

      consigner({
        ...entree,
        intention: "IGNORE",
        explication: "expediteur non habilite, aucune reponse envoyee",
        relaye: aDeLaPortee,
        duree_ms: Date.now() - debutTraitement,
      });
    }

    console.log("\n========================");
    console.log("NOUVEAU MESSAGE");
    console.log("========================");

    console.log("User ID :", sender.sender_id.open_id);
    console.log("Chat ID :", message.chat_id);
    console.log("Message ID :", message.message_id);
    console.log("Type :", message.message_type);
    console.log("Contenu :", content);
    console.log("========================\n");
}


const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    const messageId = data.message?.message_id;

    try {
      await handleMessage(data);
    } catch (error) {
      console.error(
        `Erreur traitement message ${messageId} :`,
        error
      );

      // Libérer la réservation pour que Lark puisse relivrer
      // l'événement, sinon le message est perdu définitivement.
      if (messageId) {
        releaseMessage(messageId);
      }
    }
  },
});

wsClient.start({
  eventDispatcher,
});

demarrerInterface();


// Les comptes rendus d'une journee arrivent entre 17h le jour meme et 16h
// le lendemain. Le rapport est donc genere a 17h15, une fois la fenetre
// fermee, et porte sur la journee PRECEDENTE.
const DIGEST_CRON = process.env.DIGEST_CRON || "15 17 * * *";
const DIGEST_TIMEZONE = process.env.DIGEST_TIMEZONE || "Africa/Douala";

if (process.env.DIGEST_ENABLED === "false") {
  console.log("Rapport quotidien desactive (DIGEST_ENABLED=false)");
} else {
  // publierRapport signale lui-meme ses echecs dans Lark ; ce filet ne
  // couvre que ce qui casse avant, par exemple une configuration absente.
  const lancerRapport = () =>
    publierRapport().catch((erreur) =>
      console.error("[rapport] planification :", erreur?.message || erreur)
    );

  cron.schedule(DIGEST_CRON, lancerRapport, {
    timezone: DIGEST_TIMEZONE,
    name: "rapport-quotidien",
    noOverlap: true,
  });

  console.log(
    `Rapport quotidien planifie : ${DIGEST_CRON} (${DIGEST_TIMEZONE}), ` +
    "portant sur la journee precedente"
  );
}