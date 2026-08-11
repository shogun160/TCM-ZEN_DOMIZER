// Prueft das Verhalten von sendTwitchAnnouncement() rund um den Twitch-Dialog:
// schliesst er sich nach erfolgreicher Verknuepfung, bleibt er bei Fehlern offen,
// und schweigt die Funktion, solange kein Kanal verknuepft ist.
import { extract, extractBlock } from './harness.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

/**
 * Fuehrt die echte sendTwitchAnnouncement() gegen eine gefaelschte Worker-Antwort aus.
 * Alles, was sie sonst anfasst, ist gestubbt - beobachtet werden Toasts, die
 * Detailzeile und ob der Dialog geschlossen wurde.
 */
async function lauf({ token = 'tok', antwort, wirft = false, type = null, draw = [{ category: 'Racing' }] }) {
  const beobachtet = { toasts: [], status: [], geschlossen: 0, dialogState: 0 };

  const deps = {
    localStorage: { getItem: () => token, setItem() {}, removeItem() {} },
    fetch: async () => {
      if (wirft) throw new Error('Failed to fetch');
      return { ok: antwort.status < 400, status: antwort.status, json: async () => antwort.body };
    },
    showToast: (text) => beobachtet.toasts.push(text),
    setTwitchStatus: (text, fehler) => beobachtet.status.push({ text, fehler }),
    closeTwitchDialog: () => beobachtet.geschlossen++,
    updateTwitchDialogState: () => beobachtet.dialogState++,
    currentTwitchModifier: () => null,
    currentTwitchFilters: () => null,
    t: (k) => k,
    console: { warn() {}, log() {} },
  };

  const keys = Object.keys(deps);
  const fn = new Function(...keys, `
    ${extractBlock('const DEFAULT_TWITCH_WORKER_URL', ';')}
    ${extractBlock('const TWITCH_ERROR_KEYS = {', '};')}
    ${extract('sendTwitchAnnouncement')}
    return sendTwitchAnnouncement;
  `);

  await fn(...keys.map((k) => deps[k]))(draw, type ? { type } : {});
  return beobachtet;
}

const ERFOLG = { status: 200, body: { success: true, pinned: true } };

// --- Verknuepfung erfolgreich -> Dialog zu, Rueckmeldung als Toast ----------
{
  const b = await lauf({ type: 'connected', antwort: ERFOLG });
  check('Erfolgreiche Verknuepfung schliesst den Dialog', b.geschlossen === 1,
    `closeTwitchDialog ${b.geschlossen}x aufgerufen`);
  check('Dabei erscheint eine Bestaetigung als Toast', b.toasts.includes('twitch_connect_ok'),
    `Toasts: ${JSON.stringify(b.toasts)}`);
}

// --- Eine normale Ziehung laesst den Dialog in Ruhe -------------------------
{
  const b = await lauf({ antwort: ERFOLG });
  check('Erfolgreiche Ziehung schliesst nichts', b.geschlossen === 0,
    `closeTwitchDialog ${b.geschlossen}x aufgerufen`);
  check('Erfolgreiche Ziehung meldet sich nicht per Toast', b.toasts.length === 0,
    `Toasts: ${JSON.stringify(b.toasts)}`);
}

// --- Fehler: Dialog bleibt offen, Toast erscheint, Detail wird hinterlegt ---
{
  const b = await lauf({ type: 'connected', antwort: { status: 401, body: { success: false, code: 'token_invalid', error: 'Kanal nicht verbunden.' } } });
  check('Fehlgeschlagene Verknuepfung schliesst den Dialog NICHT', b.geschlossen === 0,
    'der Dialog ging zu, obwohl die Verbindung nicht steht');
  check('Der passende Fehlertext erscheint als Toast', b.toasts.includes('twitch_err_not_connected'),
    `Toasts: ${JSON.stringify(b.toasts)}`);
  check('Das Detail landet in der Dialogzeile', b.status.some((s) => s.fehler && /Kanal nicht verbunden/.test(s.text)),
    `Statuszeilen: ${JSON.stringify(b.status)}`);
}

// --- Codes werden auf die jeweils eigene Meldung abgebildet -----------------
for (const [code, erwartet] of [
  ['not_moderator', 'twitch_err_not_moderator'],
  ['automod_held', 'twitch_err_automod'],
  ['message_dropped', 'twitch_err_dropped'],
  ['twitch_error', 'twitch_err_generic'],
]) {
  const b = await lauf({ antwort: { status: 200, body: { success: false, code, error: 'Detail' } } });
  check(`Code "${code}" ergibt die eigene Meldung`, b.toasts.includes(erwartet),
    `Toasts: ${JSON.stringify(b.toasts)}`);
}

// --- Unbekannter Code faellt auf die generische Meldung zurueck -------------
{
  const b = await lauf({ antwort: { status: 200, body: { success: false, code: 'voellig_neu', error: 'Detail' } } });
  check('Unbekannter Code ergibt die generische Meldung', b.toasts.includes('twitch_err_generic'),
    `Toasts: ${JSON.stringify(b.toasts)}`);
}

// --- Netzwerkfehler ---------------------------------------------------------
{
  const b = await lauf({ wirft: true, antwort: ERFOLG });
  check('Netzwerkfehler meldet "nicht erreichbar"', b.toasts.includes('twitch_err_generic'),
    `Toasts: ${JSON.stringify(b.toasts)}`);
}

// --- Ohne verknuepften Kanal bleibt alles still -----------------------------
{
  const b = await lauf({ token: '', antwort: ERFOLG });
  check('Ohne Token gibt es keinerlei Meldung', b.toasts.length === 0 && b.status.length === 0,
    `Toasts: ${JSON.stringify(b.toasts)}, Status: ${JSON.stringify(b.status)}`);
}

// --- Gepostet, aber nicht angepinnt -----------------------------------------
{
  const b = await lauf({ antwort: { status: 200, body: { success: true, pinned: false, pinError: 'Anpinnen fehlgeschlagen.' } } });
  check('Fehlgeschlagenes Anpinnen wird gemeldet', b.toasts.includes('twitch_err_pin_failed'),
    `Toasts: ${JSON.stringify(b.toasts)}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} bestanden`);
process.exit(failed.length ? 1 : 0);
