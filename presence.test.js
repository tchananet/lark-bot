const assert = require("assert");

const { evaluerLigne, STATUTS } = require("./presence");
const { enMinutes, normaliserHeure, veilleDe } = require("./temps");

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

function ligne(extra) {
  return evaluerLigne({
    nom: "TEST",
    heure_arrivee: null,
    heure_depart: null,
    de_soir_ce_jour: false,
    de_soir_la_veille: false,
    absence: null,
    mode_travail: "PRESENTIEL",
    ...extra,
  });
}

// --- Lecture des heures manuscrites -----------------------------------------

verifier("les notations de la fiche sont toutes comprises", () => {
  assert.strictEqual(enMinutes("08h33"), 513);
  assert.strictEqual(enMinutes("8h18"), 498);
  assert.strictEqual(enMinutes("14:15"), 855);
  assert.strictEqual(enMinutes("07H58"), 478);
  assert.strictEqual(enMinutes("18.02"), 1082);
});

verifier("une heure illisible vaut null, jamais zero", () => {
  assert.strictEqual(enMinutes("xx"), null);
  assert.strictEqual(enMinutes(""), null);
  assert.strictEqual(enMinutes("25h00"), null);
  assert.strictEqual(enMinutes("08h75"), null);
  assert.strictEqual(normaliserHeure("n'importe quoi"), null);
});

verifier("la veille traverse un changement de mois", () => {
  assert.strictEqual(veilleDe("2026-09-01"), "2026-08-31");
  assert.strictEqual(veilleDe("2026-01-01"), "2025-12-31");
});

// --- Horaires attendus ------------------------------------------------------

verifier("lendemain de permanence : arrivee attendue a 10h30", () => {
  const r = ligne({ heure_arrivee: "10h43", heure_depart: "18h08", de_soir_la_veille: true });
  assert.strictEqual(r.arrivee_prevue, "10h30");
  assert.strictEqual(r.statut, STATUTS.OK, "13 min de retard tient dans la tolerance");
});

verifier("sans permanence la veille, la meme arrivee est une anomalie", () => {
  const r = ligne({ heure_arrivee: "10h43", heure_depart: "18h08" });
  assert.strictEqual(r.statut, STATUTS.ANOMALIE);
  assert.strictEqual(r.retard_minutes, 133);
  assert.ok(r.question, "une anomalie doit poser une question");
});

verifier("jour de permanence : depart attendu a 20h00", () => {
  const r = ligne({ heure_arrivee: "08h18", heure_depart: "20h05", de_soir_ce_jour: true });
  assert.strictEqual(r.depart_prevu, "20h00");
  assert.strictEqual(r.statut, STATUTS.OK);
});

// --- Departs : jamais juges -------------------------------------------------

verifier("un depart tardif n'est jamais signale", () => {
  assert.strictEqual(ligne({ heure_arrivee: "08h00", heure_depart: "22h30" }).statut, STATUTS.OK);
});

verifier("un depart anticipe n'est pas signale non plus", () => {
  const r = ligne({ heure_arrivee: "08h07", heure_depart: "16h09" });
  assert.strictEqual(r.statut, STATUTS.OK);
  assert.strictEqual(r.question, null);
});

// --- Seuils -----------------------------------------------------------------

verifier("la tolerance de 15 min est inclusive", () => {
  assert.strictEqual(ligne({ heure_arrivee: "08h45", heure_depart: "18h00" }).statut, STATUTS.OK);
  assert.strictEqual(ligne({ heure_arrivee: "08h46", heure_depart: "18h00" }).statut, STATUTS.RETARD);
});

verifier("le seuil d'anomalie de 60 min est inclusif", () => {
  assert.strictEqual(ligne({ heure_arrivee: "09h30", heure_depart: "18h00" }).statut, STATUTS.RETARD);
  assert.strictEqual(ligne({ heure_arrivee: "09h31", heure_depart: "18h00" }).statut, STATUTS.ANOMALIE);
});

verifier("un retard simple ne pose pas de question", () => {
  const r = ligne({ heure_arrivee: "09h00", heure_depart: "18h00" });
  assert.strictEqual(r.statut, STATUTS.RETARD);
  assert.strictEqual(r.question, null, "seules les anomalies interpellent la DRH");
});

// --- Lignes vides : les quatre raisons possibles -----------------------------

verifier("une mission prime sur le mode de travail", () => {
  const r = ligne({ absence: { type: "MISSION", motif: "salon auto Douala" }, mode_travail: "DISTANCE" });
  assert.strictEqual(r.statut, STATUTS.MISSION);
  assert.strictEqual(r.detail, "salon auto Douala");
});

verifier("un conge enregistre donne une absence autorisee", () => {
  const r = ligne({ absence: { type: "CONGE", motif: "conge annuel" } });
  assert.strictEqual(r.statut, STATUTS.AUTORISEE);
  assert.strictEqual(r.question, null, "une absence justifiee ne se redemande pas");
});

verifier("un employe a distance n'est jamais porte absent", () => {
  const r = ligne({ mode_travail: "DISTANCE" });
  assert.strictEqual(r.statut, STATUTS.DISTANCE);
  assert.strictEqual(r.question, null);
});

verifier("sans explication, la ligne vide devient ABSENT et pose une question", () => {
  const r = ligne({});
  assert.strictEqual(r.statut, STATUTS.ABSENT);
  assert.ok(r.question);
});

// --- Signature partielle ----------------------------------------------------

verifier("une arrivee sans depart reste une presence, avec une note", () => {
  const r = ligne({ heure_arrivee: "08h35" });
  assert.strictEqual(r.statut, STATUTS.OK);
  assert.ok(/depart non signee/.test(r.note));
  assert.strictEqual(r.question, null, "un oubli de signature n'interpelle pas la DRH");
});

verifier("un depart sans arrivee reste une presence, avec une note", () => {
  const r = ligne({ heure_depart: "18h05" });
  assert.strictEqual(r.statut, STATUTS.OK);
  assert.ok(/arrivee non signee/.test(r.note));
});

verifier("une heure illisible ne doit pas se lire comme minuit", () => {
  const r = ligne({ heure_arrivee: "illisible", heure_depart: "18h00" });
  assert.notStrictEqual(r.statut, STATUTS.ANOMALIE, "00h00 ferait un retard de 8h30 imaginaire");
  assert.ok(/arrivee non signee/.test(r.note));
});

console.log(`${reussis} verifications passees.`);
