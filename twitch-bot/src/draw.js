/**
 * Validierung der Ziehungsdaten und Aufbau der Chat-Nachricht.
 *
 * Das Frontend schickt ausschliesslich strukturierte Felder - die Nachricht
 * selbst entsteht hier. Dadurch laesst sich ueber die API kein Freitext in
 * den Chat einschleusen.
 */

const MAX_DRAW_ITEMS = 10;

// Gesenkt von vormals 100 (alle drei Felder) auf die gemessenen Maxima in
// cars/vehicles.json plus Puffer: category 13, brand 24, model 46 Zeichen
// (Stand Sicherheitsreview 2026-08-11). Das begrenzt, wie viel
// angreifergesteuerten Text ein Nutzer pro Feld ueberhaupt unterbringen
// kann - unabhaengig von der Zeichen-Whitelist unten.
const MAX_CATEGORY_LENGTH = 24;
const MAX_BRAND_LENGTH = 40;
const MAX_MODEL_LENGTH = 64;

// ASCII-Steuerzeichen (inkl. Zeilenumbrueche, \x00-\x1F) und die
// C1-Steuerzeichen (\x7F-\x9F) sowie die Unicode-"Zeilentrenner"
// U+2028 (LINE SEPARATOR) und U+2029 (PARAGRAPH SEPARATOR). Letztere sind
// KEINE ASCII-Steuerzeichen und wuerden von einer reinen \x00-\x1F-
// Pruefung nicht erfasst - in einem Chat-Client koennen sie trotzdem wie
// ein Zeilenumbruch wirken. Sie werden wie ein Zeilenumbruch durch ein
// Leerzeichen ersetzt.
const LINE_BREAK_CHARS = /[\x00-\x1F\x7F-\x9F\u2028\u2029]/g;

// Unsichtbare/formatierende Zeichen wie Zero-Width Space/Joiner/Non-Joiner
// (U+200B-U+200D), LTR-/RTL-Marker (U+200E/U+200F), Bidi-Embedding/-Override
// (U+202A-U+202E), Word Joiner (U+2060), Bidi-Isolates (U+2066-U+2069) sowie
// das Zero-Width No-Break Space / BOM (U+FEFF) brauchen HIER keine eigene
// Regel mehr: keines davon ist ein Unicode-Buchstabe (\p{L}), eine Ziffer
// (\p{N}) oder eines der unten erlaubten Satzzeichen - DISALLOWED_CHARS
// entfernt sie also automatisch mit. Ein frueherer eigener INVISIBLE_CHARS-
// Schritt wurde deshalb entfernt (reine Code-Duplikation zur Whitelist).
// LINE_BREAK_CHARS bleibt dagegen bestehen: Zeilenumbrueche muessen durch
// ein Leerzeichen ERSETZT werden (Wortgrenze erhalten), waehrend die
// Whitelist unten nur entfernt, nie ersetzt - "Pfister\nComet" wuerde ohne
// diesen Schritt zu "PfisterComet" statt "Pfister Comet" verschmelzen.

