const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "presence-odoo-")),
  "test.db"
);

process.env.ODOO_URL = "http://odoo.test";
process.env.ODOO_DB = "test";
process.env.ODOO_USER = "test";
process.env.ODOO_PASSWORD = "test";

const {
  db,
} = require("./database");

const {
  enregistrerPointage,
  signalerPourRevue,
} = require("./hr");

// odoo.js est mocke UNE FOIS ici ; presence-odoo.js et extraction.js ne le
// requierent que tardivement (dans synchroniserJournee / enregistrerLecture),
// donc ils recoivent cette meme instance -- meme mecanique que pour
// odoo-ecriture.test.js.
const odoo = require("./odoo");

let employeOdooParNom = new Map();
const appelsCreer = [];
const appelsEcrire = [];
let lignesExistantesCoteOdoo = new Map(); // "ficheId:employeId" -> ligneId
let ficheExistanteId = null;

odoo.resoudreEmployeOdoo = async (nom) => employeOdooParNom.get(nom) || null;

odoo.lire = async (model, domaine) => {
  if (model === "x_manual.attendance") {
    return ficheExistanteId ? [{ id: ficheExistanteId }] : [];
  }

  if (model === "x_manual.attendance.line") {
    const ficheId = domaine.find((d) => d[0] === "x_attendance_sheet_id")[2];
    const employeId = domaine.find((d) => d[0] === "x_employee_id")[2];
    const cle = `${ficheId}:${employeId}`;

    return lignesExistantesCoteOdoo.has(cle)
      ? [{ id: lignesExistantesCoteOdoo.get(cle) }]
      : [];
  }

  return [];
};

odoo.creer = async (model, valeurs) => {
  appelsCreer.push({ model, valeurs });

  return 5000 + appelsCreer.length;
};

odoo.ecrire = async (model, id, valeurs) => {
  appelsEcrire.push({ model, id, valeurs });

  return true;
};

const { journeeEstPropre, versDatetimeOdoo, estEnGarde, synchroniserJournee } = require("./presence-odoo");

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
  const info = db.prepare(
    `INSERT INTO employees (nom_complet, cle_nom, suivi_presence, mode_travail)
     VALUES (?, ?, 1, 'PRESENTIEL')`
  ).run(nom, nom);

  return info.lastInsertRowid;
}

// ---------------------------------------------------------------------------
// La presence ne part vers Odoo QUE pour une journee devenue propre -- plus
// aucune cellule en litige entre les deux lectures. On le verifie ici de
// bout en bout : rien n'est ecrit tant qu'une cellule traine, tout part des
// qu'elle est resolue, et un employe non retrouve cote Odoo n'empeche pas la
// synchronisation des autres.
// ---------------------------------------------------------------------------

