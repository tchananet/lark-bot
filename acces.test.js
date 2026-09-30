const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "acces-")),
  "test.db"
);

require("./hr");

const { db } = require("./database");
const { appelerEcriture } = require("./outils-ecriture");
const { appeler } = require("./outils");
const { enAttente } = require("./actions");

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

// ---------------------------------------------------------------------------
// La gestion des acces est la seule action ecartee de l'ancien aiguillage
// sans jamais avoir eu d'equivalent dans l'agent : « ajoute Gloria aux RH »
// n'avait aucun outil pour la recevoir. C'est une action sensible -- elle
// touche qui peut agir sur le systeme, pas seulement consulter -- donc elle
// suit exactement la meme discipline que le reste : verifier avant de
// proposer, proposer avant d'ecrire, jamais sans un accord venu d'un tour
// distinct.
// ---------------------------------------------------------------------------

const CONTEXTE = { chatId: "salon-acces", declare_par: "DRH (essai)" };

function ajouterEmploye(nom) {
  db.prepare(
    `INSERT INTO employees (nom_complet, cle_nom, suivi_presence, mode_travail)
     VALUES (?, ?, 1, 'PRESENTIEL')`
  ).run(nom, nom);
}

function lierCompteLarkDeTest(nom, openId) {
  db.prepare(
    `INSERT INTO users (open_id, name) VALUES (?, ?)
     ON CONFLICT(open_id) DO UPDATE SET name = excluded.name`
  ).run(openId, nom);
}

function employeParNom(nom) {
  return db.prepare(`SELECT * FROM employees WHERE nom_complet = ?`).get(nom);
}


(async () => {
  await verifier("un nom inconnu du registre n'est pas propose", async () => {
    const r = await appelerEcriture(
      "proposer_acces",
      { action: "AJOUTER", personne: "PERSONNE INCONNUE" },
      CONTEXTE
    );

    assert.ok(r.erreur, "une proposition a ete deposee sur un inconnu");
    assert.ok(!r.propose);
  });

  await verifier(
    "ajouter quelqu'un sans compte Lark connu n'est pas propose",
    async () => {
      ajouterEmploye("GLORIA SANS COMPTE");

      const r = await appelerEcriture(
        "proposer_acces",
        { action: "AJOUTER", personne: "GLORIA SANS COMPTE" },
        CONTEXTE
      );

      assert.ok(r.erreur, "une proposition a ete deposee sans compte Lark connu");
      assert.ok(/aucun compte Lark/i.test(r.erreur));
    }
  );

  await verifier(
    "un nom rattache a deux comptes Lark distincts n'est pas propose",
    async () => {
      ajouterEmploye("HOMONYME TEST");
      lierCompteLarkDeTest("HOMONYME TEST", "ou_homonyme_1");
      lierCompteLarkDeTest("HOMONYME TEST", "ou_homonyme_2");

      const r = await appelerEcriture(
        "proposer_acces",
        { action: "AJOUTER", personne: "HOMONYME TEST" },
        CONTEXTE
      );

      assert.ok(r.erreur, "une proposition a ete deposee malgre l'ambiguite");
      assert.ok(/plusieurs comptes/i.test(r.erreur));
    }
  );

  // --- Le coeur : proposer, puis seulement executer apres un tour humain ---
  await verifier("accorder l'acces est propose, pas ecrit immediatement", async () => {
    ajouterEmploye("NOUVELLE RH");
    lierCompteLarkDeTest("NOUVELLE RH", "ou_nouvelle_rh");

    require("./conversation").ajouter({
      chat_id: CONTEXTE.chatId, role: "user", contenu: "ajoute Nouvelle RH aux RH",
    });

    const r = await appelerEcriture(
      "proposer_acces",
      { action: "AJOUTER", personne: "NOUVELLE RH" },
      CONTEXTE
    );

    assert.strictEqual(r.propose, true);
    assert.ok(r.id, "aucun numero de proposition");
    assert.ok(/NOUVELLE RH/.test(r.resume));

    assert.strictEqual(employeParNom("NOUVELLE RH").role, null, "l'acces a ete ecrit sans confirmation");
  });

  await verifier("se confirmer dans le meme tour est refuse", async () => {
    const [proposition] = enAttente(CONTEXTE.chatId);

    const r = await appelerEcriture("confirmer_action", { id: proposition.id }, CONTEXTE);

    assert.strictEqual(r.execute, false);
    assert.strictEqual(employeParNom("NOUVELLE RH").role, null);
  });

  await verifier("apres un message humain, la confirmation accorde l'acces", async () => {
    const [proposition] = enAttente(CONTEXTE.chatId);

    require("./conversation").ajouter({
      chat_id: CONTEXTE.chatId, role: "user", contenu: "oui",
    });

    const r = await appelerEcriture("confirmer_action", { id: proposition.id }, CONTEXTE);

    assert.strictEqual(r.execute, true, `refus : ${r.refus || r.erreur}`);
    assert.strictEqual(employeParNom("NOUVELLE RH").role, "RH");
    assert.strictEqual(employeParNom("NOUVELLE RH").lark_open_id, "ou_nouvelle_rh");
  });

  // --- Retirer, avec la meme discipline -------------------------------------
  await verifier("retirer l'acces suit la meme discipline de confirmation", async () => {
    require("./conversation").ajouter({
      chat_id: CONTEXTE.chatId, role: "user", contenu: "retire Nouvelle RH",
    });

    const proposition = await appelerEcriture(
      "proposer_acces",
      { action: "RETIRER", personne: "NOUVELLE RH" },
      CONTEXTE
    );

    assert.strictEqual(proposition.propose, true);
    assert.strictEqual(employeParNom("NOUVELLE RH").role, "RH", "retire avant confirmation");

    require("./conversation").ajouter({
      chat_id: CONTEXTE.chatId, role: "user", contenu: "oui, retire-la",
    });

    const r = await appelerEcriture("confirmer_action", { id: proposition.id }, CONTEXTE);

    assert.strictEqual(r.execute, true, `refus : ${r.refus || r.erreur}`);
    assert.strictEqual(employeParNom("NOUVELLE RH").role, null);
  });

  // --- Le tool de lecture --------------------------------------------------
  await verifier("acces_actuels liste les personnes habilitees, rien de plus", () => {
    ajouterEmploye("DEJA RH");
    lierCompteLarkDeTest("DEJA RH", "ou_deja_rh");

    const { accorderRoleRH } = require("./hr");

    accorderRoleRH(employeParNom("DEJA RH").id, "ou_deja_rh");

    const r = appeler("acces_actuels", {});

    assert.ok(r.habilites.some((h) => h.nom_complet === "DEJA RH"));
    assert.ok(!r.habilites.some((h) => h.nom_complet === "NOUVELLE RH"), "l'acces retire ressort encore habilite");
  });

  await verifier("acces_actuels n'ecrit rien", () => {
    const source = fs.readFileSync(path.join(__dirname, "outils.js"), "utf8");

    assert.ok(
      !source.includes("accorderRoleRH") && !source.includes("retirerRoleRH"),
      "outils.js (lecture seule) importe une fonction d'ecriture des acces"
    );
  });

  console.log(`${reussis} verifications passees (acces).`);
})();
