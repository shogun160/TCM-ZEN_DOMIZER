// Prueft, was das Frontend als aktive Filter an den Worker meldet - und dass die
// dabei benutzten Schluessel dort ueberhaupt bekannt sind. Laufen die beiden
// Listen auseinander, verschwindet der Filter still aus der Chat-Nachricht.
import fs from 'node:fs';
import { extract, HTML } from './harness.mjs';

const WORKER_DRAW = fs.readFileSync(new URL('../twitch-bot/src/draw.js', import.meta.url), 'utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

function filterFuer({ bikeFilterMode = 'no_bike', brand = '', country = '', era = '' } = {}) {
  const fn = new Function('bikeFilterMode', 'getCurrentFilters', `
    ${extract('currentTwitchFilters')}
    return currentTwitchFilters();
  `);
  return fn(bikeFilterMode, () => ({ brand, country, era }));
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
    JSON.stringify(alle) === JSON.stringify({ vehicleType: 'bike', brand: 'Ferrari', country: 'italy', era: 'modern' }),
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

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} bestanden`);
process.exit(failed.length ? 1 : 0);
