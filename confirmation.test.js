const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "confirmation-")),
  "test.db"
);

const { repondre } = require("./agent");
const { oublier } = require("./conversation");
const { appelerEcriture, declarationsEcriture } = require("./outils-ecriture");
const { enAttente, action, tourHumain } = require("./actions");
const { db } = require("./database");

require("./hr");

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
// Rien ne s'ecrit sans que la DRH l'ait dit
//
// Le piege n'est pas qu'un modele refuse de demander l'accord : c'est qu'il se
// le donne lui-meme, en appelant la proposition puis la confirmation dans le
// meme souffle. Une consigne n'y change rien -- le 19 septembre, « n'invente
// jamais » n'a pas empeche six absences fabriquees d'entrer en base.
//
// La garde est donc arithmetique : la proposition retient combien de fois la
// DRH a parle dans ce salon, et ne s'execute que si ce nombre a augmente. Ces
// tests attaquent precisement cette garde.
// ---------------------------------------------------------------------------

db.prepare(
  `INSERT INTO employees (nom_complet, cle_nom, suivi_presence, mode_travail)
   VALUES (?, ?, 1, 'PRESENTIEL')`
).run("SOH ROMUALD", "SOH ROMUALD");

const CHAT = "salon-essai";
const CONTEXTE = { chatId: CHAT, declare_par: "DRH (essai)" };


function appel(id, nom, args = {}) {
  return {
    id,
    type: "function",
    function: { name: nom, arguments: JSON.stringify(args) },
  };
}


function modeleScripte(reponses) {
  let i = 0;

  return async () => {
    const reponse = reponses[Math.min(i, reponses.length - 1)];

    i++;

    return {
      texte: reponse.texte || "",
      appels: reponse.appels || [],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      modele: "simule",
    };
  };
}


