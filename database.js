const Database = require("better-sqlite3");
const path = require("path");

const dbPath =
  process.env.DATABASE_PATH ||
  path.join(__dirname, "data", "lark-bot.db");

const db = new Database(dbPath);

// Le Cameroun est a UTC+1 sans heure d ete, alors que SQLite stocke
// CURRENT_TIMESTAMP en UTC. Sans ce decalage, un message envoye a
// 00h30 heure locale est classe dans la journee precedente.
const TZ_OFFSET = process.env.DB_TZ_OFFSET || "+1 hours";

function localToday() {
  return db.prepare("SELECT DATE(CURRENT_TIMESTAMP, ?) AS d").get(TZ_OFFSET).d;
}

// Les comptes rendus d'une journee arrivent surtout entre 17h le jour meme
// et 10h le lendemain. Une journee de rapport ne peut donc pas etre une
// journee calendaire : le rapport du jour D couvre la fenetre
// [D 10h00, D+1 10h00[. Les fenetres sont contigues, donc chaque message
// appartient a une seule journee de rapport et rien n'est perdu.
const WINDOW_START_HOUR = Number(process.env.DIGEST_WINDOW_START_HOUR || 10);

function reportWindow(date) {
  const heure = String(WINDOW_START_HOUR).padStart(2, "0");
  const debut = `${date} ${heure}:00:00`;

  const fin = db.prepare(
    "SELECT DATETIME(?, '+1 day') AS f"
  ).get(debut).f;

  return { debut, fin };
}

// Derniere journee de rapport dont la fenetre est completement fermee.
function localReportDate() {
  return db.prepare(
    "SELECT DATE(CURRENT_TIMESTAMP, ?, ?, '-1 day') AS d"
  ).get(TZ_OFFSET, `-${WINDOW_START_HOUR} hours`).d;
}

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


db.exec(`
  CREATE TABLE IF NOT EXISTS report_numbers (
    report_date TEXT PRIMARY KEY,
    number INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);


// Le rapport porte un numero d'ordre administratif (N° 011 / AM / DRH / ADRH).
// Une date donnee conserve toujours le meme numero, meme si le rapport est
// regenere via /rapport : sinon le meme jour recevrait deux numeros.
const NUMERO_DEPART = Number(process.env.RAPPORT_NUMERO_DEPART || 12);

function allocateReportNumber(date) {
  const existant = db.prepare(`
    SELECT number FROM report_numbers WHERE report_date = ?
  `).get(date);

  if (existant) {
    return existant.number;
  }

  const max = db.prepare(`SELECT MAX(number) AS n FROM report_numbers`).get().n;
  const suivant = max === null ? NUMERO_DEPART : max + 1;

  db.prepare(`
    INSERT INTO report_numbers (report_date, number) VALUES (?, ?)
  `).run(date, suivant);

  return suivant;
}


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


// À appeler si le traitement échoue : sans cela le message reste
// réservé pour toujours et Lark ne peut plus le relivrer.
function releaseMessage(messageId) {
  return db.prepare(`
    DELETE FROM received_messages
    WHERE message_id = ?
  `).run(messageId);
}


function getDailyBatch(date = null) {
  const targetDate = date || localReportDate();
  const { debut, fin } = reportWindow(targetDate);

  const messages = db.prepare(`
    SELECT
      m.*,
      u.name AS sender_name,
      u.email AS sender_email,
      u.department AS sender_department,
      DATETIME(m.created_at, ?) AS local_time
    FROM messages m
    LEFT JOIN users u
      ON u.open_id = m.sender_id
    WHERE DATETIME(m.created_at, ?) >= ?
      AND DATETIME(m.created_at, ?) < ?
    ORDER BY m.created_at ASC
  `).all(TZ_OFFSET, TZ_OFFSET, debut, TZ_OFFSET, fin);

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
      user_id = COALESCE(excluded.user_id, user_id),
      union_id = COALESCE(excluded.union_id, union_id),
      name = COALESCE(excluded.name, name),
      email = COALESCE(excluded.email, email),
      department = COALESCE(excluded.department, department),
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
    releaseMessage,
    localToday,
    allocateReportNumber,
    localReportDate,
    reportWindow,

};