const assert = require("assert");

const { evaluerLigne, STATUTS } = require("./presence");
const { enMinutes, normaliserHeure, veilleDe } = require("./temps");
const { valider } = require("./rapport");
const { sansCloture } = require("./ia");

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
  const r = ligne({ heure_arrivee: "10h15", heure_depart: "18h08", de_soir_la_veille: true });
  assert.strictEqual(r.arrivee_prevue, "10h30");
  assert.strictEqual(r.statut, STATUTS.OK, "avant 10h30 reste conforme");
});

verifier("apres une permanence, 10h30 est une limite FERME", () => {
  const pile = ligne({ heure_arrivee: "10h30", heure_depart: "18h00", de_soir_la_veille: true });
  assert.strictEqual(pile.statut, STATUTS.OK, "10h30 pile reste conforme");

  const apres = ligne({ heure_arrivee: "10h31", heure_depart: "18h00", de_soir_la_veille: true });
  assert.strictEqual(apres.statut, STATUTS.RETARD, "une minute apres 10h30 est un retard");
  assert.strictEqual(apres.retard_minutes, 1);
});

verifier("la tolerance de 15 min ne s applique PAS apres une permanence", () => {
  const r = ligne({ heure_arrivee: "10h43", heure_depart: "18h08", de_soir_la_veille: true });

  assert.strictEqual(r.statut, STATUTS.RETARD, "13 min apres 10h30 est un retard");
  assert.strictEqual(r.retard_minutes, 13);
});

