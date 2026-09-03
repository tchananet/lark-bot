const { getDailyBatch, localReportDate, reportWindow } = require("./database");

function prepareDailyBatch(date = null) {
  const reportDate = date || localReportDate();
  const messages = getDailyBatch(reportDate);
  const fenetre = reportWindow(reportDate);

  return {
    date: reportDate,

    // Fenetre de collecte reellement couverte par ce rapport.
    fenetre,

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