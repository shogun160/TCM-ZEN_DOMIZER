// Prüft Fix 4: der Klick auf einen Slot rollt genau DIESEN Slot neu, auch wenn
// dieselbe Kategorie mehrfach besetzt ist (Grand-Race-Rotationen, 1-2 Kategorien).
// Führt den echten Klick-Handler und die echte rerollSingleSlot() aus zendomizer.html aus.
import { extract, extractAt, extractBlock, HTML } from './harness.mjs';

let seed = 4711;
Math.random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// --- Fake-DOM: nur so viel, wie die beiden Codestellen anfassen ------------
function makeEl(cls) {
  const children = {};
  const el = {
    className: cls,
    classList: { add() {}, remove() {} },
    querySelector: (sel) => children[sel] || null,
    _children: children,
  };
  el.closest = (sel) => (sel === '.slot-box' && cls === 'slot-box' ? el : null);
  return el;
}

function makeSlot(category) {
  const box = makeEl('slot-box');
  box._children['.slot-category'] = { textContent: category };
  box._children['.slot-name'] = { textContent: '' };
  box._children['.slot-warning'] = { textContent: '', innerHTML: '' };
  return box;
}

function run(rotation, klickAufSlot) {
  const boxes = rotation.map(makeSlot);
  // selectedOrder ist dedupliziert - genau so baut updateGrandraceState() sie auf
  const selectedOrder = [...new Set(rotation)];
  const lastSelection = rotation.map((cat, i) => ({ brand: 'ALT', model: `slot${i}`, year: 2000, category: cat }));

  let listener = null;
  const document = {
    addEventListener: (evt, fn) => { if (evt === 'click') listener = fn; },
    querySelectorAll: (sel) => (sel === '.slot-box' ? boxes : []),
  };

  const env = {
    document,
    selectedOrder,
    lastSelection,
    drawExecuted: true,
    bikeFilterMode: 'no_bike',
    getCurrentFilters: () => ({ brand: '', country: '', era: '' }),
    // Ziehung stubben: liefert ein eindeutig erkennbares "neues" Fahrzeug
    drawVehicleForCategory: (category) => ({ vehicle: { brand: 'NEU', model: category, year: 2026 }, ignoredFilters: [] }),
    isSameVehicle: (a, b) => !!a && !!b && a.brand === b.brand && a.model === b.model && a.year === b.year,
    formatVehicleName: (v) => `${v.brand} ${v.model} (${v.year})`,
    recentDraws: {},
    vehicles: [],
    localStorage: { setItem() {}, getItem: () => null },
    showToast: () => {},
    t: (k) => k,
    copyToClipboard: () => {},
    setTimeout: () => {},
    window: { drawLog: [], drawRound: 1 },
    console: { log() {}, warn() {} },
  };

  const keys = Object.keys(env);
  const handlerSrc = extractAt(HTML.indexOf("document.addEventListener('click', function(e) {"), 'Klick-Handler') + ');';
  const fn = new Function(...keys, `
    ${extractBlock('const MAX_DRAW_LOG', ';')}
    ${extract('persist')}
    ${extract('appendDrawLog')}
    ${extract('rerollSingleSlot')}
    ${handlerSrc}
  `);

  // Der Handler registriert sich beim document-Stub, der ihn in "listener" ablegt.
  fn(...keys.map(k => env[k]));
  if (!listener) throw new Error('Klick-Handler nicht registriert');

  listener({ target: boxes[klickAufSlot] });

  return { boxes, lastSelection };
}

// Fall 1: Grand-Race "Hyper > Hyper > Hyper" - Klick auf Slot 3
{
  const { boxes, lastSelection } = run(['Hypercar', 'Hypercar', 'Hypercar'], 2);
  const gerollt = boxes.map((b, i) => b._children['.slot-name'].textContent.startsWith('NEU') ? i : null).filter(i => i !== null);
  check('Hyper > Hyper > Hyper: Klick auf Slot 3 rollt Slot 3',
    gerollt.length === 1 && gerollt[0] === 2,
    `neu befüllt: Slot ${gerollt.map(i => i + 1).join(',') || 'keiner'}`);
  check('Hyper > Hyper > Hyper: lastSelection[2] aktualisiert',
    lastSelection[2].brand === 'NEU' && lastSelection[0].brand === 'ALT',
    `Slot1=${lastSelection[0].brand}, Slot3=${lastSelection[2].brand}`);
}

// Fall 2: "Racing > ST2 > Racing" (Pearl Harbor) - Klick auf Slot 3
{
  const { boxes, lastSelection } = run(['Racing', 'Street Tier 2', 'Racing'], 2);
  const gerollt = boxes.map((b, i) => b._children['.slot-name'].textContent.startsWith('NEU') ? i : null).filter(i => i !== null);
  check('Racing > ST2 > Racing: Klick auf Slot 3 rollt Slot 3',
    gerollt.length === 1 && gerollt[0] === 2,
    `neu befüllt: Slot ${gerollt.map(i => i + 1).join(',') || 'keiner'}`);
  check('Racing > ST2 > Racing: lastSelection[2] aktualisiert',
    lastSelection[2].brand === 'NEU' && lastSelection[0].brand === 'ALT',
    `Slot1=${lastSelection[0].brand}, Slot3=${lastSelection[2].brand}`);
}

// Fall 3: unterschiedliche Kategorien - darf sich nicht verändert haben
{
  const { boxes } = run(['Street Tier 1', 'Racing', 'Hypercar'], 1);
  const gerollt = boxes.map((b, i) => b._children['.slot-name'].textContent.startsWith('NEU') ? i : null).filter(i => i !== null);
  check('ST1 > Racing > Hyper: Klick auf Slot 2 rollt Slot 2',
    gerollt.length === 1 && gerollt[0] === 1,
    `neu befüllt: Slot ${gerollt.map(i => i + 1).join(',') || 'keiner'}`);
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} bestanden`);
process.exit(failed.length ? 1 : 0);
