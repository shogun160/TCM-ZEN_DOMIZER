// Prueft, was das Frontend als aktive Filter an den Worker meldet - und dass die
// dabei benutzten Schluessel dort ueberhaupt bekannt sind. Laufen die beiden
// Listen auseinander, verschwindet der Filter still aus der Chat-Nachricht.
import fs from 'node:fs';
import { validateFilters } from '../twitch-bot/src/draw.js';
import { extract, HTML } from './harness.mjs';

const WORKER_DRAW = fs.readFileSync(new URL('../twitch-bot/src/draw.js', import.meta.url), 'utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

function filterFuer({ bikeFilterMode = 'no_bike', brand = '', country = '', era = '' } = {}) {
  const fn = new Function('bikeFilterMode', 'getCurrentFilters', 'translateCountry', `
    ${extract('currentTwitchFilters')}
    return currentTwitchFilters();
  `);
  // translateCountry() bildet den Rohwert auf den uebersetzten Namen ab -
  // hier vereinfacht nachgebildet, geprueft wird nur, DASS uebersetzt wird.
  return fn(bikeFilterMode, () => ({ brand, country, era }), (w) => `[${w}]`);
}

// --- Standardeinstellungen melden nichts -----------------------------------
{
  check('Standard meldet keine Filter', filterFuer() === null,
    `war ${JSON.stringify(filterFuer())}`);
  check('"Nur Autos" gilt als Standard', filterFuer({ bikeFilterMode: 'no_bike' }) === null,
    'no_bike ist die Voreinstellung und gehoert nicht in den Chat');
}

// --- Abweichungen werden gemeldet ------------------------------------------
{
  check('Fahrzeugtyp wird gemeldet',
    JSON.stringify(filterFuer({ bikeFilterMode: 'top_tier' })) === JSON.stringify({ vehicleType: 'top_tier' }),
    `war ${JSON.stringify(filterFuer({ bikeFilterMode: 'top_tier' }))}`);

  const alle = filterFuer({ bikeFilterMode: 'bike', brand: 'Ferrari', country: 'italy', era: 'modern' });
  check('Alle vier Filter werden gemeldet',
    JSON.stringify(alle) === JSON.stringify({ vehicleType: 'bike', brand: 'Ferrari', country: '[italy]', era: 'modern' }),
    `war ${JSON.stringify(alle)}`);

  check('Einzelner Filter reicht',
    JSON.stringify(filterFuer({ brand: 'Porsche' })) === JSON.stringify({ brand: 'Porsche' }),
    `war ${JSON.stringify(filterFuer({ brand: 'Porsche' }))}`);
}

// --- Die Schluessel muessen dem Worker bekannt sein -------------------------
{
  // Alle bikeFilterMode-Werte, die im Frontend vorkommen (ausser dem Standard)
  const frontendTypen = [...new Set(
    [...HTML.matchAll(/bikeFilterMode = "([a-z_]+)"/g)].map((m) => m[1])
  )].filter((t) => t !== 'no_bike');

  const workerTypen = new Set(
    [...WORKER_DRAW.matchAll(/\["([a-z_]+)",\s*"([^"]+)"\]/g)].map((m) => m[1])
  );

  const unbekannt = frontendTypen.filter((t) => !workerTypen.has(t));
  check('Jeder Fahrzeugtyp ist dem Worker bekannt', unbekannt.length === 0,
    `im Worker nicht definiert: ${unbekannt.join(', ')} — in FILTER_VEHICLE_TYPES ergaenzen`);
  check('Fahrzeugtypen gefunden', frontendTypen.length > 0, 'keine bikeFilterMode-Werte im Frontend gefunden');

  for (const era of ['classic', 'modern']) {
    check(`Zeitraum "${era}" ist dem Worker bekannt`, workerTypen.has(era),
      'in FILTER_ERAS ergaenzen');
  }
}

// --- Land wird uebersetzt gemeldet, Marke nicht ----------------------------
// Die Laendernamen stehen in translations/i18n.json, nicht im Worker - deshalb
// uebersetzt sie das Frontend, bevor es sie mitschickt. Markennamen bleiben
// unveraendert, sie werden in keiner Sprache uebersetzt.
{
  const nurLand = filterFuer({ country: 'germany' });
  check('Land wird uebersetzt mitgeschickt', nurLand.country === '[germany]',
    `war ${JSON.stringify(nurLand)}`);

  const nurMarke = filterFuer({ brand: 'Porsche' });
  check('Marke bleibt unveraendert', nurMarke.brand === 'Porsche',
    `war ${JSON.stringify(nurMarke)}`);
}

// --- Die Texte im Worker muessen zu i18n.json passen ------------------------
// Fahrzeugtyp und Zeitraum formuliert der Worker selbst (er bekommt nur den
// Schluessel). Damit im Chat nichts anderes steht als in der Oberflaeche,
// werden hier beide Quellen gegeneinander geprueft.
{
  const I18N = JSON.parse(fs.readFileSync(new URL('../translations/i18n.json', import.meta.url), 'utf8'));
  const ZUORDNUNG = [
    ['vehicleType', 'bike', 'bike_yes'],
    ['vehicleType', 'all', 'bike_all'],
    ['vehicleType', 'top_tier', 'top_tier'],
    ['vehicleType', 'rc_cars', 'rc_cars'],
    ['era', 'classic', 'era_classic'],
    ['era', 'modern', 'era_modern'],
  ];

  const abweichungen = [];
  for (const sprache of ['de', 'en']) {
    for (const [feld, schluessel, i18nKey] of ZUORDNUNG) {
      const imWorker = validateFilters({ [feld]: schluessel }, sprache).teile[0];
      const inOberflaeche = I18N[sprache][i18nKey];
      if (imWorker !== inOberflaeche) {
        abweichungen.push(`${sprache}/${schluessel}: Chat "${imWorker}" vs. Oberflaeche "${inOberflaeche}"`);
      }
    }
  }
  check('Filtertexte im Chat entsprechen der Oberflaeche', abweichungen.length === 0, abweichungen.join('; '));
}

// --- Unbekannte Sprache faellt auf Englisch zurueck -------------------------
{
  check('Ohne Sprachangabe erscheinen die Filter englisch',
    validateFilters({ era: 'classic' }).teile[0] === 'Classic',
    `war ${validateFilters({ era: 'classic' }).teile[0]}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} bestanden`);
process.exit(failed.length ? 1 : 0);
