// Haelt die drei Listen zusammen, die auseinanderlaufen koennen:
//   1. die Modifikatoren in ROTATION (zendomizer.html)
//   2. TWITCH_MODIFIER_KEYS (zendomizer.html) - Text -> Schluessel
//   3. MODIFIERS (twitch-bot/src/draw.js) - Schluessel -> Text + Icon
// Faellt eine aus dem Tritt, erscheint im Chat still kein Modifikator mehr.
import fs from 'node:fs';
import { extract, extractBlock, HTML } from './harness.mjs';

const WORKER_DRAW = fs.readFileSync(new URL('../twitch-bot/src/draw.js', import.meta.url), 'utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

// --- Listen einlesen --------------------------------------------------------
// ROTATION wird ausgewertet statt per Muster gelesen: die dritte Spalte ist optional,
// ein Regex greift sonst bei Eintraegen ohne Modifikator die Kategorien ab.
const ROTATION_ARRAY = new Function(`${extractBlock('const ROTATION = [', '];')} return ROTATION;`)();
const rotationModifier = [...new Set(ROTATION_ARRAY.map((e) => e[2]).filter(Boolean))];

const frontendKeys = Object.fromEntries(
  [...extractBlock('const TWITCH_MODIFIER_KEYS = {', '};').matchAll(/"([^"]+)":\s*"([^"]+)"/g)]
    .map((m) => [m[1], m[2]])
);

const workerKeys = [...WORKER_DRAW.matchAll(/\["([a-z_]+)",\s*\{\s*label:\s*"([^"]+)",\s*icon:\s*"([^"]*)"/g)]
  .map((m) => ({ key: m[1], label: m[2], icon: m[3] }));

check('Rotation liefert Modifikatoren', rotationModifier.length > 0, 'keine gefunden');
check('Frontend-Liste eingelesen', Object.keys(frontendKeys).length > 0, 'leer');
check('Worker-Liste eingelesen', workerKeys.length > 0, 'leer');

// --- Jeder Modifikator der Rotation ist abgedeckt ---------------------------
{
  const fehlend = rotationModifier.filter((m) => !(m in frontendKeys));
  check('Jeder Rotations-Modifikator hat einen Schluessel', fehlend.length === 0,
    `ohne Eintrag in TWITCH_MODIFIER_KEYS: ${fehlend.join(', ')}`);
}

// --- Jeder Frontend-Schluessel existiert im Worker --------------------------
{
  const workerSet = new Set(workerKeys.map((m) => m.key));
  const unbekannt = Object.values(frontendKeys).filter((k) => !workerSet.has(k));
  check('Jeder Schluessel ist dem Worker bekannt', unbekannt.length === 0,
    `im Worker nicht definiert: ${unbekannt.join(', ')}`);
}

// --- Die Beschriftung im Worker entspricht dem Text der Rotation ------------
{
  const abweichend = [];
  for (const [text, key] of Object.entries(frontendKeys)) {
    const imWorker = workerKeys.find((m) => m.key === key);
    if (imWorker && imWorker.label !== text) abweichend.push(`${key}: "${imWorker.label}" statt "${text}"`);
  }
  check('Beschriftungen stimmen mit der Rotation ueberein', abweichend.length === 0, abweichend.join('; '));
}

// --- Jeder Modifikator hat ein Icon -----------------------------------------
{
  const ohneIcon = workerKeys.filter((m) => !m.icon.trim());
  check('Jeder Modifikator hat ein Icon', ohneIcon.length === 0,
    `ohne Icon: ${ohneIcon.map((m) => m.key).join(', ')}`);
}

// --- currentTwitchModifier(): nur bei aktiver Grandrace-Auswahl -------------
function modifierFuer({ grandraceAktiv, index }) {
  const fn = new Function('document', 'ROTATION', 'getCurrentEventIndex', `
    ${extractBlock('const TWITCH_MODIFIER_KEYS = {', '};')}
    ${extract('currentTwitchModifier')}
    return currentTwitchModifier();
  `);
  return fn(
    { getElementById: (id) => (id === 'catGR' ? { checked: grandraceAktiv } : null) },
    ROTATION_ARRAY,
    () => index
  );
}


{
  const mitModifier = ROTATION_ARRAY.findIndex((e) => e[2] === 'No Collision');
  const ohneModifier = ROTATION_ARRAY.findIndex((e) => !e[2]);

  check('Aktive Grandrace-Auswahl liefert den Schluessel',
    modifierFuer({ grandraceAktiv: true, index: mitModifier }) === 'no_collision',
    `war ${modifierFuer({ grandraceAktiv: true, index: mitModifier })}`);

  check('Ohne Grandrace-Haken wird nichts gemeldet',
    modifierFuer({ grandraceAktiv: false, index: mitModifier }) === null,
    'es wurde ein Modifikator gemeldet, obwohl die Kategorien manuell gewaehlt sind');

  check('Rotation ohne Modifikator liefert null',
    modifierFuer({ grandraceAktiv: true, index: ohneModifier }) === null,
    `war ${modifierFuer({ grandraceAktiv: true, index: ohneModifier })}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} bestanden`);
process.exit(failed.length ? 1 : 0);
