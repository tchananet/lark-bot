const { getDailyBatch } = require("./database");

function prepareDailyBatch(date = null) {
  const messages = getDailyBatch(date);

  return {
    date: date || new Date().toISOString().slice(0, 10),

    total_messages: messages.length,

    messages: messages.map((message) => ({
      sender: {
        id: message.sender_id,
        name: message.sender_name || message.sender_id,
        department: message.sender_department || null,
      },

      type: message.message_type,

      text: message.content || null,

      timestamp: message.created_at,

      attachments: message.attachments.map((attachment) => ({
        type: attachment.attachment_type,
        name: attachment.file_name,
        path: attachment.file_path,
      })),
    })),
  };
}

module.exports = {
  prepareDailyBatch,
};