// Zeichen-Whitelist (Befund A, Sicherheitsreview 2026-08-11): erlaubt sind
// Unicode-Buchstaben (\p{L}, deckt automatisch z.B. \u00E9/\u00EB/\u00F6/\u03B2 ab) und
// -Ziffern (\p{N}) per Property-Escape, dazu genau die Satzzeichen, die in
// den 748 echten Eintraegen aus cars/vehicles.json tatsaechlich vorkommen:
// Leerzeichen, NBSP (U+00A0), Bindestrich, Punkt, runde Klammern, \u00AE (U+00AE),
// Schraegstrich, Plus, gerades und typografisches Apostroph ('/U+2019),
// Anfuehrungszeichen, Gedankenstrich (U+2013) und Doppelpunkt. Alles andere
// wird entfernt (nicht abgelehnt) - siehe Begruendung "Entfernen statt
// Ablehnen" im Sicherheitsreview: kommt kuenftig durch Datenpflege ein neues
// Sonderzeichen in vehicles.json hinzu, degradiert das nur den einen
// betroffenen Namen minimal, statt jede Ziehung mit diesem Fahrzeug per
// harter Ablehnung komplett lahmzulegen.
//
// Wichtig: ":" "/" und "." sind einzeln erlaubt (sie kommen legitim vor,
// z.B. in "917K" nicht, aber als Trenner in anderen Datensaetzen) - erst
// die KOMBINATION zu einem URL-Muster wird unten separat per
// looksLikeUrlPattern() abgelehnt, nicht schon hier durch die Whitelist.
const DISALLOWED_CHARS = /[^\p{L}\p{N} \u00A0\-.()\u00AE/+'\u2019"\u2013:]/gu;

// URL-Erkennung (Befund A): anders als bei der Zeichen-Whitelist ist
// Ablehnen hier bewusst richtig - ein Linkversuch ist kein
// Datenpflege-Unfall, sondern ein klarer Missbrauchsversuch. Deckt ab:
// "://" (Schema-Trenner, z.B. "https://"), "www." sowie eine Punkt-TLD-
// Kombination aus einer kleinen, haendisch gepflegten Liste. Alles
// case-insensitiv, da Twitch-Chat-Clients Links unabhaengig von
// Gross-/Kleinschreibung erkennen. Bewusst NICHT verfolgt (siehe
// Sicherheitsreview): Tricks wie eingestreute Leerzeichen ("https : //"),
// Vollbreiten-Punkt U+FF0E oder Umlaut-Domains via Punycode - die
// Zeichen-Whitelist oben entfernt U+FF0E ohnehin schon (kein \p{L}/\p{N}
// und nicht in der erlaubten Satzzeichenliste), und die verbleibenden
// Luecken waeren nur mit einem vollstaendigen URL-Parser zuverlaessig zu
// schliessen - das steht ausser Verhaeltnis zum Rest dieser Haertung.
const URL_TLD_PATTERN = /\.(?:com|net|org|tv|gg|io|de|shop|link|xyz)(?![\p{L}\p{N}])/u;

function looksLikeUrlPattern(text) {
  const lower = text.toLowerCase();
  return lower.includes("://") || lower.includes("www.") || URL_TLD_PATTERN.test(lower);
}

function cleanField(value, maxLength) {
  if (typeof value === "number") value = String(value);
  if (typeof value !== "string") return "";
  return value
    .replace(LINE_BREAK_CHARS, " ")
    .replace(DISALLOWED_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function validateDraw(draw) {
  if (!Array.isArray(draw) || draw.length === 0) {
    return { ok: false, error: "Feld 'draw' fehlt oder ist leer." };
  }
  if (draw.length > MAX_DRAW_ITEMS) {
    return { ok: false, error: `Feld 'draw' hat mehr als ${MAX_DRAW_ITEMS} Eintraege.` };
  }

  const items = [];
  for (const roh of draw) {
    if (!roh || typeof roh !== "object") {
      return { ok: false, error: "Ungueltiger Eintrag in 'draw'." };
    }

    // Feldgrenzen (24/40/64) werden NACH dem Bereinigen angewandt, nicht
    // vorher: cleanField() entfernt Steuerzeichen/unsichtbare Zeichen/
    // Whitelist-Verstoesse zuerst und kuerzt erst danach. So begrenzt das
    // Limit tatsaechlich sichtbaren Inhalt, statt Zeichen zu "verschwenden",
    // die ohnehin gleich wieder entfernt wuerden (ein Angreifer koennte
    // sonst durch Vorschalten von 24+ Muell-Zeichen den halben Feldinhalt
    // vor dem Schnitt "verstecken").
    const category = cleanField(roh.category, MAX_CATEGORY_LENGTH);
    const brand = cleanField(roh.brand, MAX_BRAND_LENGTH);
    const model = cleanField(roh.model, MAX_MODEL_LENGTH);
    if (!category || !brand || !model) {
      // Deckt auch den Fall ab, dass ein Feld ausschliesslich aus Zeichen
      // besteht, die die Whitelist entfernt (z.B. "###$$$%%%") - cleanField()
      // liefert dann "", und genau diese bereits bestehende Nicht-leer-
      // Pruefung greift unveraendert.
      return { ok: false, error: "'category', 'brand' und 'model' muessen nicht-leer sein." };
    }
    if (looksLikeUrlPattern(category) || looksLikeUrlPattern(brand) || looksLikeUrlPattern(model)) {
      return { ok: false, error: "'category', 'brand' und 'model' duerfen kein Link-Muster enthalten." };
    }

    let year = null;
    if (roh.year !== undefined && roh.year !== null && roh.year !== "") {
      const zahl = Number(roh.year);
      if (!Number.isInteger(zahl) || zahl < 1900 || zahl > 2100) {
        return { ok: false, error: "'year' muss eine Jahreszahl zwischen 1900 und 2100 sein." };
      }
      year = zahl;
    }

    items.push({ category, brand, model, year });
  }

  return { ok: true, items };
}

const TWITCH_MAX_MESSAGE_LENGTH = 500;
const ELLIPSIS = "\u2026";

// Feste Bestaetigungsnachricht fuer den "Verbindung testen"-Knopf im
// Frontend (type: "connected" in /announce). Sie lebt bewusst hier, direkt
// neben dem Ziehungs-Nachrichtentext von buildMessage() - beides sind feste,
// vom Worker kontrollierte Chat-Texte, ueber die kein Freitext eingeschleust
// werden kann. Der Apostroph ist absichtlich ein normales ASCII-Apostroph.
const CONNECTED_MESSAGE = "\u{1F3B2} ZENdomizer connected. Let's race. \u{1F3C1}";

function formatVehicleName(v) {
  return v.year ? `${v.brand} ${v.model} (${v.year})` : `${v.brand} ${v.model}`;
}

// slice() arbeitet auf UTF-16-Code-Units. Liegt der Schnitt mitten in einem
// Surrogatpaar (z.B. bei Emoji ausserhalb der BMP), entsteht sonst eine
// verwaiste (lone) Surrogat-Codeeinheit im Ergebnis. Deshalb wird die
// Schnittstelle um eine Position nach vorne verschoben, wenn das letzte
// eingeschlossene Zeichen ein High-Surrogate ist. Gilt fuer jede an Twitch
// gesendete Nachricht einheitlich - auch fuer die kurze Bestaetigungs-
// nachricht, auch wenn sie das Limit in der Praxis nie erreicht.
function truncateForTwitch(nachricht) {
  if (nachricht.length <= TWITCH_MAX_MESSAGE_LENGTH) return nachricht;

  let cutIndex = TWITCH_MAX_MESSAGE_LENGTH - 1;
  const letzteCodeUnit = nachricht.charCodeAt(cutIndex - 1);
  if (letzteCodeUnit >= 0xD800 && letzteCodeUnit <= 0xDBFF) cutIndex -= 1;

  return nachricht.slice(0, cutIndex) + ELLIPSIS;
}

// Einzeilig mit " | " als Trenner. Mehrzeilig wurde am 2026-08-11 live
// getestet und von Twitch NICHT unterstuetzt: Die Chat-API nimmt "\n"
// innerhalb einer Nachricht nicht an (der Chat ist historisch IRC-basiert,
// wo "\n" Nachrichten voneinander trennt). Auch Shift+Enter im Web-Client
// wirkt nur bis zum Absenden. Bitte nicht erneut auf "\n" umstellen.
const ITEM_SEPARATOR = " | ";

// Gefuellte Kreiszahlen U+278A (➊) bis U+2793 (➓) als Nummerierung vor jeder
// Kategorie. Der Bereich deckt genau MAX_DRAW_ITEMS ab, es kann also keine
// Nummer fehlen. Ein Zeichen je Ziffer - bewusst gewaehlt, weil Keycap-Emojis
// (Ziffer + Variantenselektor + Umschliessungszeichen) drei Zeichen des
// 500er-Limits kosten wuerden.
const FIRST_ITEM_NUMBER_CODEPOINT = 0x278a;

function itemNumber(index) {
  if (index >= MAX_DRAW_ITEMS) return "";
  return String.fromCodePoint(FIRST_ITEM_NUMBER_CODEPOINT + index);
}

// Grand-Race-Modifikatoren. Der Client schickt ausschliesslich den Schluessel,
// Text und Icon bestimmt der Worker - Freitext wird hier grundsaetzlich nicht
// angenommen (dieselbe Linie wie bei buildConnectedMessage).
//
// Ein unbekannter Schluessel wird still ignoriert statt mit 400 abgelehnt: bringt
// eine neue Season einen neuen Modifikator, soll die Ziehung trotzdem im Chat
// landen - nur eben ohne Zusatz. Neue Modifikatoren gehoeren hier UND in
// TWITCH_MODIFIER_KEYS in zendomizer.html ergaenzt; tests/twitch-modifier.test.mjs
// im Hauptprojekt prueft, dass beide Listen zueinander passen.
const MODIFIERS = new Map([
  ["no_collision", { label: "No Collision", icon: "\u{1F47B}" }],
  ["special_selection", { label: "Special Selection", icon: "⭐" }],
  ["pro_racing", { label: "Pro Racing", icon: "\u{1F3CE}️" }],
  ["air_only", { label: "Air Only", icon: "\u{1F6E9}️" }],
  ["special_weather", { label: "Special Weather", icon: "\u{1F327}️" }],
]);

export function resolveModifier(key) {
  if (typeof key !== "string") return null;
  return MODIFIERS.get(key) || null;
}

// Aktive Filter, sofern sie vom Standard abweichen. Fahrzeugtyp und Aera haben
// feste Wertebereiche und kommen deshalb als Schluessel - wie der Modifikator.
const FILTER_VEHICLE_TYPES = new Map([
  ["bike", "Bikes only"],
  ["all", "All vehicles"],
  ["top_tier", "Top Tier"],
  ["rc_cars", "RC Cars"],
]);
const FILTER_ERAS = new Map([
  ["classic", "Classic"],
  ["modern", "Modern"],
]);

// Marke und Land lassen sich nicht als Schluessel abbilden - sie stammen aus
// cars/vehicles.json und aendern sich mit der Datenpflege. Sie laufen deshalb
// durch dieselbe Bereinigung wie die Fahrzeugfelder, mit eigenem Laengenlimit.
const MAX_FILTER_LENGTH = 40;

// cars/vehicles.json fuehrt dieselben Laender in zwei Schreibweisen ("germany"
// und "Germany"). Damit im Chat nicht mal so und mal so steht, wird der erste
// Buchstabe grossgezogen - Akronyme wie USA/UAE bleiben unangetastet.
function normalizeCountry(text) {
  if (text === text.toUpperCase()) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function validateFilters(filters) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
    return { ok: true, teile: [] };
  }

  const teile = [];

  const typ = FILTER_VEHICLE_TYPES.get(filters.vehicleType);
  if (typ) teile.push(typ);

  for (const feld of ["brand", "country"]) {
    const wert = cleanField(filters[feld], MAX_FILTER_LENGTH);
    if (!wert) continue;
    // Ablehnen statt entfernen, genau wie bei den Fahrzeugfeldern: ein
    // Linkversuch im Filterfeld ist kein Datenpflege-Unfall.
    if (looksLikeUrlPattern(wert)) {
      return { ok: false, error: `Filter '${feld}' darf kein Link-Muster enthalten.` };
    }
    teile.push(feld === "country" ? normalizeCountry(wert) : wert);
  }

  const era = FILTER_ERAS.get(filters.era);
  if (era) teile.push(era);

  return { ok: true, teile };
}

const FILTER_SEPARATOR = " · ";

export function buildMessage(items, modifierKey = null, filterTeile = null) {
  if (!Array.isArray(items) || items.length === 0) return "";

  const teile = items.map((v, i) => {
    const nummer = itemNumber(i);
    const prefix = nummer ? `${nummer} ` : "";
    return `${prefix}${v.category}: ${formatVehicleName(v)}`;
  });

  // Modifikator und Filter stehen VOR den Fahrzeugen: die Kuerzung auf 500 Zeichen
  // greift am Ende, hinten haette sie eine lange Ziehung verschluckt.
  const modifier = resolveModifier(modifierKey);
  const modifierTeil = modifier ? ` - ${modifier.label} ${modifier.icon}` : "";
  const filterTeil = Array.isArray(filterTeile) && filterTeile.length
    ? ` [${filterTeile.join(FILTER_SEPARATOR)}]`
    : "";
  const nachricht = `\u{1F3B2} ZENdomizer${modifierTeil}${filterTeil}: ${teile.join(ITEM_SEPARATOR)}`;

  return truncateForTwitch(nachricht);
}

export function buildConnectedMessage() {
  return truncateForTwitch(CONNECTED_MESSAGE);
}
