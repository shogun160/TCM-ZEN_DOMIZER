// Pruefstand fuer die Ziehlogik. zendomizer.html ist eine einzelne Datei ohne Build und
// ohne Modulgrenzen - deshalb schneidet dieser Harness die zu testenden Funktionen per
// Klammer-Balance aus dem Quelltext heraus und fuehrt sie in Node mit Stubs aus.
// So wird der ECHTE ausgelieferte Code getestet, keine Kopie davon.
import fs from 'node:fs';

// ZENDOMIZER_HTML erlaubt es, den Test gegen eine andere Fassung laufen zu lassen
// (z.B. "git show HEAD:zendomizer.html"), um zu pruefen, dass er den Fehler wirklich faengt.
const HTML = fs.readFileSync(process.env.ZENDOMIZER_HTML || new URL('../zendomizer.html', import.meta.url), 'utf8');
const VEHICLES = JSON.parse(fs.readFileSync(new URL('../cars/vehicles.json', import.meta.url), 'utf8'));

// Schneidet eine Funktion per Klammer-Balance heraus. Strings, Template-Literale
// und Kommentare werden übersprungen, sonst zählen Klammern aus Textbausteinen mit.
function extract(name, { optional = false } = {}) {
  const start = HTML.indexOf(`function ${name}(`);
  if (start === -1) {
    if (optional) return '';
    throw new Error(`Funktion ${name} nicht gefunden`);
  }

  // Erst die Parameterliste ueberspringen: bei "function f(draw, options = {})"
  // wuerde die Klammer-Balance sonst am Default-Wert "{}" starten und die
  // Funktion nach zwei Zeichen fuer beendet halten.
  let i = start + `function ${name}`.length;
  let runde = 0;
  for (; i < HTML.length; i++) {
    if (HTML[i] === '(') runde++;
    else if (HTML[i] === ')') {
      runde--;
      if (runde === 0) { i++; break; }
    }
  }

  return HTML.slice(start, i) + extractAt(i, name);
}

// Schneidet ab beliebiger Startposition bis zur passenden schließenden Klammer.
export function extractAt(start, label = 'Block') {
  const src = HTML.slice(start);
  let depth = 0, started = false;
  const stack = []; // 'template' = innerhalb `...`, für ${ }-Verschachtelung
  for (let i = 0; i < src.length; i++) {
    const c = src[i], next = src[i + 1];
    const mode = stack[stack.length - 1];

    if (mode === 'line') { if (c === '\n') stack.pop(); continue; }
    if (mode === 'block') { if (c === '*' && next === '/') { stack.pop(); i++; } continue; }
    if (mode === "'" || mode === '"') {
      if (c === '\\') i++;
      else if (c === mode) stack.pop();
      continue;
    }
    if (mode === 'template') {
      if (c === '\\') i++;
      else if (c === '`') stack.pop();
      else if (c === '$' && next === '{') { stack.push('code'); i++; }
      continue;
    }
    // Code-Modus (auch innerhalb ${ })
    if (c === '/' && next === '/') { stack.push('line'); i++; continue; }
    if (c === '/' && next === '*') { stack.push('block'); i++; continue; }
    if (c === "'" || c === '"') { stack.push(c); continue; }
    if (c === '`') { stack.push('template'); continue; }
    if (c === '{') { if (mode === 'code') { stack.push('brace'); } else { depth++; started = true; } continue; }
    if (c === '}') {
      if (mode === 'brace') { stack.pop(); continue; }
      if (mode === 'code') { stack.pop(); continue; } // Ende von ${ }
      depth--;
      if (started && depth === 0) return src.slice(0, i + 1);
    }
  }
  throw new Error(`${label} nicht sauber abgegrenzt`);
}

