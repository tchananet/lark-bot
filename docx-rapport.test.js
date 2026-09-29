const assert = require("assert");

const { rendre } = require("./docx-rapport");
const { valider } = require("./rapport");

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
// Le 30 septembre, le rapport du 28 a echoue avec "service.lignes is not
// iterable" -- une TypeError brute remontee telle quelle a la DRH, sans le
// moindre document produit, pour tout le rapport, pas seulement le service
// touche.
//
// Le champ 'lignes' est requis par le schema JSON du modele, mais le mode
// strict n'est pas toujours honore (deja documente ailleurs dans ce
// fichier) : un service peut ressortir sans lui. Le rendu .docx doit
// tolerer cela -- produire le document quand meme, la section concernee
// simplement vide -- plutot que de faire echouer TOUT le rapport pour UNE
// section malformee.
// ---------------------------------------------------------------------------

function documentMinimal(extra = {}) {
  return {
    type: "QUOTIDIEN",
    numero: "N° 999 / AM / RJ",
    ville: "Douala",
    date_redaction: "30 septembre 2026",
    titre_date: "LUNDI 28 SEPTEMBRE 2026",
    intro: "Le service a transmis son compte rendu.",
    synthese: [],
    ponctualite: "Aucun retard ni absence a signaler.",
    services: [{ nom: "Direction Commerciale", lignes: undefined }],
    points_attention: [],
    actions: [],
    conclusion: ["Journee sans incident notable."],
    signature: "La Direction des Ressources Humaines",
    ...extra,
  };
}

verifier(
  "un service sans son tableau de lignes ne fait plus planter tout le rapport",
  () => {
    const buffer = rendre(documentMinimal());

    assert.ok(Buffer.isBuffer(buffer), "aucun document produit");
    assert.ok(buffer.length > 0, "document vide");
  }
);

verifier("une synthese absente (pas seulement vide) ne plante pas non plus", () => {
  const d = documentMinimal();

  delete d.synthese;

  const buffer = rendre(d);

  assert.ok(Buffer.isBuffer(buffer));
});

verifier("des points d'attention, actions ou conclusion absents ne plantent pas", () => {
  const d = documentMinimal();

  delete d.points_attention;
  delete d.actions;
  delete d.conclusion;

  const buffer = rendre(d);

  assert.ok(Buffer.isBuffer(buffer));
});

verifier("des services entierement absents ne plantent pas", () => {
  const d = documentMinimal();

  delete d.services;

  const buffer = rendre(d);

  assert.ok(Buffer.isBuffer(buffer));
});

verifier("un rapport hebdomadaire sans axes ni indicateurs ne plante pas", () => {
  const d = {
    type: "HEBDOMADAIRE",
    numero: "N° 998 / AM / RH",
    ville: "Douala",
    date_redaction: "30 septembre 2026",
    titre_periode: "SEMAINE DU 21 AU 27 SEPTEMBRE 2026",
    intro: "Bilan de la semaine.",
    lecture: null,
    priorites: [],
    conclusion: ["Rien a signaler."],
    signature: "La Direction des Ressources Humaines",
  };

  const buffer = rendre(d);

  assert.ok(Buffer.isBuffer(buffer));
});

// ---------------------------------------------------------------------------
// Le rendu tolere maintenant l'absence de 'lignes' -- mais un service qui
// perd son contenu sans que personne ne le sache reste un defaut. valider()
// doit le signaler, pour declencher la reprise deja en place et le dire
// dans les reserves plutot que de laisser une section muette passer
// inapercue.
// ---------------------------------------------------------------------------

verifier("valider() signale un service sans tableau de lignes", () => {
  const erreurs = valider(
    {
      intro: "x",
      conclusion: ["x"],
      points_attention: [],
      services: [{ nom: "Direction Commerciale", lignes: undefined }],
      ponctualite: "Aucun retard ni absence a signaler.",
    },
    "QUOTIDIEN"
  );

  assert.ok(
    erreurs.some((e) => /sans lignes/.test(e)),
    `l'absence de lignes n'est pas signalee : ${JSON.stringify(erreurs)}`
  );
});

verifier("valider() ne signale rien quand les lignes sont bien un tableau", () => {
  const erreurs = valider(
    {
      intro: "x",
      conclusion: ["x"],
      points_attention: [],
      services: [
        {
          nom: "Direction Commerciale",
          lignes: [{ libelle: "CLIENT X", description: "Devis envoye", suite: "" }],
        },
      ],
      ponctualite: "Aucun retard ni absence a signaler.",
    },
    "QUOTIDIEN"
  );

  assert.ok(
    !erreurs.some((e) => /sans lignes/.test(e)),
    `un tableau de lignes valide a ete signale a tort : ${JSON.stringify(erreurs)}`
  );
});

console.log(`${reussis} verifications passees (docx-rapport).`);
