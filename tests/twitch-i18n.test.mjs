// Wacht darueber, dass im Twitch-Bereich nichts fest verdrahtet ist, was
// uebersetzt gehoert - weder im Dialog noch in den Seiten des Workers.
//
// Anlass: Der komplette Verknuepfungsvorgang war deutsch, egal was im
// ZENdomizer eingestellt war. Im Frontend fiel das nicht auf, weil dort nur
// die Beschriftungen aus i18n.json kommen - die Seiten kamen aber vom Worker.
import fs from 'node:fs';
import { extract, HTML } from './harness.mjs';

const I18N = JSON.parse(fs.readFileSync(new URL('../translations/i18n.json', import.meta.url), 'utf8'));
const AUTH = fs.readFileSync(new URL('../twitch-bot/src/auth.js', import.meta.url), 'utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

// --- Frontend: kein fester Text im Twitch-Dialog ----------------------------
{
  const dialog = HTML.slice(
    HTML.indexOf('<div id="twitchDialogBackdrop"'),
    HTML.indexOf('</body>')
  );

  // Beschriftungen, die updateTwitchLabels() zur Laufzeit setzt - sie duerfen im
  // Markup stehen (als Startwert), weil sie beim ersten applyTranslations()
  // ersetzt werden.
  const gesetzt = new Set(
    [...extract('updateTwitchLabels').matchAll(/getElementById\("(\w+)"\)/g)].map((m) => m[1])
  );

  for (const id of ['twitchDialogTitle', 'twitchTokenLabel', 'twitchConnectBtn', 'twitchDisconnectBtn', 'twitchCloseBtn']) {
    check(`updateTwitchLabels() setzt #${id}`, gesetzt.has(id),
      'sonst bleibt die Beschriftung in der Sprache des Markups stehen');
  }

  // Ein title-Attribut faellt sonst durch: es ist unsichtbar im Textfluss.
  const feste = [...dialog.matchAll(/title="([^"]+)"/g)].map((m) => m[1]);
  check('Kein festes title-Attribut im Dialog', feste.length === 0,
    `fest verdrahtet: ${feste.join(', ')} — per t() setzen`);
}

// --- Frontend: jeder benutzte Schluessel existiert in beiden Sprachen -------
{
  const twitchTeile = ['sendTwitchAnnouncement', 'openTwitchConnect', 'disconnectTwitch', 'updateTwitchLabels']
    .map((f) => extract(f)).join('\n');
  const schluessel = [...new Set([...twitchTeile.matchAll(/\bt\("([a-z_]+)"/g)].map((m) => m[1]))];

  check('Twitch-Funktionen benutzen i18n-Schluessel', schluessel.length > 0, 'keine t()-Aufrufe gefunden');

  for (const sprache of ['de', 'en']) {
    const fehlend = schluessel.filter((k) => I18N[sprache][k] === undefined);
    check(`Alle benutzten Schluessel in "${sprache}"`, fehlend.length === 0,
      `ohne Uebersetzung: ${fehlend.join(', ')}`);
  }
}

// --- Worker: beide Sprachen vollstaendig und gleich bestueckt --------------
{
  const bloecke = {};
  for (const sprache of ['de', 'en']) {
    const start = AUTH.indexOf(`  ${sprache}: {`);
    const ende = AUTH.indexOf('\n  },', start);
    bloecke[sprache] = [...AUTH.slice(start, ende).matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
  }

  check('Worker kennt beide Sprachen', bloecke.de.length > 0 && bloecke.en.length > 0,
    `de: ${bloecke.de.length}, en: ${bloecke.en.length}`);

  const nurDe = bloecke.de.filter((k) => !bloecke.en.includes(k));
  const nurEn = bloecke.en.filter((k) => !bloecke.de.includes(k));
  check('Beide Sprachen haben dieselben Eintraege', nurDe.length === 0 && nurEn.length === 0,
    `nur de: ${nurDe.join(', ')} | nur en: ${nurEn.join(', ')}`);
}

// --- Worker: die Seiten haengen nicht mehr an einer festen Sprache ----------
{
  check('Kein festes lang="de" mehr im Seitengeruest', !/<html lang="de"/.test(AUTH),
    'die Seite gibt sich unabhaengig vom Inhalt als deutsch aus');

  check('Die Sprache reist im State mit', /spracheAus/.test(AUTH) && /\$\{lang\}\./.test(AUTH),
    'ohne das kommt der Callback immer in der Standardsprache zurueck');

  // Der Kopier-Knopf ist Teil derselben Seite - ohne ihn muss der Token
  // muehsam von Hand markiert werden.
  check('Token-Seite hat einen Kopier-Knopf', /id="kopieren"/.test(AUTH) && /navigator\.clipboard/.test(AUTH),
    'kopieren-Knopf oder Clipboard-Aufruf fehlt');
  check('Kopier-Knopf ist in beiden Sprachen beschriftet',
    /kopieren:/.test(AUTH) && (AUTH.match(/kopieren:/g) || []).length >= 2,
    'die Beschriftung fehlt in einer Sprache');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} bestanden`);
process.exit(failed.length ? 1 : 0);
