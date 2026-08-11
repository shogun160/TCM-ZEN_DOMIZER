// Prüft die drei Ziehlogik-Eigenschaften gegen den echten Code in zendomizer.html.
// Deterministisch: Math.random ist geseedet.
import { createDrawer, poolFor, id, NO_FILTERS } from './harness.mjs';

let seed = 20260811;
Math.random = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------
// Eigenschaft 1+3: Rundendisziplin. Kein Fahrzeug darf ein zweites Mal kommen,
// solange der aktuelle Pool noch ungezogene Fahrzeuge hat. Beim Rundenwechsel
// darf das erste Fahrzeug nicht das letzte der Vorrunde sein (Carry-over).
// ---------------------------------------------------------------------------
function rundendisziplin({ category, bikeFilterMode, vorlauf, draws = 300 }) {
  const d = createDrawer();

  // Vorlauf mit ABWEICHENDEM Filter: füllt die Blacklist mit Fahrzeugen, die im
  // späteren gefilterten Pool gar nicht vorkommen. Genau das kippte den Reset.
  for (let i = 0; i < vorlauf.count; i++) {
    d.drawVehicleForCategory(category, NO_FILTERS, vorlauf.bikeFilterMode);
  }

  const poolSize = poolFor(category, { bikeFilterMode }).length;
  // Vom Vorlauf geerbte Sperren: diese Fahrzeuge duerfen vor dem ersten Reset nicht kommen.
  const geerbteSperren = new Set(d.recent(category).map(id));

  const seq = [];
  let ersterReset = -1;
  for (let i = 0; i < draws; i++) {
    const toastsVorher = d.toasts.length;
    const r = d.drawVehicleForCategory(category, NO_FILTERS, bikeFilterMode);
    if (ersterReset === -1 && d.toasts.length > toastsVorher) ersterReset = i;
    seq.push(id(r.vehicle));
  }

  // Uebergangsphase: die erste Runde ist bereits angebrochen, ihre Restlaenge kennt nur
  // die Blacklist. Deshalb hier nur pruefen, dass nichts Gesperrtes durchrutscht ...
  const durchgerutscht = seq.slice(0, Math.max(ersterReset, 0)).filter(v => geerbteSperren.has(v));
  check(
    `Uebergang respektiert Vorsperren: ${category} / ${bikeFilterMode}`,
    durchgerutscht.length === 0 && ersterReset !== -1,
    ersterReset === -1 ? 'kein Reset beobachtet - Test aussagelos' : `${durchgerutscht.length} gesperrte Fahrzeuge vor dem ersten Reset`
  );

  // ... und die Rundendisziplin ab dem ersten Reset messen, wo eine volle Runde beginnt.
  const messung = seq.slice(Math.max(ersterReset, 0));
  let round = new Set();
  let last = null;
  const fruehwiederholungen = [];
  const carryOverVerstoesse = [];

  for (const v of messung) {
    if (round.has(v)) {
      if (round.size < poolSize) {
        fruehwiederholungen.push(`${v} nach ${round.size}/${poolSize}`);
      }
      // Rundenwechsel
      if (v === last) carryOverVerstoesse.push(v);
      round = new Set([v]);
    } else {
      round.add(v);
      if (round.size === 1 && last !== null && v === last) carryOverVerstoesse.push(v);
    }
    last = v;
  }

  const label = `${category} / ${bikeFilterMode} (Pool ${poolSize}, Vorlauf ${vorlauf.count}× ${vorlauf.bikeFilterMode})`;
  check(
    `Rundendisziplin: ${label}`,
    fruehwiederholungen.length === 0,
    fruehwiederholungen.length ? `${fruehwiederholungen.length} vorzeitige Wiederholungen, z.B. ${fruehwiederholungen[0]}` : `${messung.length} Ziehungen sauber (ab dem ersten Reset)`
  );
  check(
    `Carry-over: ${label}`,
    carryOverVerstoesse.length === 0,
    carryOverVerstoesse.length ? `${carryOverVerstoesse.length}× dasselbe Fahrzeug über den Rundenwechsel` : 'kein Rundenwechsel-Duplikat'
  );
}

// Der Filterwechsel-Fall: erst ohne Filter ziehen, dann mit Top-Tier weiter.
rundendisziplin({ category: 'Drift', bikeFilterMode: 'top_tier', vorlauf: { count: 4, bikeFilterMode: 'no_bike' } });
rundendisziplin({ category: 'Monster Truck', bikeFilterMode: 'top_tier', vorlauf: { count: 9, bikeFilterMode: 'no_bike' } });
rundendisziplin({ category: 'AGP', bikeFilterMode: 'top_tier', vorlauf: { count: 12, bikeFilterMode: 'no_bike' } });
// Und der einfache Fall ohne Filterwechsel — der muss ebenfalls halten.
rundendisziplin({ category: 'Motocross', bikeFilterMode: 'no_bike', vorlauf: { count: 0, bikeFilterMode: 'no_bike' } });

// ---------------------------------------------------------------------------
// Eigenschaft 2: Nach dem Blacklist-Reset ist das gerade gezogene Fahrzeug
// gesperrt — die Liste hat genau einen Eintrag, auch im localStorage.
// ---------------------------------------------------------------------------
function resetTraegtEin(category) {
  const d = createDrawer();
  const poolSize = poolFor(category, { bikeFilterMode: 'no_bike' }).length;
  for (let i = 0; i < poolSize; i++) d.drawVehicleForCategory(category, NO_FILTERS, 'no_bike');
  const vorReset = d.recent(category).length;
  const r = d.drawVehicleForCategory(category, NO_FILTERS, 'no_bike'); // löst Reset aus
  const nachReset = d.recent(category);
  const persistiert = d.persisted(category);

  check(
    `Reset trägt ein: ${category} (Pool ${poolSize})`,
    nachReset.length === 1 && id(nachReset[0]) === id(r.vehicle),
    `vor Reset ${vorReset}, nach Reset ${nachReset.length} Einträge (erwartet 1)`
  );
  check(
    `Reset persistiert: ${category}`,
    persistiert === 1,
    `localStorage hält ${persistiert} Einträge (erwartet 1)`
  );
}

resetTraegtEin('Drift');
resetTraegtEin('Motocross');
resetTraegtEin('Monster Truck');

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} bestanden`);
process.exit(failed.length ? 1 : 0);
