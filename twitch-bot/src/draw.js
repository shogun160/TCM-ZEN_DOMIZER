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
