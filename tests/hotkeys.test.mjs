// Prueft die beiden globalen keydown-Listener aus zendomizer.html:
// - Enter loest eine Ziehung aus (dieselbe wie der GO-Knopf)
// - kein Hotkey feuert, waehrend jemand in ein Textfeld tippt (z.B. Twitch-Token)
// - Checkboxen und Dropdowns bleiben durchlaessig, sonst waere "Filter setzen, Enter" kaputt
import { extract, extractAt, HTML } from './harness.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok });
  // Detail beschreibt den Fehlerfall - bei Erfolg waere es irrefuehrend
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

const el = (tagName, props = {}) => ({ tagName, isContentEditable: false, ...props });
const TEXTFELD = el('INPUT', { type: 'password' });   // #twitchToken
const CHECKBOX = el('INPUT', { type: 'checkbox' });
const DROPDOWN = el('SELECT');
const BODY = el('BODY');

function sandbox() {
  const listeners = [];
  const aufrufe = { handleGo: 0, copyToClipboard: 0, toasts: [] };

  const deps = {
    document: { addEventListener: (evt, fn) => { if (evt === 'keydown') listeners.push(fn); } },
    handleGo: () => aufrufe.handleGo++,
    copyToClipboard: () => aufrufe.copyToClipboard++,
    showToast: (m) => aufrufe.toasts.push(m),
    t: (k) => k,
    console: { log() {}, table() {} },
    localStorage: { setItem() {}, removeItem() {}, getItem: () => null },
  };

  const keys = Object.keys(deps);
  const fn = new Function(...keys, `
    let recentDraws = { Drift: [{ brand: 'x' }] };
    const window = { drawLog: [], drawRound: 5, devLoggingEnabled: false, recentDraws: null };
    ${extract('isTypingTarget', { optional: true })}
    ${extractAt(HTML.indexOf("document.addEventListener('keydown', (e) => {"), 'Listener 1')});
    ${extractAt(HTML.indexOf('document.addEventListener("keydown", function (e) {'), 'Listener 2')});
    return { blacklistLeer: () => Object.keys(recentDraws).length === 0, drawRound: () => window.drawRound };
  `);

  const api = fn(...keys.map(k => deps[k]));
  return {
    ...api,
    aufrufe,
    press: (key, target, { shiftKey = false } = {}) => {
      for (const l of listeners) l({ key, shiftKey, target });
    },
  };
}

// --- Enter loest eine Ziehung aus ------------------------------------------
{
  const s = sandbox();
  s.press('Enter', BODY);
  check('Enter startet eine Ziehung', s.aufrufe.handleGo === 1, `handleGo ${s.aufrufe.handleGo}x aufgerufen`);
}

// --- Textfeld: kein Hotkey darf feuern --------------------------------------
{
  const s = sandbox();
  s.press('Enter', TEXTFELD);
  check('Enter im Textfeld zieht nicht', s.aufrufe.handleGo === 0, `handleGo ${s.aufrufe.handleGo}x aufgerufen`);
}
{
  const s = sandbox();
  s.press('c', TEXTFELD);
  check('"c" im Textfeld kopiert nicht', s.aufrufe.copyToClipboard === 0, `copyToClipboard ${s.aufrufe.copyToClipboard}x aufgerufen`);
}
{
  const s = sandbox();
  s.press('R', TEXTFELD, { shiftKey: true });
  check('Shift+R im Textfeld loescht die Blacklist nicht', !s.blacklistLeer(), 'Blacklist wurde geleert');
}
{
  const s = sandbox();
  s.press('X', TEXTFELD, { shiftKey: true });
  check('Shift+X im Textfeld loescht das Ziehlog nicht', s.drawRound() === 5, `drawRound=${s.drawRound()}`);
}
{
  const s = sandbox();
  s.press('H', TEXTFELD, { shiftKey: true });
  check('Shift+H im Textfeld zeigt keine Hilfe', s.aufrufe.toasts.length === 0, `${s.aufrufe.toasts.length} Toasts`);
}

// --- Ausserhalb von Textfeldern muessen die Hotkeys weiter funktionieren ----
{
  const s = sandbox();
  s.press('R', BODY, { shiftKey: true });
  check('Shift+R ausserhalb loescht die Blacklist', s.blacklistLeer(), 'Blacklist blieb gefuellt');
}
{
  const s = sandbox();
  s.press('c', BODY);
  check('"c" ausserhalb kopiert', s.aufrufe.copyToClipboard === 1, `copyToClipboard ${s.aufrufe.copyToClipboard}x`);
}

// --- Checkbox und Dropdown sind keine Textfelder ----------------------------
{
  const s = sandbox();
  s.press('Enter', CHECKBOX);
  check('Enter mit Fokus auf einer Kategorie-Checkbox zieht', s.aufrufe.handleGo === 1, `handleGo ${s.aufrufe.handleGo}x`);
}
{
  const s = sandbox();
  s.press('Enter', DROPDOWN);
  check('Enter mit Fokus auf einem Filter-Dropdown zieht', s.aufrufe.handleGo === 1, `handleGo ${s.aufrufe.handleGo}x`);
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} bestanden`);
process.exit(failed.length ? 1 : 0);