(async () => {
  // --- Une ecriture ne s'execute pas quand elle est demandee --------------
  await verifier("un outil d'ecriture depose une proposition, il n'ecrit pas", async () => {
    oublier(CHAT);

    // Un message d'utilisateur, pour que l'horloge humaine existe.
    require("./conversation").ajouter({
      chat_id: CHAT, role: "user", contenu: "Soh était en mission lundi.",
    });

    const r = await appelerEcriture(
      "proposer_absence",
      {
        personne: "SOH ROMUALD",
        type: "MISSION",
        date_debut: "2026-09-21",
        motif: "Douala",
      },
      CONTEXTE
    );

    assert.strictEqual(r.propose, true);
    assert.strictEqual(r.confirmation_requise, true);
    assert.ok(r.id, "aucun numero de proposition");
    assert.ok(/SOH ROMUALD/.test(r.resume), `resume muet : ${r.resume}`);

    // Rien en base.
    const enregistrees = db
      .prepare(`SELECT COUNT(*) AS n FROM absences`)
      .get().n;

    assert.strictEqual(enregistrees, 0, "l'absence a été écrite sans accord");
  });

  // --- Le coeur : pas d'auto-confirmation --------------------------------
  await verifier("se confirmer dans le meme tour est refuse", async () => {
    const [proposition] = enAttente(CHAT);

    assert.ok(proposition, "aucune proposition en attente");

    const r = await appelerEcriture("confirmer_action", { id: proposition.id }, CONTEXTE);

    assert.strictEqual(r.execute, false);
    assert.ok(
      /n'a pas encore répondu/i.test(r.refus),
      `motif inattendu : ${r.refus}`
    );

    assert.strictEqual(
      db.prepare(`SELECT COUNT(*) AS n FROM absences`).get().n,
      0,
      "l'absence est passée malgré le refus"
    );
  });

  await verifier("apres un message de la DRH, la confirmation passe", async () => {
    const [proposition] = enAttente(CHAT);

    // La DRH parle : l'horloge humaine avance.
    require("./conversation").ajouter({
      chat_id: CHAT, role: "user", contenu: "oui, c'est ça",
    });

    const r = await appelerEcriture("confirmer_action", { id: proposition.id }, CONTEXTE);

    assert.strictEqual(r.execute, true, `refus : ${r.refus || r.erreur}`);
    assert.strictEqual(
      db.prepare(`SELECT COUNT(*) AS n FROM absences`).get().n,
      1,
      "l'absence n'a pas été écrite"
    );
    assert.strictEqual(action(proposition.id).statut, "EXECUTEE");
  });

  await verifier("une proposition ne s'execute pas deux fois", async () => {
    const executee = db
      .prepare(`SELECT id FROM actions_en_attente WHERE statut = 'EXECUTEE'`)
      .get();

    require("./conversation").ajouter({
      chat_id: CHAT, role: "user", contenu: "encore",
    });

    const r = await appelerEcriture("confirmer_action", { id: executee.id }, CONTEXTE);

    assert.strictEqual(r.execute, false);
    assert.ok(/déjà/i.test(r.refus), `motif inattendu : ${r.refus}`);
    assert.strictEqual(
      db.prepare(`SELECT COUNT(*) AS n FROM absences`).get().n,
      1,
      "l'absence a été écrite deux fois"
    );
  });

  await verifier("une proposition d'une autre conversation est refusee", async () => {
    require("./conversation").ajouter({
      chat_id: CHAT, role: "user", contenu: "une autre",
    });

    const r = await appelerEcriture(
      "proposer_consigne",
      { texte: "Tutoie-moi." },
      CONTEXTE
    );

    require("./conversation").ajouter({
      chat_id: "autre-salon", role: "user", contenu: "confirme pour moi",
    });

    const vol = await appelerEcriture(
      "confirmer_action",
      { id: r.id },
      { chatId: "autre-salon", declare_par: "quelqu'un d'autre" }
    );

    assert.strictEqual(vol.execute, false);
    assert.ok(/autre conversation/i.test(vol.refus), `motif : ${vol.refus}`);
  });

  await verifier("un refus annule la proposition", async () => {
    const ouvertes = enAttente(CHAT);
    const proposition = ouvertes[ouvertes.length - 1];

    const r = await appelerEcriture("annuler_action", { id: proposition.id }, CONTEXTE);

    assert.strictEqual(r.annule, true);
    assert.strictEqual(action(proposition.id).statut, "ANNULEE");
  });

  await verifier("une proposition annulee ne peut plus etre confirmee", async () => {
    const annulee = db
      .prepare(`SELECT id FROM actions_en_attente WHERE statut = 'ANNULEE'`)
      .get();

    require("./conversation").ajouter({
      chat_id: CHAT, role: "user", contenu: "ah si finalement",
    });

    const r = await appelerEcriture("confirmer_action", { id: annulee.id }, CONTEXTE);

    assert.strictEqual(r.execute, false);
    assert.ok(/annulée/i.test(r.refus), `motif : ${r.refus}`);
  });

  // --- Ce qui est refuse AVANT meme d'etre propose ------------------------
  await verifier("un nom inconnu du registre n'est pas propose", async () => {
    const r = await appelerEcriture(
      "proposer_absence",
      { personne: "BERNARD KOUAM", type: "CONGE", date_debut: "2026-09-21" },
      CONTEXTE
    );

    assert.ok(r.erreur, "une proposition a été déposée sur un inconnu");
    assert.ok(/registre du personnel/i.test(r.erreur));
    assert.ok(!r.propose);
  });

  await verifier("un type d'absence invalide n'est pas propose", async () => {
    const r = await appelerEcriture(
      "proposer_absence",
      { personne: "SOH ROMUALD", type: "VACANCES", date_debut: "2026-09-21" },
      CONTEXTE
    );

    assert.ok(r.erreur, "un type inconnu est passé");
  });

  await verifier("trancher une absence qui n'attend rien est refuse", async () => {
    const r = await appelerEcriture(
      "proposer_arbitrage_absence",
      { date: "2026-09-21", personne: "SOH ROMUALD", statut: "ABSENT" },
      CONTEXTE
    );

    assert.ok(r.erreur, "un arbitrage sans question posée est passé");
    assert.ok(/n'attend aucune décision/i.test(r.erreur));
  });

  await verifier("un parametre manquant n'est pas propose", async () => {
    const r = await appelerEcriture("proposer_absence", { personne: "SOH ROMUALD" }, CONTEXTE);

    assert.ok(r.erreur && /manquant/i.test(r.erreur));
  });

  await verifier("sans conversation identifiee, rien n'est propose", async () => {
    const r = await appelerEcriture("proposer_consigne", { texte: "x" }, {});

    assert.ok(r.erreur, "une proposition sans salon a été acceptée");
  });

  // --- La boucle complete, telle qu'elle se deroulera dans Lark -----------
  await verifier("dans la boucle : proposer, presenter, puis executer", async () => {
    oublier("boucle");

    // Tour 1 : la DRH demande, le modele propose et s'arrete.
    const premier = await repondre({
      chatId: "boucle",
      texte: "Retiens que je veux le rapport avant 16h.",
      generateur: modeleScripte([
        {
          appels: [
            appel("p1", "proposer_consigne", { texte: "Le rapport avant 16h." }),
          ],
        },
        { texte: "Je retiens : « Le rapport avant 16h. » Tu confirmes ?" },
      ]),
    });

    assert.ok(/confirmes/i.test(premier.texte), "la proposition n'est pas presentee");

    const ouvertes = enAttente("boucle");

    assert.strictEqual(ouvertes.length, 1, "aucune proposition en attente");

    // Tour 2 : elle accepte. L'horloge humaine a avance, donc cela passe.
    const second = await repondre({
      chatId: "boucle",
      texte: "oui",
      generateur: modeleScripte([
        { appels: [appel("c1", "confirmer_action", { id: ouvertes[0].id })] },
        { texte: "C'est retenu." },
      ]),
    });

    assert.ok(second.outils.some((o) => o.nom === "confirmer_action"));
    assert.strictEqual(action(ouvertes[0].id).statut, "EXECUTEE");
    assert.strictEqual(enAttente("boucle").length, 0);
  });

  await verifier("la boucle refuse l'auto-confirmation", async () => {
    oublier("triche");

    // Le modele propose PUIS confirme, sans laisser la DRH parler.
    const r = await repondre({
      chatId: "triche",
      texte: "Note que je prefere le matin.",
      generateur: modeleScripte([
        {
          appels: [appel("p1", "proposer_consigne", { texte: "Je prefere le matin." })],
        },
        { appels: [appel("c1", "confirmer_action", { id: 999999 })] },
        { texte: "Fait." },
      ]),
    });

    const confirmation = r.outils.find((o) => o.nom === "confirmer_action");

    assert.ok(confirmation, "confirmer_action n'a pas ete appele");

    // Quelle que soit la façon dont il s'y prend, rien ne doit s'executer.
    const executees = db
      .prepare(`SELECT COUNT(*) AS n FROM actions_en_attente
                WHERE chat_id = 'triche' AND statut = 'EXECUTEE'`)
      .get().n;

    assert.strictEqual(executees, 0, "une auto-confirmation est passee");
  });

  // --- L'horloge humaine ---------------------------------------------------
  await verifier("l'horloge n'avance que quand un humain parle", () => {
    const avant = tourHumain("horloge");

    require("./conversation").ajouter({
      chat_id: "horloge", role: "assistant", contenu: "je parle tout seul",
    });
    require("./conversation").ajouter({
      chat_id: "horloge", role: "tool", contenu: "{}", outil: "aujourdhui",
    });

    assert.strictEqual(tourHumain("horloge"), avant, "un tour du modele a fait avancer l'horloge");

    require("./conversation").ajouter({
      chat_id: "horloge", role: "user", contenu: "moi",
    });

    assert.strictEqual(tourHumain("horloge"), avant + 1);
  });

  await verifier("les outils d'ecriture sont tous declares", () => {
    const noms = declarationsEcriture().map((d) => d.function.name);

    for (const attendu of [
      "proposer_production_rapport",
      "proposer_absence",
      "proposer_correction_pointage",
      "proposer_arbitrage_absence",
      "proposer_consigne",
      "confirmer_action",
      "annuler_action",
    ]) {
      assert.ok(noms.includes(attendu), `${attendu} n'est pas declare`);
    }
  });

  await verifier("aucun outil ne publie", () => {
    const noms = declarationsEcriture().map((d) => d.function.name);

    assert.ok(
      !noms.some((n) => /publi|envoy|diffus/i.test(n)),
      "un outil de publication existe alors que la tranche 4 n'est pas faite"
    );
  });

  console.log(`${reussis} verifications passees (confirmation).`);
})();
