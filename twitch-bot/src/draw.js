/**
 * Validierung der Ziehungsdaten und Aufbau der Chat-Nachricht.
 *
 * Das Frontend schickt ausschliesslich strukturierte Felder - die Nachricht
 * selbst entsteht hier. Dadurch laesst sich ueber die API kein Freitext in
 * den Chat einschleusen.
 */

const MAX_DRAW_ITEMS = 10;
const MAX_FIELD_LENGTH = 100;

// ASCII-Steuerzeichen (inkl. Zeilenumbrueche, \x00-\x1F) und die
// C1-Steuerzeichen (\x7F-\x9F) sowie die Unicode-"Zeilentrenner"
// U+2028 (LINE SEPARATOR) und U+2029 (PARAGRAPH SEPARATOR). Letztere sind
// KEINE ASCII-Steuerzeichen und wuerden von einer reinen \x00-\x1F-
// Pruefung nicht erfasst - in einem Chat-Client koennen sie trotzdem wie
// ein Zeilenumbruch wirken. Sie werden wie ein Zeilenumbruch durch ein
// Leerzeichen ersetzt.
const LINE_BREAK_CHARS = /[\x00-\x1F\x7F-\x9F\u2028\u2029]/g;

// Unsichtbare/formatierende Zeichen, die keinen sichtbaren Zeilenumbruch
// erzeugen, aber zur Verschleierung genutzt werden koennen: Zero-Width
// Space/Joiner/Non-Joiner (U+200B-U+200D), LTR-/RTL-Marker (U+200E/U+200F),
// Bidi-Embedding/-Override (U+202A-U+202E), Word Joiner (U+2060),
// Bidi-Isolates (U+2066-U+2069) sowie das Zero-Width No-Break Space / BOM
// (U+FEFF). Ein RTL-Override kann z.B. einen Markennamen spiegeln oder
// einen boesartigen Linkteil unsichtbar machen. Diese Zeichen werden
// vollstaendig entfernt statt durch ein Leerzeichen ersetzt, da sie fuer
// sich genommen keine Wortgrenze darstellen.
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

function cleanField(value) {
  if (typeof value === "number") value = String(value);
  if (typeof value !== "string") return "";
  return value
    .replace(LINE_BREAK_CHARS, " ")
    .replace(INVISIBLE_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FIELD_LENGTH);
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

    const category = cleanField(roh.category);
    const brand = cleanField(roh.brand);
    const model = cleanField(roh.model);
    if (!category || !brand || !model) {
      return { ok: false, error: "'category', 'brand' und 'model' muessen nicht-leer sein." };
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

export function buildMessage(items) {
  if (!Array.isArray(items) || items.length === 0) return "";

  const teile = items.map(v => `${v.category}: ${formatVehicleName(v)}`);
  const nachricht = `\u{1F3B2} ZENdomizer: ${teile.join(ITEM_SEPARATOR)}`;

  return truncateForTwitch(nachricht);
}

export function buildConnectedMessage() {
  return truncateForTwitch(CONNECTED_MESSAGE);
}
