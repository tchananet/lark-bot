require("dotenv").config();

const { db } = require("./database");

// Etat reel de la base. A lancer dans le conteneur pour savoir ce qui a ete
// collecte, sans passer par l'interface ni par du SQL a la main.

const TABLES = [
  ["messages", "comptes rendus et messages recus"],
  ["attachments", "pieces jointes telechargees"],
  ["users", "comptes Lark ayant ecrit au bot"],
  ["employees", "registre du personnel (seed-hr.js)"],
  ["employee_aliases", "variantes de noms"],
  ["attendance", "pointages extraits des fiches"],
  ["attendance_review", "cellules a trancher"],
  ["shift_schedule", "gardes du soir"],
  ["absences", "permissions, conges, missions"],
  ["journal", "requetes journalisees"],
  ["report_numbers", "numeros de rapport attribues"],
];

function compter(table) {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  } catch (erreur) {
    return null;
  }
}

function periode(table) {
  try {
    const r = db.prepare(`
      SELECT MIN(created_at) AS debut, MAX(created_at) AS fin FROM ${table}
    `).get();

    return r.debut ? `${r.debut.slice(0, 16)} -> ${r.fin.slice(0, 16)}` : "";
  } catch (erreur) {
    return "";
  }
}

console.log(`Base : ${process.env.DATABASE_PATH || "data/lark-bot.db"}\n`);

for (const [table, description] of TABLES) {
  const n = compter(table);

  console.log(
    `${table.padEnd(20)} ${n === null ? "TABLE ABSENTE" : String(n).padStart(6)}` +
    `   ${description}` +
    (n ? `\n${" ".repeat(27)}${periode(table)}` : "")
  );
}

const messages = compter("messages");

console.log("\n--- lecture ---");

if (!compter("employees")) {
  console.log(
    "Le registre du personnel est VIDE. Rien ne peut fonctionner sans lui :\n" +
    "  docker compose exec lark-bot node seed-hr.js"
  );
}

if (messages) {
  console.log(`\n${messages} message(s) collecte(s). Repartition par jour :`);

  for (const r of db.prepare(`
    SELECT DATE(created_at) AS jour, COUNT(*) AS n,
           COUNT(DISTINCT sender_id) AS auteurs
    FROM messages GROUP BY jour ORDER BY jour DESC LIMIT 15
  `).all()) {
    console.log(`  ${r.jour}  ${String(r.n).padStart(4)} message(s)  ${r.auteurs} auteur(s)`);
  }
} else {
  console.log("\nAucun message enregistre : le bot n a rien recu, ou la base " +
    "utilisee n est pas celle du conteneur.");
}
