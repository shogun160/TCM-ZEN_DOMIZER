// Datenqualitaet von cars/vehicles.json.
//
// Anlass: Land und Marke standen dort in zwei Schreibweisen nebeneinander
// ("germany" und "Germany", "Jeep®" und "JEEP®"). Die Dropdowns bauen sich aus
// den Rohwerten - es gab also zwei gleich beschriftete Eintraege, von denen
// jeder nur seinen Teil des Bestands filterte. Wer "Germany" waehlte, bekam
// 2 statt 143 Fahrzeuge.
import fs from 'node:fs';

const VEHICLES = JSON.parse(fs.readFileSync(new URL('../cars/vehicles.json', import.meta.url), 'utf8'));
const I18N = JSON.parse(fs.readFileSync(new URL('../translations/i18n.json', import.meta.url), 'utf8'));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

const werteVon = (feld) => [...new Set(VEHICLES.map((v) => v[feld]).filter(Boolean))];

// --- Keine Schreibweisen-Dubletten ------------------------------------------
for (const feld of ['category', 'brand', 'era', 'country']) {
  const nachKlein = {};
  for (const wert of werteVon(feld)) {
    (nachKlein[wert.toLowerCase()] ||= []).push(wert);
  }
  const dubletten = Object.values(nachKlein).filter((e) => e.length > 1);
  check(`${feld}: keine Schreibweisen-Dubletten`, dubletten.length === 0,
    dubletten.map((e) => e.join(' / ')).join('; ') + ' — die Dropdowns zeigen sonst zwei Eintraege, die je nur einen Teil filtern');
}

// --- Laender und Aeren sind klein geschrieben -------------------------------
// translateCountry()/translateEra() bilden den Wert auf "country_<wert>" bzw.
// "era_<wert>" ab, und diese Schluessel sind durchgaengig klein.
for (const feld of ['country', 'era']) {
  const gross = werteVon(feld).filter((w) => w !== w.toLowerCase());
  check(`${feld}: durchgaengig klein geschrieben`, gross.length === 0,
    `gross geschrieben: ${gross.join(', ')}`);
}

// --- Jeder Wert hat eine Uebersetzung ---------------------------------------
for (const [feld, praefix] of [['country', 'country_'], ['era', 'era_']]) {
  for (const sprache of ['de', 'en']) {
    const fehlend = werteVon(feld).filter((w) => I18N[sprache][praefix + w] === undefined);
    check(`${feld}: alle Werte in "${sprache}" uebersetzt`, fehlend.length === 0,
      `ohne Eintrag: ${fehlend.map((w) => praefix + w).join(', ')}`);
  }
}

// --- Keine Uebersetzung ohne Fahrzeug ---------------------------------------
// Verwaiste Schluessel sind harmlos, aber ein Hinweis auf umbenannte Daten.
for (const [feld, praefix] of [['country', 'country_'], ['era', 'era_']]) {
  const vorhanden = new Set(werteVon(feld).map((w) => praefix + w));
  const verwaist = Object.keys(I18N.de).filter((k) => k.startsWith(praefix) && !vorhanden.has(k));
  check(`${feld}: keine verwaisten Uebersetzungen`, verwaist.length === 0, verwaist.join(', '));
}

// --- Bestand unveraendert ----------------------------------------------------
check('Fahrzeugbestand vollstaendig', VEHICLES.length === 748, `${VEHICLES.length} statt 748 Fahrzeuge`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} bestanden`);
process.exit(failed.length ? 1 : 0);
