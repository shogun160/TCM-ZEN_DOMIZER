// Haelt die Fehlercodes des Workers und ihre Uebersetzung im Frontend zusammen.
//
// Der Worker meldet nur einen Code, den Text baut das Frontend daraus. Fehlt ein
// Code in TWITCH_ERROR_KEYS, faellt der Toast auf die generische Meldung zurueck -
// der Streamer bekaeme dann "Twitch nicht erreichbar", obwohl in Wahrheit der Bot
// kein Moderator mehr ist.
import fs from 'node:fs';
import { extract, extractBlock, HTML } from './harness.mjs';

const WORKER = fs.readFileSync(new URL('../twitch-bot/worker.js', import.meta.url), 'utf8');
const I18N = JSON.parse(fs.readFileSync(new URL('../translations/i18n.json', import.meta.url), 'utf8'));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

// --- Codes aus beiden Seiten einlesen ---------------------------------------
const frontendCodes = Object.fromEntries(
  [...extractBlock('const TWITCH_ERROR_KEYS = {', '};').matchAll(/(\w+):\s*"([^"]+)"/g)]
    .map((m) => [m[1], m[2]])
);

// Die Codes stehen im Worker als benannte Konstanten - so sind sie eindeutig
// lesbar. Ein Regex ueber die Verwendungsstellen wuerde auch Zeichenketten
// mitnehmen, die nur zufaellig danebenstehen (z.B. das Argument von
// dropCode.includes("automod")).
const workerCodes = [...WORKER.matchAll(/^\s+[A-Z_]+:\s*"([a-z_]+)",$/gm)].map((m) => m[1]);

check('Frontend-Zuordnung eingelesen', Object.keys(frontendCodes).length > 0, 'TWITCH_ERROR_KEYS nicht gefunden');
check('Worker-Codes eingelesen', workerCodes.length > 0, 'keine Codes in worker.js gefunden');

// --- Jeder Worker-Code hat eine Meldung -------------------------------------
{
  const unbekannt = workerCodes.filter((c) => !(c in frontendCodes));
  check('Jeder Worker-Code hat eine eigene Meldung', unbekannt.length === 0,
    `ohne Eintrag in TWITCH_ERROR_KEYS: ${unbekannt.join(', ')} — sonst greift die generische Meldung`);
}

// --- Jeder i18n-Schluessel existiert in beiden Sprachen ---------------------
for (const sprache of ['de', 'en']) {
  const fehlend = Object.values(frontendCodes).filter((k) => I18N[sprache][k] === undefined);
  check(`Alle Meldungen in "${sprache}" vorhanden`, fehlend.length === 0,
    `ohne Uebersetzung: ${fehlend.join(', ')}`);
}

// --- Der Rueckfall-Schluessel muss existieren -------------------------------
{
  const quelltext = extractBlock('const TWITCH_ERROR_KEYS = {', '};');
  check('Rueckfall "twitch_error" ist definiert', /twitch_error:/.test(quelltext),
    'ohne ihn wirft ein unbekannter Code einen leeren Toast');
}

// --- Die Meldung zur fehlgeschlagenen Anheftung ist uebersetzt --------------
for (const sprache of ['de', 'en']) {
  check(`Pin-Meldung in "${sprache}" vorhanden`, I18N[sprache]['twitch_err_pin_failed'] !== undefined,
    'twitch_err_pin_failed fehlt');
}

// --- Kein Toast ohne verknuepften Kanal -------------------------------------
// Wer Twitch nicht nutzt, darf nach einer Ziehung keine Twitch-Meldung sehen.
{
  const quelltext = extract('sendTwitchAnnouncement');
  const frueherAbbruch = quelltext.indexOf('if (!token) return;');
  const ersterToast = quelltext.indexOf('showToast');
  check('Ohne Token bricht die Funktion vor jedem Toast ab',
    frueherAbbruch !== -1 && frueherAbbruch < ersterToast,
    'der stille Abbruch bei fehlendem Token fehlt oder steht zu spaet');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} bestanden`);
process.exit(failed.length ? 1 : 0);