(async () => {
  await verifier("journeeEstPropre est vraie sans aucune cellule en litige", () => {
    assert.strictEqual(journeeEstPropre("2026-10-23"), true);
  });

  await verifier("journeeEstPropre est fausse des qu'une cellule traine", () => {
    signalerPourRevue({
      date: "2026-10-24",
      nom_brut: "QUELQU'UN",
      motif: "ligne vue par une seule des deux lectures",
      passe_1: "absente",
      passe_2: "{}",
    });

    assert.strictEqual(journeeEstPropre("2026-10-24"), false);
  });

  await verifier("versDatetimeOdoo decale l'heure locale (UTC+1) vers l'UTC", () => {
    assert.strictEqual(versDatetimeOdoo("2026-10-23", "08h30"), "2026-10-23 07:30:00");
    // Un passage a minuit change la date en UTC, pas seulement l'heure.
    assert.strictEqual(versDatetimeOdoo("2026-10-23", "00h15"), "2026-10-22 23:15:00");
  });

  await verifier("versDatetimeOdoo rend null sur une heure illisible", () => {
    assert.strictEqual(versDatetimeOdoo("2026-10-23", null), null);
    assert.strictEqual(versDatetimeOdoo("2026-10-23", ""), null);
  });

  // La garde se lit sur l'heure de depart reellement pointee, jamais sur le
  // planning de permanence : les echanges de garde entre collegues sont
  // frequents et rendent ce planning rapidement faux. Quelqu'un qui part a
  // l'heure de la releve du soir est en garde ce jour-la, qu'il ait ete
  // planifie ou non -- et inversement, quelqu'un planifie mais qui est
  // finalement parti a l'heure normale n'est pas compte en garde.
  await verifier("estEnGarde se lit sur l'heure de depart, pas sur un planning", () => {
    assert.strictEqual(estEnGarde("20h00"), true, "l'heure pile de la releve doit compter");
    assert.strictEqual(estEnGarde("20h15"), true);
    assert.strictEqual(estEnGarde("19h59"), false);
    assert.strictEqual(estEnGarde("18h00"), false);
    assert.strictEqual(estEnGarde(null), false);
  });

  await verifier(
    "une journee avec une cellule en litige n'ecrit jamais rien dans Odoo",
    async () => {
      appelsCreer.length = 0;
      appelsEcrire.length = 0;

      const resultat = await synchroniserJournee("2026-10-24");

      assert.strictEqual(resultat.synchronise, false);
      assert.strictEqual(resultat.motif, "cellules_en_revue");
      assert.strictEqual(appelsCreer.length, 0);
    }
  );

  await verifier(
    "une journee propre cree la fiche et une ligne par employe",
    async () => {
      const idSoh = ajouterEmploye("SOH ROMUALD");
      const idMessiha = ajouterEmploye("MESSIHA ANGE");

      enregistrerPointage({
        employee_id: idSoh,
        date: "2026-10-23",
        heure_arrivee: "07h30",
        heure_depart: "17h28",
      });

      enregistrerPointage({
        employee_id: idMessiha,
        date: "2026-10-23",
        heure_arrivee: "08h01",
        heure_depart: "18h10",
      });

      employeOdooParNom = new Map([
        ["SOH ROMUALD", { id: 51, name: "SOH ROMUALD" }],
        ["MESSIHA ANGE", { id: 52, name: "MESSIHA ANGE" }],
      ]);

      ficheExistanteId = null;
      lignesExistantesCoteOdoo = new Map();
      appelsCreer.length = 0;
      appelsEcrire.length = 0;

      const resultat = await synchroniserJournee("2026-10-23");

      assert.strictEqual(resultat.synchronise, true, JSON.stringify(resultat));
      assert.strictEqual(resultat.ecrites, 2);
      assert.strictEqual(resultat.echecs.length, 0);

      const fiche = appelsCreer.find((a) => a.model === "x_manual.attendance");
      assert.ok(fiche, "la fiche du jour n'a pas ete creee");
      assert.strictEqual(fiche.valeurs.x_date_2, "2026-10-23");

      const lignes = appelsCreer.filter((a) => a.model === "x_manual.attendance.line");
      assert.strictEqual(lignes.length, 2);

      const ligneSoh = lignes.find((l) => l.valeurs.x_employee_id === 51);
      assert.ok(ligneSoh, "la ligne de SOH ROMUALD est absente");
      assert.strictEqual(ligneSoh.valeurs.x_check_in, "2026-10-23 06:30:00");
      assert.strictEqual(ligneSoh.valeurs.x_check_out, "2026-10-23 16:28:00");
    }
  );

  await verifier(
    "une garde non planifiee (echange de dernier moment) est quand meme detectee",
    async () => {
      const idEchange = ajouterEmploye("PERSONNE EN ECHANGE DE GARDE");

      // Pas d'enregistrerPosteDeSoir ici : cette personne n'etait PAS prevue
      // au planning de permanence, elle a simplement pris la releve d'un
      // collegue au dernier moment -- c'est exactement le cas que le
      // planning ne peut pas refleter.
      enregistrerPointage({
        employee_id: idEchange,
        date: "2026-10-27",
        heure_arrivee: "08h00",
        heure_depart: "20h30",
      });

      employeOdooParNom = new Map([
        ["PERSONNE EN ECHANGE DE GARDE", { id: 77, name: "PERSONNE EN ECHANGE DE GARDE" }],
      ]);
      ficheExistanteId = null;
      lignesExistantesCoteOdoo = new Map();
      appelsCreer.length = 0;

      await synchroniserJournee("2026-10-27");

      const ligne = appelsCreer.find((a) => a.model === "x_manual.attendance.line");

      assert.ok(ligne, "la ligne n'a pas ete creee");
      assert.strictEqual(
        ligne.valeurs.x_studio_de_garde_aujourdhui,
        true,
        "un depart a 20h30 doit compter comme garde, meme sans planning prealable"
      );
    }
  );

  await verifier(
    "une ligne deja presente cote Odoo est mise a jour, pas recreee",
    async () => {
      const idExistant = ajouterEmploye("ALIMATOU SADIA");

      enregistrerPointage({
        employee_id: idExistant,
        date: "2026-10-25",
        heure_arrivee: "07h35",
        heure_depart: "18h51",
      });

      employeOdooParNom = new Map([["ALIMATOU SADIA", { id: 59, name: "ALIMATOU SADIA" }]]);
      ficheExistanteId = 900;
      lignesExistantesCoteOdoo = new Map([["900:59", 4242]]);
      appelsCreer.length = 0;
      appelsEcrire.length = 0;

      const resultat = await synchroniserJournee("2026-10-25");

      assert.strictEqual(resultat.synchronise, true);
      assert.strictEqual(resultat.ecrites, 1);

      const creationsDeLigne = appelsCreer.filter((a) => a.model === "x_manual.attendance.line");
      assert.strictEqual(creationsDeLigne.length, 0, "une ligne existante a ete recreee au lieu d'etre mise a jour");

      assert.strictEqual(appelsEcrire.length, 1);
      assert.strictEqual(appelsEcrire[0].id, 4242);
    }
  );

  await verifier(
    "un employe non retrouve cote Odoo n'empeche pas la synchronisation des autres",
    async () => {
      const idConnu = ajouterEmploye("EMPLOYE CONNU");
      const idInconnu = ajouterEmploye("EMPLOYE SANS CORRESPONDANCE ODOO");

      enregistrerPointage({
        employee_id: idConnu,
        date: "2026-10-26",
        heure_arrivee: "08h00",
        heure_depart: "18h00",
      });

      enregistrerPointage({
        employee_id: idInconnu,
        date: "2026-10-26",
        heure_arrivee: "08h05",
        heure_depart: "18h05",
      });

      employeOdooParNom = new Map([
        ["EMPLOYE CONNU", { id: 70, name: "EMPLOYE CONNU" }],
        // EMPLOYE SANS CORRESPONDANCE ODOO volontairement absent.
      ]);
      ficheExistanteId = null;
      lignesExistantesCoteOdoo = new Map();
      appelsCreer.length = 0;

      const resultat = await synchroniserJournee("2026-10-26");

      assert.strictEqual(resultat.synchronise, true);
      assert.strictEqual(resultat.ecrites, 1, "l'employe connu doit etre ecrit malgre l'echec de l'autre");
      assert.strictEqual(resultat.echecs.length, 1);
      assert.ok(/aucun employe Odoo correspondant/.test(resultat.echecs[0]));
    }
  );

  console.log(`${reussis} verifications passees (presence-odoo).`);
})();
