import { describe, it, expect } from "vitest";
import { validateDraw, buildMessage } from "../src/draw.js";

describe("validateDraw", () => {
  const gueltig = [{ category: "Hypercar", brand: "Pfister", model: "Comet", year: 2021 }];

  it("akzeptiert einen gueltigen Eintrag", () => {
    const ergebnis = validateDraw(gueltig);
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.items).toEqual([
      { category: "Hypercar", brand: "Pfister", model: "Comet", year: 2021 },
    ]);
  });

  it("akzeptiert numerische Modellnamen (z.B. Abarth 500)", () => {
    const ergebnis = validateDraw([{ category: "Street Tier 2", brand: "Abarth", model: 500, year: 1930 }]);
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.items[0].model).toBe("500");
  });

  it("akzeptiert Eintraege ohne Jahr", () => {
    const ergebnis = validateDraw([{ category: "Drift", brand: "Nissan", model: "Silvia" }]);
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.items[0].year).toBeNull();
  });

  it("lehnt Nicht-Arrays und leere Listen ab", () => {
    expect(validateDraw(undefined).ok).toBe(false);
    expect(validateDraw("Hypercar: Comet").ok).toBe(false);
    expect(validateDraw([]).ok).toBe(false);
  });

  it("lehnt mehr als zehn Eintraege ab", () => {
    expect(validateDraw(Array.from({ length: 11 }, () => gueltig[0])).ok).toBe(false);
  });

  it("lehnt fehlende Pflichtfelder ab", () => {
    expect(validateDraw([{ category: "Hypercar", brand: "Pfister" }]).ok).toBe(false);
    expect(validateDraw([{ category: "", brand: "Pfister", model: "Comet" }]).ok).toBe(false);
  });

  it("entfernt Zeilenumbrueche und Steuerzeichen", () => {
    const ergebnis = validateDraw([
      { category: "Hypercar", brand: "Pfister\nBesuch example.com", model: "Comet" },
    ]);
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.items[0].brand).not.toMatch(/[\n\r]/);
    expect(ergebnis.items[0].model).toBe("Comet");
  });

  it("kuerzt ueberlange Felder auf 100 Zeichen", () => {
    const ergebnis = validateDraw([
      { category: "Hypercar", brand: "A".repeat(500), model: "Comet" },
    ]);
    expect(ergebnis.items[0].brand).toHaveLength(100);
  });

  it("lehnt unsinnige Jahreszahlen ab", () => {
    expect(validateDraw([{ category: "X", brand: "Y", model: "Z", year: 12345 }]).ok).toBe(false);
    expect(validateDraw([{ category: "X", brand: "Y", model: "Z", year: "neulich" }]).ok).toBe(false);
  });

  // --- Eigene Ergaenzungen: Selbstpruefung laut Auftrag ---
  // Unicode-Zeilentrenner (U+2028/U+2029), Zero-Width-Zeichen und
  // Bidi-Steuerzeichen (RTL-Override/-Isolate) sind KEINE ASCII-Steuerzeichen
  // (\n \r \t etc.) und muessen deshalb explizit behandelt werden. Alle
  // Zeichen stehen hier bewusst als \uXXXX-Escapes im Quelltext statt als
  // unsichtbare Literalzeichen, damit der Testcode selbst lesbar bleibt.
  it("entfernt Unicode-Zeilentrenner (U+2028/U+2029), Zero-Width- und Bidi-Steuerzeichen", () => {
    const ergebnis = validateDraw([
      {
        category: "Hypercar",
        // U+200B ZERO WIDTH SPACE, U+202E RIGHT-TO-LEFT OVERRIDE,
        // U+2066 LEFT-TO-RIGHT ISOLATE, U+2069 POP DIRECTIONAL ISOLATE
        brand: "Pfi\u200Bster\u202Eevil\u2066x\u2069",
        // U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR
        model: "Comet\u2028Zeile\u2029Zwei",
      },
    ]);
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.items[0].brand).not.toMatch(/[\u200B\u202E\u2066\u2069]/);
    expect(ergebnis.items[0].model).not.toMatch(/[\u2028\u2029]/);
  });
});

describe("buildMessage", () => {
  it("baut das bisherige Frontend-Format nach", () => {
    const nachricht = buildMessage([
      { category: "Hypercar", brand: "Pfister", model: "Comet", year: 2021 },
      { category: "Drift", brand: "Nissan", model: "Silvia", year: null },
    ]);
    expect(nachricht).toBe("\uD83C\uDFB2 ZENdomizer: Hypercar: Pfister Comet (2021) | Drift: Nissan Silvia");
  });

  it("kuerzt auf das Twitch-Limit von 500 Zeichen", () => {
    const viele = Array.from({ length: 10 }, () => ({
      category: "K".repeat(100), brand: "B".repeat(100), model: "M".repeat(100), year: 2020,
    }));
    const nachricht = buildMessage(viele);
    expect(nachricht.length).toBeLessThanOrEqual(500);
    expect(nachricht.endsWith("\u2026")).toBe(true);
  });

  // --- Eigene Ergaenzungen: Selbstpruefung laut Auftrag ---
  it("gibt bei leerem Array einen leeren String zurueck, statt eine leere Ankuendigung zu posten", () => {
    expect(buildMessage([])).toBe("");
  });

  it("zerschneidet beim Kuerzen kein Surrogatpaar (Emoji ausserhalb der BMP)", () => {
    // "K".repeat(483) + Auto-Emoji als category sorgt dafuer, dass die
    // Kuerzgrenze (Index 499) exakt zwischen die zwei Code-Units des
    // Emoji-Surrogatpaars faellt, wenn naiv per slice() geschnitten wird.
    const items = [{ category: "K".repeat(483) + "\uD83D\uDE97", brand: "B", model: "M", year: null }];
    const nachricht = buildMessage(items);
    expect(nachricht.length).toBeLessThanOrEqual(500);
    expect(nachricht.endsWith("\u2026")).toBe(true);
    // Keine einsame (verwaiste) Surrogat-Codeeinheit im Ergebnis.
    expect(nachricht).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(nachricht).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