verifier("la tolerance vaut toujours pour la prise de service normale", () => {
  assert.strictEqual(ligne({ heure_arrivee: "08h45", heure_depart: "18h00" }).statut, STATUTS.OK);
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

// --- Retard couvert par une justification -----------------------------------

verifier("une permission couvre aussi une arrivee tardive", () => {
  const r = ligne({
    heure_arrivee: "15h40",
    heure_depart: "18h16",
    absence: { type: "PERMISSION", motif: "rendez-vous medical le matin" },
  });

  assert.strictEqual(r.statut, STATUTS.ANOMALIE, "le fait reste consigne");
  assert.strictEqual(r.justifie, true);
  assert.strictEqual(r.motif, "rendez-vous medical le matin");
  assert.strictEqual(r.question, null, "la DRH a deja repondu, on ne redemande pas");
  assert.ok(/rendez-vous medical/.test(r.detail));
});

verifier("sans justification, la meme arrivee interpelle la DRH", () => {
  const r = ligne({ heure_arrivee: "15h40", heure_depart: "18h16" });

  assert.strictEqual(r.justifie, false);
  assert.ok(r.question);
});

verifier("un retard simple justifie porte son motif", () => {
  const r = ligne({
    heure_arrivee: "09h00",
    heure_depart: "18h00",
    absence: { type: "PERMISSION", motif: "banque" },
  });

  assert.strictEqual(r.statut, STATUTS.RETARD);
  assert.strictEqual(r.justifie, true);
  assert.ok(/banque/.test(r.detail));
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

// --- Prudence pres du seuil -------------------------------------------------

verifier("un retard serre invite a verifier la fiche papier", () => {
  const r = ligne({ heure_arrivee: "08h50", heure_depart: "18h00" });

  assert.strictEqual(r.statut, STATUTS.RETARD);
  assert.strictEqual(r.retard_minutes, 20);
  assert.ok(/Verifier la fiche papier/.test(r.note || ""));
});

verifier("un retard franc n'a pas besoin de cette reserve", () => {
  const r = ligne({ heure_arrivee: "09h20", heure_depart: "18h00" });

  assert.strictEqual(r.statut, STATUTS.RETARD);
  assert.strictEqual(r.note, null);
});

verifier("un retard serre mais justifie ne demande pas de verification", () => {
  const r = ligne({
    heure_arrivee: "08h50",
    heure_depart: "18h00",
    absence: { type: "PERMISSION", motif: "banque" },
  });

  assert.strictEqual(r.note, null, "le motif est connu, la lecture importe peu");
});

verifier("une case illisible n'est pas presentee comme non signee", () => {
  const r = ligne({ heure_arrivee: "08h07", champs_incertains: ["heure_depart"] });

  assert.ok(/illisible/.test(r.note));
  assert.ok(!/non signee/.test(r.note), "la personne a signe, c'est la lecture qui echoue");
});

// --- Le rapport ne peut pas passer un nom sous silence -----------------------
//
// Le modele resume volontiers une longue liste de noms ("dix-huit absences
// ont ete constatees"). Pour un rapport RH, une personne qui disparait du
// texte est une personne dont l'absence n'est jamais traitee : le controle
// est donc fait par le programme, pas confie a la consigne.

const DOCUMENT_MINIMAL = {
  intro: "x",
  conclusion: ["y"],
  points_attention: [],
  synthese: [],
  services: [],
  actions: [],
  donnees_manquantes: [],
};

const FAITS = {
  retards: [
    { nom: "Mme ADANA ASTHORIE", justifie: false },
    { nom: "NGA ISABELLE", justifie: true },
  ],
  absences_non_justifiees: [
    { nom: "Mme ETOUNA MARIE SHARONE" },
    { nom: "SOH ROMUALD" },
  ],
};

function omis(ponctualite) {
  const erreur = valider({ ...DOCUMENT_MINIMAL, ponctualite }, "QUOTIDIEN", FAITS)
    .find((e) => e.startsWith("ponctualite : nom"));

  return erreur ? erreur.split(" - ")[1].split(", ").length : 0;
}

verifier("un rapport citant tout le monde passe", () => {
  assert.strictEqual(
    omis(
      "Retard de Mme ADANA ASTHORIE. Absences : Mme ETOUNA MARIE SHARONE " +
      "et SOH ROMUALD."
    ),
    0
  );
});

verifier("un absent oublie est signale", () => {
  assert.strictEqual(
    omis("Retard de Mme ADANA ASTHORIE. Absence : Mme ETOUNA MARIE SHARONE."),
    1
  );
});

verifier("un nom ecrit dans un autre ordre reste reconnu", () => {
  assert.strictEqual(
    omis(
      "Retard de Mme ASTHORIE ADANA. Absences : Mme MARIE SHARONE ETOUNA, " +
      "SOH ROMUALD."
    ),
    0,
    "la fiche et le registre n'ordonnent pas les noms pareil"
  );
});

verifier("ni la casse ni les accents ne font echouer la verification", () => {
  assert.strictEqual(
    omis(
      "retard de mme adana asthorie ; absences : mme etouna marie sharone, " +
      "soh romuald"
    ),
    0
  );
});

verifier("un resume sans aucun nom est refuse", () => {
  assert.strictEqual(
    omis("Un retard et deux absences ont ete constates."),
    3,
    "les trois personnes concernees doivent etre nommees"
  );
});

verifier("un retard justifie n'a pas a etre cite", () => {
  assert.strictEqual(
    omis("Mme ADANA ASTHORIE, Mme ETOUNA MARIE SHARONE, SOH ROMUALD."),
    0,
    "NGA ISABELLE est justifiee : son absence du texte est normale"
  );
});


// --- Reponse du modele encadree de markdown ---------------------------------

verifier("un JSON encadre de markdown reste lisible", () => {
  assert.strictEqual(sansCloture('\u0060\u0060\u0060json\n{"a":1}\n\u0060\u0060\u0060'), '{"a":1}');
  assert.strictEqual(sansCloture('\u0060\u0060\u0060\r\n{"a":1}\r\n\u0060\u0060\u0060'), '{"a":1}');
  assert.strictEqual(sansCloture('  {"a":1}  '), '{"a":1}');
});

console.log(`${reussis} verifications passees.`);
