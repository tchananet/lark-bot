const { getDailyBatch, localToday } = require("./database");

function prepareDailyBatch(date = null) {
  const messages = getDailyBatch(date);

  return {
    date: date || localToday(),

    total_messages: messages.length,

    messages: messages.map((message) => ({
      sender: {
        id: message.sender_id,
        name: message.sender_name || message.sender_id,
        email: message.sender_email || null,
        department: message.sender_department || null,
      },

      type: message.message_type,

      text: message.content || null,

      timestamp: message.local_time || message.created_at,

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