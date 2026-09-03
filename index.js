require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { extractWord } = require("./extractors");

const cron = require("node-cron");
const Lark = require("@larksuiteoapi/node-sdk");
const { runDigest } = require("./digest");
const {
  saveMessage,
  saveAttachment,  saveUser,   claimMessage,
  releaseMessage,
  localReportDate,

} = require("./database");


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


// Commande manuelle : "/rapport" ou "/rapport 2026-09-01".
// Tolere une mention du bot, que Lark insere sous forme @_user_N.
function parseRapportCommand(message) {
  if (message.message_type !== "text") {
    return null;
  }

  let text;

  try {
    text = JSON.parse(message.content).text || "";
  } catch (error) {
    return null;
  }

  const cleaned = text.replace(/@_user_\d+/g, " ").trim();

  if (!/^\/rapport\b/i.test(cleaned)) {
    return null;
  }

  const argument = cleaned.replace(/^\/rapport\b/i, "").trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(argument) ? argument : null;

  return { date, invalidDate: argument !== "" && date === null };
}


async function handleMessage(data) {
    const message = data.message;
    const sender = data.sender;

    // Les commandes sont traitees AVANT le filtre du groupe de suivi,
    // pour pouvoir taper /rapport directement dans ce groupe.
    const rapportCommand = parseRapportCommand(message);

    if (rapportCommand) {
      if (!claimMessage(message.message_id)) {
        console.log(`Commande deja traitee, ignoree : ${message.message_id}`);
        return;
      }

      if (rapportCommand.invalidDate) {
        await sendTextToChat(
          message.chat_id,
          "Format de date invalide.\nUtilisation : /rapport ou /rapport AAAA-MM-JJ"
        );
        return;
      }

      const cible = rapportCommand.date || localReportDate();

      console.log(`[commande] /rapport demande pour le ${cible}`);

      await sendTextToChat(
        message.chat_id,
        `Génération du rapport du ${cible} en cours...`
      );

      const result = await runDigest({ date: rapportCommand.date });

      const dansLeGroupeDeSuivi =
        message.chat_id === process.env.LARK_REPORT_CHAT_ID;

      if (result.status === "empty") {
        await sendTextToChat(
          message.chat_id,
          `Aucun message enregistré pour le ${cible}.`
        );
      } else if (result.status === "error" && !dansLeGroupeDeSuivi) {
        // runDigest a deja publie le detail de l'echec dans le groupe
        // de suivi : on ne le repete que si la commande vient d'ailleurs.
        await sendTextToChat(
          message.chat_id,
          `Échec de génération du rapport du ${cible}. Voir les logs du conteneur.`
        );
      } else if (result.status === "sent" && !dansLeGroupeDeSuivi) {
        await sendTextToChat(
          message.chat_id,
          "Rapport publié dans le groupe de suivi."
        );
      }

      return;
    }

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


        await sendToReportGroup(text);

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


        await sendReportHeader(
            senderName,
            "Fichier",
            parsedContent.file_name
        );

        await sendFileToReportGroup(
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

        await sendReportHeader(
            senderName,
            "Note vocale"
        );

        await sendFileToReportGroup(
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

        await sendReportHeader(
            senderName,
            "Image"
        );

        await sendImageToReportGroup(imagePath);

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

        await sendReportHeader(
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
            
            await sendImageToReportGroup(imagePath);
            }

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


// Les comptes rendus d'une journee arrivent entre 17h le jour meme et 10h
// le lendemain. Le rapport est donc genere a 10h30, une fois la fenetre
// fermee, et porte sur la journee PRECEDENTE. Le generer a 18h reviendrait
// a ignorer les envois du soir et ceux du lendemain matin.
const DIGEST_CRON = process.env.DIGEST_CRON || "30 10 * * *";
const DIGEST_TIMEZONE = process.env.DIGEST_TIMEZONE || "Africa/Douala";

if (process.env.DIGEST_ENABLED === "false") {
  console.log("Rapport quotidien desactive (DIGEST_ENABLED=false)");
} else {
  cron.schedule(DIGEST_CRON, () => runDigest(), {
    timezone: DIGEST_TIMEZONE,
    name: "rapport-quotidien",
    noOverlap: true,
  });

  console.log(
    `Rapport quotidien planifie : ${DIGEST_CRON} (${DIGEST_TIMEZONE}), ` +
    "portant sur la journee precedente"
  );
}