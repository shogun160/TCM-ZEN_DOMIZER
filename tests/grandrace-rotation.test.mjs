// Charakterisierungstest fuer die Grand-Race-Auswahl: geht ALLE Rotationseintraege
// durch und prueft, dass updateGrandraceState() die richtigen Kategorien in der
// richtigen Reihenfolge setzt - inklusive "Jet", das keine Checkbox hat.
//
// Fuehrt die echte Funktion samt ROTATION und ROTATION_MAP aus zendomizer.html aus.
import { extract, extractBlock, HTML } from './harness.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok });
  if (!ok || process.env.VERBOSE) console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// Checkbox-Definitionen aus dem Markup lesen, damit Test und App nicht auseinanderlaufen
const CHECKBOXES = [...HTML.matchAll(/<input type="checkbox" id="(cat[^"]*)" class="catCheckbox"[^>]*?(?:value="([^"]*)")?\/>/g)]
  .map(m => ({ id: m[1], value: m[2] || '' }));

function makeDom() {
  const boxes = CHECKBOXES.map(c => ({ ...c, checked: false, disabled: false, className: 'catCheckbox' }));
  const byId = Object.fromEntries(boxes.map(b => [b.id, b]));
  const classList = () => ({ add() {}, remove() {} });
  const title = { classList: classList() };
  const grid = { classList: classList() };

  return {
    boxes,
    document: {
      getElementById: (id) => (id === 'yourPickTitle' ? title : byId[id] || null),
      querySelector: (sel) => (sel === '.category-grid' ? grid : null),
      querySelectorAll: (sel) => {
        if (sel === '.catCheckbox') return boxes;
        if (sel === '.catCheckbox:checked') return boxes.filter(b => b.checked);
        if (sel === '.catCheckbox:not(:checked)') return boxes.filter(b => !b.checked);
        return [];
      },
    },
  };
}

function createRotationEngine() {
  const dom = makeDom();
  const toasts = [];

  const factory = new Function('deps', `
    const { document, showToast, t, translateEra, translateCountry } = deps;
    let currentIndex = 0;
    function getCurrentEventIndex() { return currentIndex; }
    let selectedOrder = [], grandraceCategories = [];
    function updateCheckboxBadges() {}
    function updateSlotBoxes() {}
    function updateResetButtonState() {}
    function updateGoButtonState() {}
    ${extractBlock('const ROTATION = [', '];')}
    ${extractBlock('const ROTATION_MAP = new Map([', ']);')}
    ${extract('arraysEqual')}
    ${extract('updateGrandraceState')}
    return {
      ROTATION,
      run: (i, click) => { currentIndex = i; updateGrandraceState(click); },
      state: () => ({ selectedOrder: selectedOrder.slice() }),
      reset: () => { selectedOrder = []; grandraceCategories = []; },
    };
  `);

  const api = factory({
    document: dom.document,
    showToast: (msg) => toasts.push(msg),
    t: (key, vars = {}) => key,
    translateEra: (v) => v,
    translateCountry: (v) => v,
  });

  return { ...api, dom, toasts };
}

// ---------------------------------------------------------------------------
// Fuer jeden Rotationseintrag: gesetzte Checkboxen und selectedOrder pruefen
// ---------------------------------------------------------------------------
const engine = createRotationEngine();
const VALUE_BY_KEY = { ST1: 'Street Tier 1', ST2: 'Street Tier 2', Hyper: 'Hypercar', Racing: 'Racing', AGP: 'AGP', Motocross: 'Motocross', Rally: 'Rally', 'Rally/Plane': 'Rally', RR: 'Rally Raid', Monster: 'Monster Truck', Drift: 'Drift' };

