const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "odoo-ecriture-")),
  "test.db"
);

// Memes identifiants bidon pour chaque test : jamais utilises reellement,
// puisque odoo.js est entierement mocke ci-dessous, mais variable() leve une
// erreur si l'un d'eux manque -- meme si le code mocke ne l'appelle jamais,
// require("./odoo") pourrait un jour y toucher au chargement.
process.env.ODOO_URL = "http://odoo.test";
process.env.ODOO_DB = "test";
process.env.ODOO_USER = "test";
process.env.ODOO_PASSWORD = "test";

require("./hr");

const { db } = require("./database");

// odoo.js est requis UNE FOIS ici et ses fonctions sont remplacees. Comme
// outils-ecriture.js ne le requiert qu'a l'interieur de executer() (require
// tardif), il recoit cette meme instance mockee -- memecanique que pour
// ia.js dans les autres tests de cette semaine.
const odoo = require("./odoo");

let employeOdooAResoudre = null;
let typeCongeAResoudre = { id: 6, name: "Permission" };
const appelsCreer = [];
const appelsEcrire = [];

odoo.resoudreEmployeOdoo = async () => employeOdooAResoudre;
odoo.obtenirTypeConge = async () => typeCongeAResoudre;
odoo.creer = async (model, valeurs) => {
  appelsCreer.push({ model, valeurs });
  return 1000 + appelsCreer.length;
};
odoo.ecrire = async (model, id, valeurs) => {
  appelsEcrire.push({ model, id, valeurs });
  return true;
};

const { appelerEcriture } = require("./outils-ecriture");
const { enAttente } = require("./actions");
const { ajouter } = require("./conversation");

let reussis = 0;

async function verifier(intitule, fn) {
  try {
    await fn();
    reussis++;
  } catch (erreur) {
    console.error(`ECHEC : ${intitule}\n  ${erreur.message}`);
    process.exitCode = 1;
  }
}

function ajouterEmploye(nom) {
  db.prepare(
    `INSERT INTO employees (nom_complet, cle_nom, suivi_presence, mode_travail)
     VALUES (?, ?, 1, 'PRESENTIEL')`
  ).run(nom, nom);
}

const CONTEXTE = { chatId: "salon-odoo", declare_par: "DRH (essai)" };

function messageHumain(texte) {
  ajouter({ chat_id: CONTEXTE.chatId, role: "user", contenu: texte });
}

async function proposerEtConfirmer(nom, args) {
  const proposition = await appelerEcriture(nom, args, CONTEXTE);

  assert.strictEqual(proposition.propose, true, `proposition refusee : ${proposition.erreur}`);

  messageHumain("oui");

  const resultat = await appelerEcriture(
    "confirmer_action",
    { id: proposition.id },
    CONTEXTE
  );

  return { proposition, resultat };
}

// ---------------------------------------------------------------------------
// proposer_permission et proposer_mesure_disciplinaire ecrivent dans Odoo,
// pas dans notre base SQLite -- mais suivent EXACTEMENT la meme discipline
// que tout le reste : verifier avant de proposer, ne jamais ecrire avant la
// confirmation, et un tour humain doit separer la demande de l'accord.
//
// Un point propre a la permission : la DRH peut soit signaler une DEMANDE en
// cours (A_APPROUVER, le statut hr.leave par defaut), soit un fait deja
// tranche ("X est en permission aujourd'hui" -- DEJA_APPROUVEE). Dans ce
// second cas seulement, un second appel Odoo force state=validate ; dans le
// premier, la ligne reste telle qu'Odoo l'a creee.
// ---------------------------------------------------------------------------

ajouterEmploye("NGA ISABELLE");

