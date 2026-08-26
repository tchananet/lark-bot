const Database = require("better-sqlite3");
const path = require("path");

const dbPath =
  process.env.DATABASE_PATH ||
  path.join(__dirname, "data", "lark-bot.db");

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    message_id TEXT UNIQUE NOT NULL,
    chat_id TEXT NOT NULL,
    sender_id TEXT,
    message_type TEXT NOT NULL,

    content TEXT,
    file_name TEXT,
    file_path TEXT,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);


db.exec(`
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    attachment_type TEXT NOT NULL,
    file_name TEXT,
    file_key TEXT,
    file_path TEXT,
    duration_ms INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (message_id)
      REFERENCES messages(message_id)
      ON DELETE CASCADE
  )
`);


db.exec(`
  CREATE TABLE IF NOT EXISTS received_messages (
    message_id TEXT PRIMARY KEY,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);



db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    open_id TEXT PRIMARY KEY,
    user_id TEXT,
    union_id TEXT,

    name TEXT,
    department TEXT,
    service TEXT,
    job_title TEXT,
    manager TEXT,
    email TEXT,

    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);


function claimMessage(messageId) {
  // Déjà réellement enregistré auparavant ?
  const existingMessage = db.prepare(`
    SELECT 1
    FROM messages
    WHERE message_id = ?
    LIMIT 1
  `).get(messageId);

  if (existingMessage) {
    return false;
  }

  // Déjà en cours de traitement ?
  const result = db.prepare(`
    INSERT OR IGNORE INTO received_messages (message_id)
    VALUES (?)
  `).run(messageId);

  return result.changes === 1;
}


function getDailyBatch(date = null) {
  const targetDate =
    date || new Date().toISOString().slice(0, 10);

  const messages = db.prepare(`
    SELECT
      m.*,
      u.name AS sender_name,
      u.email AS sender_email,
      u.department AS sender_department
    FROM messages m
    LEFT JOIN users u
      ON u.open_id = m.sender_id
    WHERE DATE(m.created_at) = ?
    ORDER BY m.created_at ASC
  `).all(targetDate);

  const attachmentQuery = db.prepare(`
    SELECT *
    FROM attachments
    WHERE message_id = ?
    ORDER BY id ASC
  `);

  return messages.map((message) => ({
    ...message,
    attachments: attachmentQuery.all(message.message_id),
  }));
}



function saveUser(data) {
  const stmt = db.prepare(`
    INSERT INTO users (
      open_id,
      user_id,
      union_id,
      name,
      email,
      department
    )
    VALUES (?, ?, ?, ?, ?, ?)

    ON CONFLICT(open_id) DO UPDATE SET
      user_id = excluded.user_id,
      union_id = excluded.union_id,
      name = excluded.name,
      email = excluded.email,
      department = excluded.department,
      updated_at = CURRENT_TIMESTAMP
  `);

  return stmt.run(
    data.open_id,
    data.user_id || null,
    data.union_id || null,
    data.name || null,
    data.email || null,
    data.department || null
  );
}
 

  function saveAttachment(data) {
  const stmt = db.prepare(`
    INSERT INTO attachments (
      message_id,
      attachment_type,
      file_name,
      file_key,
      file_path
    )
    VALUES (?, ?, ?, ?, ?)
  `);

  return stmt.run(
    data.message_id,
    data.attachment_type,
    data.file_name || null,
    data.file_key || null,
    data.file_path || null
  );
}



function saveMessage(data) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages
    (
      message_id,
      chat_id,
      sender_id,
      message_type,
      content,
      file_name,
      file_path
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  return stmt.run(
    data.message_id,
    data.chat_id,
    data.sender_id,
    data.message_type,
    data.content || null,
    data.file_name || null,
    data.file_path || null
  );
}

module.exports = {
  db,
  saveMessage,
  saveAttachment,
  saveUser,
    getDailyBatch,
    claimMessage,

};