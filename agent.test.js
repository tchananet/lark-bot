const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "agent-")),
  "test.db"
);

const { repondre, systeme, borner, TOURS_MAX } = require("./agent");
const { fil, oublier, ajouterConsigne } = require("./conversation");

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
// La boucle de l'assistant
//
// On verifie la mecanique, pas les reponses d'un modele : enchainer des
// outils, savoir s'arreter, ne pas tourner en rond, garder un fil relisible.
// Le modele est donc simule -- un vrai modele rendrait ces tests lents, chers
// et instables, et ne dirait rien de la boucle elle-meme.
// ---------------------------------------------------------------------------

// Un modele scripte : on lui donne d'avance la suite de ses reponses.
function modeleScripte(reponses) {
  const vues = [];
  let i = 0;

  const generateur = async ({ messages, outils }) => {
    vues.push({ messages, outils });

    const reponse = reponses[Math.min(i, reponses.length - 1)];

    i++;

    return {
      texte: reponse.texte || "",
      appels: reponse.appels || [],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      modele: "simule",
    };
  };

  return { generateur, vues, appels: () => i };
}


function appel(id, nom, args = {}) {
  return {
    id,
    type: "function",
    function: { name: nom, arguments: JSON.stringify(args) },
  };
}


(async () => {
  // --- Ce qu'il ne doit jamais croire pouvoir faire ------------------------
  await verifier("les instructions exigent un accord avant d'ecrire", () => {
    const s = systeme();

    assert.ok(
      /JAMAIS SANS SON ACCORD/i.test(s),
      "la regle de l'accord prealable n'est pas dite"
    );
    assert.ok(
      /jamais confirmer_action dans le meme tour/i.test(s),
      "rien n'interdit de se confirmer soi-meme"
    );
    assert.ok(
      /ne peux PAS publier/i.test(s),
      "la publication n'est pas exclue"
    );
    assert.ok(
      /N'annonce jamais avoir fait/i.test(s),
      "rien n'interdit d'annoncer une action non faite"
    );
  });

  await verifier("les consignes de la DRH figurent et priment", () => {
    const s = systeme();

    assert.ok(s.includes("CONSIGNES DE LA DRH"), "section absente");
    assert.ok(/absence sans me demander/i.test(s), "la consigne sur les absences manque");
  });

  await verifier("une consigne ajoutee se retrouve dans le contexte", () => {
    ajouterConsigne("Appelle-moi Vanauld, pas Monsieur.");

    assert.ok(systeme().includes("Appelle-moi Vanauld"));
  });

  // --- Repondre sans outil ------------------------------------------------
  await verifier("une reponse directe s'arrete au premier tour", async () => {
    oublier("c1");

    const m = modeleScripte([{ texte: "Bonjour." }]);

    const r = await repondre({
      chatId: "c1",
      texte: "bonjour",
      generateur: m.generateur,
    });

    assert.strictEqual(r.texte, "Bonjour.");
    assert.strictEqual(r.tours, 1);
    assert.strictEqual(r.outils.length, 0);
  });

  // --- Le coeur : consulter puis repondre ---------------------------------
  await verifier("un outil demande est execute, puis la reponse vient", async () => {
    oublier("c2");

    const m = modeleScripte([
      { appels: [appel("a1", "aujourdhui")] },
      { texte: "La semaine en cours n'est pas terminee." },
    ]);

    const r = await repondre({
      chatId: "c2",
      texte: "on peut faire le rapport de cette semaine ?",
      generateur: m.generateur,
    });

    assert.strictEqual(r.tours, 2);
    assert.deepStrictEqual(r.outils.map((o) => o.nom), ["aujourdhui"]);
    assert.ok(r.texte.includes("terminee"));
  });

  await verifier("deux outils dans un meme tour sont tous executes", async () => {
    oublier("c3");

    const m = modeleScripte([
      {
        appels: [
          appel("a1", "aujourdhui"),
          appel("a2", "rapports_disponibles", { du: "2026-09-21" }),
        ],
      },
      { texte: "Deux réponses, pour deux questions." },
    ]);

    const r = await repondre({
      chatId: "c3",
      texte: "est-ce possible ? et quels rapports sont dispo ?",
      generateur: m.generateur,
    });

    assert.deepStrictEqual(
      r.outils.map((o) => o.nom),
      ["aujourdhui", "rapports_disponibles"]
    );
  });

  // --- Le fil doit rester relisible par l'API -----------------------------
  await verifier("chaque resultat porte l'identifiant de son appel", async () => {
    const messages = fil("c3");
    const demande = messages.find((m) => m.role === "assistant" && m.tool_calls);
    const resultats = messages.filter((m) => m.role === "tool");

    assert.ok(demande, "aucune demande d'outil dans le fil");
    assert.strictEqual(resultats.length, 2);

    for (const resultat of resultats) {
      assert.ok(resultat.tool_call_id, "un resultat sans identifiant d'appel");
      assert.ok(
        demande.tool_calls.some((a) => a.id === resultat.tool_call_id),
        "un resultat ne correspond a aucune demande"
      );
    }
  });

  await verifier("le fil commence toujours par un message d'utilisateur", async () => {
    const messages = fil("c3");

    assert.strictEqual(messages[0].role, "user");
  });

  await verifier("le fil se souvient du tour precedent", async () => {
    oublier("c4");

    const m = modeleScripte([{ texte: "Premiere." }, { texte: "Seconde." }]);

    await repondre({ chatId: "c4", texte: "et lundi ?", generateur: m.generateur });
    await repondre({ chatId: "c4", texte: "et mardi ?", generateur: m.generateur });

    const vu = m.vues[1].messages.map((x) => x.content).join(" ");

    assert.ok(vu.includes("et lundi ?"), "le message precedent a ete oublie");
    assert.ok(vu.includes("Premiere."), "sa propre reponse a ete oubliee");
  });

  await verifier("deux conversations ne se melangent pas", async () => {
    const m = modeleScripte([{ texte: "Vu." }]);

    await repondre({ chatId: "c5", texte: "secret de c5", generateur: m.generateur });

    const vu = fil("c4").map((x) => x.content).join(" ");

    assert.ok(!vu.includes("secret de c5"));
  });

  // --- Les outils sont bien remis au modele -------------------------------
  await verifier("le modele recoit la liste des outils", async () => {
    oublier("c6");

    const m = modeleScripte([{ texte: "Vu." }]);

    await repondre({ chatId: "c6", texte: "bonjour", generateur: m.generateur });

    const noms = m.vues[0].outils.map((o) => o.function.name);

    assert.ok(noms.includes("aujourdhui"));
    assert.ok(noms.includes("etat_journee"));
    assert.ok(noms.length >= 10);
  });

  // --- Ce qui doit echouer proprement -------------------------------------
  await verifier("un outil inconnu ne fait pas tomber la conversation", async () => {
    oublier("c7");

    const m = modeleScripte([
      { appels: [appel("a1", "faire_le_cafe")] },
      { texte: "Je ne peux pas faire cela." },
    ]);

    const r = await repondre({
      chatId: "c7",
      texte: "fais-moi un cafe",
      generateur: m.generateur,
    });

    assert.strictEqual(r.outils[0].nom, "faire_le_cafe");
    assert.ok(r.outils[0].erreur, "l'erreur n'a pas ete rapportee");
    assert.ok(r.texte);
  });

  await verifier("des arguments illisibles sont rapportes, pas jetes", async () => {
    oublier("c8");

    const m = modeleScripte([
      {
        appels: [
          { id: "a1", type: "function", function: { name: "etat_journee", arguments: "{pas du json" } },
        ],
      },
      { texte: "Quelle journee exactement ?" },
    ]);

    const r = await repondre({
      chatId: "c8",
      texte: "etat de la journee",
      generateur: m.generateur,
    });

    assert.ok(r.outils[0].erreur, "aucune erreur rapportee");
    assert.ok(r.texte);
  });

  await verifier("un modele qui tourne en rond est arrete et le dit", async () => {
    oublier("c9");

    // Il redemande le meme outil indefiniment.
    const m = modeleScripte([{ appels: [appel("a1", "aujourdhui")] }]);

    const r = await repondre({
      chatId: "c9",
      texte: "et alors ?",
      generateur: m.generateur,
    });

    assert.strictEqual(r.plafond_atteint, true);
    assert.strictEqual(r.tours, TOURS_MAX);
    assert.ok(
      /n'arrive pas a conclure/i.test(r.texte),
      "l'aveu n'est pas adresse a la DRH"
    );
  });

  // --- Ce qui part dans le contexte doit rester borne ---------------------
  await verifier("un resultat enorme est tronque", () => {
    const gros = { texte: "x".repeat(50000) };
    const borne = borner(gros);

    assert.ok(borne.length < 7000, "le resultat n'a pas ete borne");
    assert.ok(borne.includes("tronque"), "la troncature n'est pas signalee");
  });

  await verifier("un petit resultat n'est pas touche", () => {
    assert.strictEqual(borner({ a: 1 }), '{"a":1}');
  });

  console.log(`${reussis} verifications passees (agent).`);
})();