// Nach einem Season-Sync ist das der wahrscheinlichste Fehler: ein Kategorie-Kuerzel,
// das ROTATION_MAP nicht kennt. Der Produktivcode wuerde den Slot stillschweigend
// ueberspringen, statt ihn zu belegen - deshalb hier explizit pruefen.
{
  const bekannt = new Set([...Object.keys(VALUE_BY_KEY), 'Jet']);
  const unbekannt = [...new Set(engine.ROTATION.flatMap(e => e[1].split(' > ')))].filter(k => !bekannt.has(k));
  check('Alle Kategorie-Kuerzel bekannt', unbekannt.length === 0,
    unbekannt.length ? `unbekannt: ${unbekannt.join(', ')} — in ROTATION_MAP und im Test ergaenzen` : `${bekannt.size} Kuerzel`);

  // Jeder Eintrag muss genau drei Slots haben
  const falscheLaenge = engine.ROTATION.map((e, i) => [i, e[1].split(' > ').length]).filter(([, n]) => n !== 3);
  check('Jeder Rotationseintrag hat 3 Slots', falscheLaenge.length === 0,
    falscheLaenge.length ? `Eintraege ${falscheLaenge.map(([i, n]) => `#${i} (${n})`).join(', ')}` : `${engine.ROTATION.length} Eintraege`);
}

let geprueft = 0;
for (let i = 0; i < engine.ROTATION.length; i++) {
  const entry = engine.ROTATION[i];
  const keys = entry[1].split(' > ');

  // Erwartung: Rotationsreihenfolge 1:1, dedupliziert, "Jet" bleibt als virtueller Slot
  const erwartet = [];
  for (const k of keys) {
    const v = k === 'Jet' ? 'Jet' : VALUE_BY_KEY[k];
    if (v && !erwartet.includes(v)) erwartet.push(v);
  }

  const dom = engine.dom;
  dom.boxes.forEach(b => { b.checked = b.id === 'catGR'; b.disabled = false; });
  engine.reset();
  engine.run(i, false);

  const st = engine.state();
  const angehakt = dom.boxes.filter(b => b.checked && b.id !== 'catGR').map(b => b.value).sort();
  const erwarteteBoxen = erwartet.filter(v => v !== 'Jet').sort();

  const label = `#${i} ${entry[0]} — ${entry[1]}`;
  check(`Reihenfolge ${label}`, JSON.stringify(st.selectedOrder) === JSON.stringify(erwartet),
    `erwartet ${JSON.stringify(erwartet)}, war ${JSON.stringify(st.selectedOrder)}`);
  check(`Checkboxen ${label}`, JSON.stringify(angehakt) === JSON.stringify(erwarteteBoxen),
    `erwartet ${JSON.stringify(erwarteteBoxen)}, war ${JSON.stringify(angehakt)}`);
  check(`Rest gesperrt ${label}`, dom.boxes.every(b => b.id === 'catGR' || b.checked || b.disabled),
    'nicht gewählte Kategorien müssen disabled sein');
  geprueft++;
}

// Grand Race abgewählt -> Funktion darf weder Auswahl noch Checkboxen anfassen
{
  const e = createRotationEngine();
  e.dom.boxes.forEach(b => { b.checked = false; b.disabled = false; });
  e.reset();
  e.run(0, false);
  check('Ohne Grand-Race-Haken passiert nichts',
    e.state().selectedOrder.length === 0 && e.dom.boxes.every(b => !b.checked && !b.disabled),
    `selectedOrder=${JSON.stringify(e.state().selectedOrder)}, angehakt=${e.dom.boxes.filter(b => b.checked).length}`);
}

// Jet-Rotationen muessen einen virtuellen Jet-Slot an der richtigen Position haben
{
  const jetIdx = engine.ROTATION.map((e, i) => [e, i]).filter(([e]) => e[1].includes('Jet')).map(([, i]) => i);
  check('Jet-Rotationen vorhanden', jetIdx.length > 0, `${jetIdx.length} Eintraege mit Jet`);
  for (const i of jetIdx) {
    engine.dom.boxes.forEach(b => { b.checked = b.id === 'catGR'; b.disabled = false; });
    engine.reset();
    engine.run(i, false);
    const pos = engine.ROTATION[i][1].split(' > ').indexOf('Jet');
    check(`Jet an Position ${pos + 1} in #${i}`, engine.state().selectedOrder[pos] === 'Jet',
      `selectedOrder=${JSON.stringify(engine.state().selectedOrder)}`);
  }
}

const failed = results.filter(r => !r.ok);
console.log(`${results.length - failed.length}/${results.length} bestanden (${geprueft} Rotationseintraege geprueft)`);
process.exit(failed.length ? 1 : 0);
