// Prueft, dass der Ziehlog nicht unbegrenzt waechst und dass ein voller localStorage
// eine laufende Ziehung nicht abbricht.
//
// Hintergrund: drawLog bekommt drei Eintraege je Ziehung (~0,6 KB) und wurde nie
// beschnitten - bei 100 Ziehungen am Tag ist die 5-MB-Quota nach rund 80 Tagen erreicht.
// Danach warf setItem() mitten in drawVehicleForCategory().
import { createDrawer, NO_FILTERS } from './harness.mjs';

let seed = 99; Math.random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

const ziehe = (d, n, kategorie = 'Street Tier 1') => {
  for (let i = 0; i < n; i++) d.drawVehicleForCategory(kategorie, NO_FILTERS, 'no_bike');
};

// --- Der Ziehlog ist gedeckelt ---------------------------------------------
{
  const d = createDrawer();
  const max = d.maxDrawLog();
  check('MAX_DRAW_LOG ist definiert', max !== null && max > 0, 'Konstante fehlt');

  ziehe(d, (max || 500) * 2 + 50);
  check('Ziehlog bleibt gedeckelt', d.win.drawLog.length <= (max || 500),
    `${d.win.drawLog.length} Eintraege, erlaubt ${max}`);

  const gespeichert = JSON.parse(d.localStorage.getItem('zendomizerDrawLog') || '[]');
  check('Gespeicherter Ziehlog ebenfalls gedeckelt', gespeichert.length <= (max || 500),
    `${gespeichert.length} Eintraege im Speicher`);
}

// --- Die juengsten Eintraege bleiben erhalten -------------------------------
{
  const d = createDrawer();
  const max = d.maxDrawLog() || 500;
  ziehe(d, max + 30);
  const letzte = d.win.drawLog[d.win.drawLog.length - 1];
  check('Der neueste Eintrag steht am Ende', !!letzte && letzte.category === 'Street Tier 1',
    `letzter Eintrag: ${JSON.stringify(letzte)}`);
}

// --- Voller localStorage darf die Ziehung nicht abbrechen -------------------
{
  const d = createDrawer({ quotaBytes: 4000 }); // absichtlich winzig
  let fehler = null;
  let ergebnis = null;
  try {
    for (let i = 0; i < 200; i++) ergebnis = d.drawVehicleForCategory('Racing', NO_FILTERS, 'no_bike');
  } catch (e) {
    fehler = e;
  }
  check('Ziehung laeuft trotz voller Quota weiter', fehler === null,
    `Exception: ${fehler && fehler.name}`);
  check('Ziehung liefert weiterhin ein Fahrzeug', !!(ergebnis && ergebnis.vehicle),
    `Ergebnis: ${JSON.stringify(ergebnis)}`);
}

// --- Nach dem Aufraeumen muss die Blacklist wieder gespeichert werden -------
// Ohne sie wiederholen sich Fahrzeuge nach einem Reload - sie ist wichtiger als das Log.
{
  const d = createDrawer({ quotaBytes: 8000 });
  for (let i = 0; i < 150; i++) d.drawVehicleForCategory('Hypercar', NO_FILTERS, 'no_bike');
  const gespeichert = d.localStorage.getItem('zendomizerRecentDraws');
  const anzahl = gespeichert ? (JSON.parse(gespeichert)['Hypercar'] || []).length : 0;
  check('Blacklist ist trotz Quota-Druck gespeichert', anzahl > 0,
    `${anzahl} Eintraege im Speicher`);
}

// --- Bei endgueltigem Scheitern wird gewarnt, nicht geworfen ----------------
{
  const d = createDrawer({ quotaBytes: 50 }); // so klein, dass auch das Kuerzen nicht reicht
  let fehler = null;
  try { ziehe(d, 5, 'Racing'); } catch (e) { fehler = e; }
  check('Auch bei aussichtsloser Quota kein Absturz', fehler === null, `Exception: ${fehler && fehler.name}`);
  check('Stattdessen wird gewarnt', d.warnungen.length > 0, 'keine Warnung abgesetzt');
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} bestanden`);
process.exit(failed.length ? 1 : 0);