// Schneidet ein Literal (Array, Map, ...) zwischen zwei Markern heraus - fuer
// Konstanten wie ROTATION, die keine Funktion sind.
export function extractBlock(startMarker, endMarker, { optional = false } = {}) {
  const start = HTML.indexOf(startMarker);
  if (start === -1) {
    if (optional) return '';
    throw new Error(`Marker "${startMarker}" nicht gefunden`);
  }
  const end = HTML.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`Endmarker "${endMarker}" nach "${startMarker}" nicht gefunden`);
  return HTML.slice(start, end + endMarker.length);
}

const JET_VEHICLE = { category: 'Jet', brand: 'Dassault Aviation', model: 'Alpha Jet – Red Bull Edition', year: null, country: null, era: null, bike: false, top_tier: false };

// opts.quotaBytes ahmt einen vollen localStorage nach: sobald die Summe aller Werte das
// Limit ueberschreitet, wirft setItem() - so wie der Browser bei erschoepfter Quota.
export function createDrawer({ quotaBytes = Infinity } = {}) {
  const store = {};
  const belegt = () => Object.values(store).reduce((n, v) => n + String(v).length, 0);
  const localStorage = {
    setItem: (k, v) => {
      const neu = belegt() - String(store[k] ?? '').length + String(v).length;
      if (neu > quotaBytes) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      store[k] = v;
    },
    getItem: (k) => store[k] ?? null,
    removeItem: (k) => { delete store[k]; },
    belegt,
  };
  const win = { drawLog: [], drawRound: 0, devLoggingEnabled: false };
  const toasts = [];
  const warnungen = [];

  const factory = new Function('deps', `
    const { vehicles, localStorage, JET_VEHICLE, window, showToast, t, translateEra, translateCountry, console } = deps;
    let recentDraws = {};
    ${extract('shuffle')}
    ${extract('formatVehicleName')}
    ${extract('isSameVehicle', { optional: true })}
    ${extract('persist', { optional: true })}
    ${extract('appendDrawLog', { optional: true })}
    ${extractBlock('const MAX_DRAW_LOG', ';', { optional: true })}
    ${extract('drawVehicleForCategory')}
    return {
      drawVehicleForCategory,
      maxDrawLog: () => (typeof MAX_DRAW_LOG === 'undefined' ? null : MAX_DRAW_LOG),
      recent: (cat) => recentDraws[cat] ? recentDraws[cat].slice() : [],
      setRecent: (cat, list) => { recentDraws[cat] = list; },
      persisted: (cat) => {
        const raw = localStorage.getItem("zendomizerRecentDraws");
        if (!raw) return null;
        const parsed = JSON.parse(raw)[cat];
        return parsed ? parsed.length : 0;
      },
    };
  `);

  const api = factory({
    vehicles: VEHICLES,
    localStorage,
    JET_VEHICLE,
    window: win,
    showToast: (msg) => toasts.push(msg),
    t: (key, vars = {}) => `${key}:${JSON.stringify(vars)}`,
    translateEra: (v) => v,
    translateCountry: (v) => v,
    // Warnungen abfangen statt sie in die Testausgabe zu schuetten - der Quota-Fall
    // warnt bewusst, das soll pruefbar sein und nicht als Fehler aussehen.
    console: { log() {}, table() {}, warn: (...args) => warnungen.push(args.join(' ')) },
  });

  return { ...api, toasts, win, localStorage, warnungen };
}

export const id = (v) => `${v.brand}|${v.model}|${v.year}`;

export function poolFor(category, { bikeFilterMode = 'no_bike' } = {}) {
  return VEHICLES.filter(v =>
    v.category === category &&
    ((bikeFilterMode === 'all') ||
     (bikeFilterMode === 'no_bike' && !v.bike) ||
     (bikeFilterMode === 'bike' && v.bike) ||
     (bikeFilterMode === 'top_tier' && v.top_tier === true) ||
     (bikeFilterMode === 'rc_cars' && v.brand === 'PHAZR RC'))
  );
}

export { extract, HTML };

export const NO_FILTERS = { brand: '', country: '', era: '' };