(async () => {
  await verifier(
    "permission A_APPROUVER : creee dans Odoo, jamais validee automatiquement",
    async () => {
      employeOdooAResoudre = { id: 51, name: "NGA ISABELLE SANDRINE" };
      appelsCreer.length = 0;
      appelsEcrire.length = 0;

      const { resultat } = await proposerEtConfirmer("proposer_permission", {
        personne: "NGA ISABELLE",
        date_debut: "2026-10-23",
        statut: "A_APPROUVER",
      });

      assert.strictEqual(resultat.execute, true, `refus : ${resultat.refus || resultat.erreur}`);
      assert.strictEqual(appelsCreer.length, 1);
      assert.strictEqual(appelsCreer[0].model, "hr.leave");
      assert.strictEqual(appelsCreer[0].valeurs.employee_id, 51);
      assert.strictEqual(appelsCreer[0].valeurs.holiday_status_id, 6);
      assert.strictEqual(appelsEcrire.length, 0, "A_APPROUVER ne doit pas forcer de validation");
    }
  );

  await verifier(
    "permission DEJA_APPROUVEE : creee puis immediatement validee",
    async () => {
      employeOdooAResoudre = { id: 51, name: "NGA ISABELLE SANDRINE" };
      appelsCreer.length = 0;
      appelsEcrire.length = 0;

      const { resultat } = await proposerEtConfirmer("proposer_permission", {
        personne: "NGA ISABELLE",
        date_debut: "2026-10-24",
        statut: "DEJA_APPROUVEE",
      });

      assert.strictEqual(resultat.execute, true, `refus : ${resultat.refus || resultat.erreur}`);
      assert.strictEqual(appelsCreer.length, 1);
      assert.strictEqual(appelsEcrire.length, 1, "DEJA_APPROUVEE doit forcer la validation");
      assert.strictEqual(appelsEcrire[0].valeurs.state, "validate");
      assert.strictEqual(appelsEcrire[0].id, resultat.odoo_id, "l'id valide doit etre celui qui vient d'etre cree");
    }
  );

  await verifier(
    "se confirmer dans le meme tour est refuse, meme pour une ecriture Odoo",
    async () => {
      employeOdooAResoudre = { id: 51, name: "NGA ISABELLE SANDRINE" };
      appelsCreer.length = 0;

      const proposition = await appelerEcriture(
        "proposer_permission",
        { personne: "NGA ISABELLE", date_debut: "2026-10-25", statut: "A_APPROUVER" },
        CONTEXTE
      );

      const resultat = await appelerEcriture(
        "confirmer_action",
        { id: proposition.id },
        CONTEXTE
      );

      assert.strictEqual(resultat.execute, false);
      assert.strictEqual(appelsCreer.length, 0, "aucune ecriture avant un vrai tour humain");
    }
  );

  await verifier(
    "une personne inconnue du registre local n'est jamais proposee",
    async () => {
      appelsCreer.length = 0;

      const proposition = await appelerEcriture(
        "proposer_permission",
        { personne: "PERSONNE INCONNUE", date_debut: "2026-10-23", statut: "A_APPROUVER" },
        CONTEXTE
      );

      assert.ok(proposition.erreur, "une proposition a ete deposee sur un inconnu");
      assert.strictEqual(appelsCreer.length, 0);
    }
  );

  await verifier(
    "un employe non retrouve cote Odoo echoue proprement a l'execution",
    async () => {
      employeOdooAResoudre = null;
      appelsCreer.length = 0;

      const { resultat } = await proposerEtConfirmer("proposer_permission", {
        personne: "NGA ISABELLE",
        date_debut: "2026-10-23",
        statut: "A_APPROUVER",
      });

      assert.strictEqual(resultat.execute, false);
      assert.ok(/aucun employé correspondant/i.test(resultat.erreur || ""), resultat.erreur);
      assert.strictEqual(appelsCreer.length, 0, "rien ne doit etre ecrit sans employe Odoo resolu");
    }
  );

  await verifier(
    "le type de conge « Permission » absent d'Odoo echoue proprement",
    async () => {
      employeOdooAResoudre = { id: 51, name: "NGA ISABELLE SANDRINE" };
      typeCongeAResoudre = null;
      appelsCreer.length = 0;

      const { resultat } = await proposerEtConfirmer("proposer_permission", {
        personne: "NGA ISABELLE",
        date_debut: "2026-10-23",
        statut: "A_APPROUVER",
      });

      assert.strictEqual(resultat.execute, false);
      assert.ok(/type de congé/i.test(resultat.erreur || ""), resultat.erreur);
      assert.strictEqual(appelsCreer.length, 0);

      typeCongeAResoudre = { id: 6, name: "Permission" };
    }
  );

  await verifier(
    "mesure disciplinaire : creee dans Odoo avec le bon type",
    async () => {
      employeOdooAResoudre = { id: 51, name: "NGA ISABELLE SANDRINE" };
      appelsCreer.length = 0;

      const { resultat } = await proposerEtConfirmer("proposer_mesure_disciplinaire", {
        personne: "NGA ISABELLE",
        type: "Avertissement écrit",
        date: "2026-10-23",
        motif: "Retards repetes",
      });

      assert.strictEqual(resultat.execute, true, `refus : ${resultat.refus || resultat.erreur}`);
      assert.strictEqual(appelsCreer.length, 1);
      assert.strictEqual(appelsCreer[0].model, "x_mesure_disciplinaire");
      assert.strictEqual(appelsCreer[0].valeurs.x_employee_id, 51);
      assert.strictEqual(appelsCreer[0].valeurs.x_type, "Avertissement écrit");
      assert.strictEqual(appelsCreer[0].valeurs.x_motif, "Retards repetes");
    }
  );

  await verifier(
    "un type de mesure disciplinaire inconnu n'est pas propose",
    async () => {
      appelsCreer.length = 0;

      const proposition = await appelerEcriture(
        "proposer_mesure_disciplinaire",
        { personne: "NGA ISABELLE", type: "Licenciement", date: "2026-10-23" },
        CONTEXTE
      );

      assert.ok(proposition.erreur, "un type hors liste a ete propose");
      assert.strictEqual(appelsCreer.length, 0);
    }
  );

  console.log(`${reussis} verifications passees (odoo-ecriture).`);
})();
