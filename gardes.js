require("dotenv").config();

const fs = require("fs");
const path = require("path");

const { db } = require("./database");

// ---------------------------------------------------------------------------
// Les gardes du soir
//
// Une personne de garde le soir peut arriver jusqu'a 10h30 le lendemain sans
// etre en retard. Le bot ne peut appliquer cette regle que s'il connait le
// planning de la semaine. Quand celui-ci n'est pas passe, rien ne le dit :
// tout le monde est simplement attendu a 08h30 et l'equipe du soir ressort en
// retard chaque matin.
//
//   node gardes.js                      ce que le bot sait des gardes
//   node gardes.js --fichier <planning> charge un planning depuis le disque
// ---------------------------------------------------------------------------

function etat() {
  const total = db.prepare("SELECT COUNT(*) AS n FROM shift_schedule").get().n;

  if (!total) {
    console.log(
      "\nAucune garde enregistree.\n\n" +
      "Le planning hebdomadaire n'est jamais arrive jusqu'a la base. Tout le\n" +
      "monde est donc attendu a 08h30, et les gardes du soir ressortent en\n" +
      "retard le lendemain matin.\n"
    );
  } else {
    const jours = db.prepare(`
      SELECT s.date,
             GROUP_CONCAT(COALESCE(e.nom_complet, s.employee_id), ', ') AS noms
      FROM shift_schedule s
      LEFT JOIN employees e ON e.id = s.employee_id
      WHERE s.type_poste = 'SOIR'
      GROUP BY s.date
      ORDER BY s.date DESC
      LIMIT 21
    `).all();

    console.log(`\n${total} garde(s) enregistree(s). Les plus recentes :\n`);

    for (const jour of jours) {
      console.log(`  ${jour.date} : ${jour.noms}`);
    }
  }

  // Un planning recu mais mal lu laisse une trace ici, pas dans la table des
  // gardes : c'est la difference entre "jamais envoye" et "envoye en vain".
  const recus = db.prepare(`
    SELECT created_at, expediteur_nom, fichiers, intention, resultat, detail
    FROM journal
    WHERE intention = 'PLANNING'
    ORDER BY id DESC
    LIMIT 10
  `).all();

  console.log(
    recus.length
      ? `\n${recus.length} planning(s) recu(s) par le bot :`
      : `\nAucun planning n'a jamais ete reconnu comme tel par le bot.\n` +
        `Un document envoye mais lu comme autre chose n'alimente pas les gardes.`
  );

  for (const recu of recus) {
    console.log(
      `  ${recu.created_at}  ${recu.expediteur_nom || "?"}  ` +
      `${recu.fichiers || "(sans fichier)"}  ${recu.resultat}` +
      (recu.detail ? ` - ${recu.detail.slice(0, 80)}` : "")
    );
  }

  const enRevue = db.prepare(`
    SELECT date, nom_brut, motif
    FROM attendance_review
    WHERE motif LIKE 'planning%'
    ORDER BY date DESC
    LIMIT 20
  `).all();

  if (enRevue.length) {
    console.log(
      `\n${enRevue.length} nom(s) du planning non rattache(s) au registre.\n` +
      `Ces personnes ne beneficieront pas de l'arrivee a 10h30 :`
    );

    for (const ligne of enRevue) {
      console.log(`  ${ligne.date} : ${ligne.nom_brut}`);
    }
  }

  console.log(
    `\nCharger un planning depuis le disque :\n` +
    `  node gardes.js --fichier "downloads/mon-planning.pdf"\n`
  );
}


async function charger(chemin) {
  if (!fs.existsSync(chemin)) {
    console.error(`Fichier introuvable : ${chemin}`);
    process.exitCode = 1;
    return;
  }

  const { extrairePlanning } = require("./extraction");

  console.log(`Lecture de ${path.basename(chemin)}...`);

  const resultat = await extrairePlanning(chemin);

  console.log(
    `\nPeriode lue : ${resultat.periode[0] || "?"} a ${resultat.periode[1] || "?"}\n` +
    `${resultat.jours} journee(s), ${resultat.enregistres} garde(s) enregistree(s).`
  );

  if (resultat.en_revue) {
    console.log(
      `\n${resultat.en_revue} nom(s) non rattache(s) au registre du personnel.\n` +
      `Ces personnes resteront attendues a 08h30 :`
    );

    for (const divergence of resultat.divergences) {
      console.log(`  ${divergence.date} : ${divergence.nom_brut}`);
    }

    console.log(
      `\nAjoutez l'orthographe employee dans les alias du registre, puis\n` +
      `rechargez ce planning.`
    );
  }

  etat();
}


const index = process.argv.indexOf("--fichier");

if (index !== -1 && process.argv[index + 1]) {
  charger(process.argv[index + 1]).catch((erreur) => {
    console.error(erreur);
    process.exitCode = 1;
  });
} else {
  etat();
}
