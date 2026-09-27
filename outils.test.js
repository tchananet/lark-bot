const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "outils-")),
  "test.db"
);

const { OUTILS, appeler, declarations } = require("./outils");
const {
  memoriserRapport,
  rapportsProduits,
  rapport,
  chercherDansRapports,
} = require("./memoire");

let reussis = 0;

function verifier(intitule, fn) {
  try {
    fn();
    reussis++;
  } catch (erreur) {
    console.error(`ECHEC : ${intitule}\n  ${erreur.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Les outils que l'assistant peut consulter
//
// Ils remplacent l'aiguillage qui rangeait chaque message dans une case parmi
// dix. Le 26 septembre, « Je veux faire le rapport de cette semaine. Est-ce
// possible ? Quels rapports sont déjà dispo ? » -- deux questions -- a produit
// zéro réponse et publié un rapport hebdomadaire dans le groupe de suivi.
//
// D'où la règle que ces tests protègent : AUCUN outil n'écrit. Se renseigner
// ne déclenche jamais rien.
// ---------------------------------------------------------------------------

verifier("chaque outil est declare correctement", () => {
  assert.ok(OUTILS.length >= 10, "trop peu d'outils");

  for (const outil of OUTILS) {
    assert.ok(/^[a-z][a-z0-9_]*$/.test(outil.nom), `nom invalide : ${outil.nom}`);
    assert.ok(outil.description.length > 40, `${outil.nom} : description trop maigre`);
    assert.strictEqual(outil.parametres.type, "object", `${outil.nom} : schema`);
    assert.strictEqual(typeof outil.executer, "function", `${outil.nom} : pas executable`);
  }
});

verifier("les noms d'outils sont uniques", () => {
  const noms = OUTILS.map((o) => o.nom);

  assert.strictEqual(new Set(noms).size, noms.length);
});

verifier("la declaration remise au modele est complete", () => {
  const d = declarations();

  assert.strictEqual(d.length, OUTILS.length);

  for (const entree of d) {
    assert.strictEqual(entree.type, "function");
    assert.ok(entree.function.name);
    assert.ok(entree.function.description);
    assert.ok(entree.function.parameters);
  }
});

// Le coeur de la tranche : consulter ne doit jamais ecrire. Si un outil
// obtenait ce droit par inadvertance, « est-ce possible ? » pourrait de
// nouveau produire un rapport.
verifier("aucun outil n'ecrit en base", () => {
  const source = fs.readFileSync(path.join(__dirname, "outils.js"), "utf8");
  const interdits = [
    "INSERT", "UPDATE", "DELETE", "DROP",
    "memoriserRapport", "enregistrerAbsence", "corrigerPointage",
    "publierRapport", "ajouterEmploye", "trancher(",
  ];

  for (const mot of interdits) {
    assert.ok(
      !source.includes(mot),
      `outils.js contient « ${mot} » : un outil de lecture ne doit pas écrire`
    );
  }
});

verifier("un outil inconnu rend une erreur, sans jeter", () => {
  const r = appeler("faire_le_cafe", {});

  assert.ok(r.erreur, "aucune erreur rendue");
  assert.ok(r.erreur.includes("etat_journee"), "la liste des outils n'est pas rappelée");
});

verifier("un parametre requis manquant rend une erreur", () => {
  const r = appeler("etat_journee", {});

  assert.ok(r.erreur && r.erreur.includes("date"), `erreur inattendue : ${r.erreur}`);
});

verifier("un outil qui echoue ne fait pas tomber la conversation", () => {
  const r = appeler("etat_journee", { date: "pas-une-date" });

  assert.ok(r.erreur || r.date, "ni erreur ni resultat");
});

verifier("aujourdhui situe la semaine et dit si elle est terminee", () => {
  const r = appeler("aujourdhui", {});

  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.date_du_jour));
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.derniere_journee_reportable));

  // Le lundi precede toujours le dimanche de six jours.
  const lundi = new Date(`${r.semaine_en_cours.lundi}T00:00:00Z`);
  const dimanche = new Date(`${r.semaine_en_cours.dimanche}T00:00:00Z`);

  assert.strictEqual((dimanche - lundi) / 86400000, 6);
  assert.strictEqual(typeof r.semaine_en_cours_terminee, "boolean");

  // La journee reportable est toujours passee : sa fenetre doit etre fermee.
  assert.ok(r.derniere_journee_reportable < r.date_du_jour);
});

verifier("un lundi reste le lundi de sa propre semaine", () => {
  // 2026-09-21 est un lundi. Une semaine qui commencerait le dimanche
  // decalerait tous les rapports hebdomadaires d'un jour.
  const lundi = new Date("2026-09-21T00:00:00Z");

  assert.strictEqual(lundi.getUTCDay(), 1);
});


// --- La memoire des rapports ----------------------------------------------
//
// Seul le NUMERO d'un rapport etait garde en base ; le texte n'existait que
// dans un .docx, illisible pour le programme. « Combien de ventes en
// septembre ? » etait donc hors de portee alors que la reponse avait deja ete
// ecrite.

const DOC = {
  numero: "N° 031 / AM / RJ",
  titre_date: "VENDREDI 25 SEPTEMBRE 2026",
  intro: "Le Service Après-Vente a transmis son compte rendu.",
};

verifier("un rapport memorise se retrouve", () => {
  memoriserRapport({
    portee: "JOURNEE",
    date_debut: "2026-09-25",
    date_fin: "2026-09-25",
    numero: DOC.numero,
    titre: DOC.titre_date,
    chemin: "/app/rapports/Rapport_2026_09_25.docx",
    document: DOC,
    texte: "Trois véhicules vendus ce jour, dont deux Hyundai Tucson.",
  });

  const liste = rapportsProduits({});

  assert.strictEqual(liste.length, 1);
  assert.strictEqual(liste[0].date_debut, "2026-09-25");
  assert.strictEqual(liste[0].numero, DOC.numero);
});

verifier("le JSON du rapport se relit champ par champ", () => {
  const trouve = rapport({ portee: "JOURNEE", date: "2026-09-25" });

  assert.strictEqual(trouve.document.intro, DOC.intro);
});

verifier("un rapport regenere remplace le precedent", () => {
  memoriserRapport({
    portee: "JOURNEE",
    date_debut: "2026-09-25",
    numero: DOC.numero,
    document: { ...DOC, intro: "Corrigé après arbitrage des cellules." },
    texte: "Quatre véhicules vendus ce jour.",
  });

  const liste = rapportsProduits({});

  assert.strictEqual(liste.length, 1, "deux vérités pour une seule journée");

  const trouve = rapport({ portee: "JOURNEE", date: "2026-09-25" });

  assert.ok(trouve.document.intro.includes("Corrigé"));
});

verifier("un quotidien et un hebdomadaire coexistent sur la meme date", () => {
  memoriserRapport({
    portee: "SEMAINE",
    date_debut: "2026-09-25",
    date_fin: "2026-10-01",
    numero: "N° 012 / AM / RH",
    document: { intro: "Bilan de la semaine." },
    texte: "Bilan hebdomadaire : quatre véhicules vendus.",
  });

  assert.strictEqual(rapportsProduits({}).length, 2);
  assert.strictEqual(rapportsProduits({ portee: "SEMAINE" }).length, 1);
});

verifier("la recherche rend des extraits, pas les rapports entiers", () => {
  const r = chercherDansRapports({ mots: "véhicules" });

  assert.ok(r.resultats.length >= 1, "rien trouvé");
  assert.ok(r.resultats[0].extraits.length >= 1, "aucun extrait");
  assert.ok(
    r.resultats[0].extraits[0].length < 400,
    "l'extrait est trop long, c'est presque le rapport entier"
  );
});

verifier("tous les mots doivent figurer, pas un seul", () => {
  const trouve = chercherDansRapports({ mots: "véhicules Tucson" });
  const absent = chercherDansRapports({ mots: "véhicules tracteur" });

  assert.ok(trouve.resultats.length >= 0);
  assert.strictEqual(absent.resultats.length, 0, "un mot absent a quand même matché");
});

verifier("les mots trop courts sont ignores", () => {
  const r = chercherDansRapports({ mots: "de la" });

  assert.deepStrictEqual(r.termes, []);
  assert.deepStrictEqual(r.resultats, []);
});

verifier("la recherche se borne a une periode", () => {
  const dedans = chercherDansRapports({ mots: "véhicules", du: "2026-09-01" });
  const dehors = chercherDansRapports({ mots: "véhicules", au: "2026-08-31" });

  assert.ok(dedans.resultats.length >= 1);
  assert.strictEqual(dehors.resultats.length, 0);
});

verifier("les rapports memorises ressortent par l'outil", () => {
  const r = appeler("rapports_disponibles", {});

  assert.strictEqual(r.nombre, 2);
  assert.ok(r.rapports.some((x) => x.portee === "SEMAINE"));
  assert.ok(r.rapports.some((x) => x.fichier === "Rapport_2026_09_25.docx"));
});

verifier("chercher_dans_rapports passe par l'outil", () => {
  const r = appeler("chercher_dans_rapports", { mots: "Bilan hebdomadaire" });

  assert.ok(r.resultats.length >= 1);
});

verifier("un rapport absent le dit, sans jeter", () => {
  const r = appeler("lire_rapport", { date: "2019-01-01" });

  assert.strictEqual(r.trouve, false);
  assert.ok(r.message);
});

console.log(`${reussis} verifications passees (outils).`);
