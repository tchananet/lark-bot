require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { extractWord } = require("./extractors");

const Lark = require("@larksuiteoapi/node-sdk");
const {
  saveMessage,
  saveAttachment,  saveUser,   claimMessage,


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

async function sendToReportGroup(text) {
  try {
    await client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: process.env.LARK_REPORT_CHAT_ID,
        msg_type: "text",
        content: JSON.stringify({
          text,
        }),
      },
    });

    console.log("✓ Copie envoyée au groupe de suivi");
  } catch (error) {
    console.error("Erreur envoi vers groupe :", error);
  }
}


const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
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

    saveUser({
        open_id: sender.sender_id.open_id,
        user_id: sender.sender_id.user_id,
        union_id: sender.sender_id.union_id,
    });



    const larkUser = await enrichUserFromLark(
    sender.sender_id.open_id
    );

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
  },
});

wsClient.start({
  eventDispatcher,
});