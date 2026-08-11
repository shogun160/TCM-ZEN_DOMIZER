import { describe, it, expect } from "vitest";
import { validateDraw, buildMessage } from "../src/draw.js";
import echteFahrzeuge from "../../cars/vehicles.json";

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
    // Bewusst kein "example.com" mehr im Testwert (frueher hier verwendet):
    // Domain-artige Substrings werden jetzt ueber die URL-Erkennung
    // abgelehnt (siehe describe("URL-Erkennung") unten) - dieser Test soll
    // ausschliesslich das Entfernen von Zeilenumbruechen pruefen.
    const ergebnis = validateDraw([
      { category: "Hypercar", brand: "Pfister\nSonderedition", model: "Comet" },
    ]);
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.items[0].brand).not.toMatch(/[\n\r]/);
    expect(ergebnis.items[0].model).toBe("Comet");
  });

  it("kuerzt ueberlange Felder auf die neuen, gesenkten Feldgrenzen (24/40/64)", () => {
    const ergebnis = validateDraw([
      { category: "K".repeat(500), brand: "B".repeat(500), model: "M".repeat(500) },
    ]);
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.items[0].category).toHaveLength(24);
    expect(ergebnis.items[0].brand).toHaveLength(40);
    expect(ergebnis.items[0].model).toHaveLength(64);
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

// --- Befund A (Sicherheitsreview): Zeichen-Whitelist + URL-Ablehnung ---
describe("validateDraw: Zeichen-Whitelist", () => {
  it("entfernt Zeichen ausserhalb der Whitelist (statt das Feld abzulehnen)", () => {
    const ergebnis = validateDraw([
      { category: "Hypercar", brand: "Pfi$ster!!", model: "Com<et>#tag" },
    ]);
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.items[0].brand).toBe("Pfister");
    expect(ergebnis.items[0].model).toBe("Comettag");
  });

  it("behaelt Unicode-Buchstaben ausserhalb ASCII (e.g. é, ë, ö, β)", () => {
    const ergebnis = validateDraw([
      { category: "Hypercar", brand: "Bugéëötti β", model: "Comet" },
    ]);
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.items[0].brand).toBe("Bugéëötti β");
  });

  it("behaelt die real in vehicles.json vorkommenden Sonderzeichen (- . ( ) ® / + ' \u2019 \" \u2013 :)", () => {
    // Auf mehrere Felder verteilt, damit jedes Feld innerhalb seiner neuen,
    // gesenkten Laengengrenze (24/40/64) bleibt und die Kuerzung diese
    // Whitelist-Erhaltungs-Assertion nicht verfaelscht.
    const ergebnis = validateDraw([
      {
        category: "A-B.C(D)E®",
        brand: "O'Brien's \u2019Cars\"\u2013:",
        model: "X/Y+Z\u00A0Model",
      },
    ]);
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.items[0].category).toBe("A-B.C(D)E®");
    expect(ergebnis.items[0].brand).toBe("O'Brien's \u2019Cars\"\u2013:");
    // NBSP (U+00A0, 2x in vehicles.json gemessen) ist Teil der Whitelist
    // (siehe DISALLOWED_CHARS in src/draw.js), UEBERLEBT als Zeichen aber
    // nicht bis zum Ergebnis: der bereits bestehende, unveraenderte
    // Kollaps-Schritt .replace(/\s+/g, " ") normalisiert NBSP (das in JS zu
    // \s zaehlt) auf ein gewoehnliches Leerzeichen. Das ist keine Regression
    // dieser Haertung, sondern vorbestehendes Verhalten - hier bewusst
    // mitgeprueft, damit es nicht spaeter als Bug missverstanden wird.
    expect(ergebnis.items[0].model).toBe("X/Y+Z Model");
  });

  it("lehnt ein Feld ab, das nach dem Entfernen unerlaubter Zeichen leer ist", () => {
    const ergebnis = validateDraw([
      { category: "Hypercar", brand: "###$$$%%%", model: "Comet" },
    ]);
    expect(ergebnis.ok).toBe(false);
  });
});

describe("validateDraw: URL-Muster werden abgelehnt (Befund A)", () => {
  it("lehnt '://' in beliebiger Gross-/Kleinschreibung ab", () => {
    expect(validateDraw([{ category: "X", brand: "Y", model: "https://boese-seite.example" }]).ok).toBe(false);
    expect(validateDraw([{ category: "X", brand: "Y", model: "HTTP://BOESE-SEITE.EXAMPLE" }]).ok).toBe(false);
    expect(validateDraw([{ category: "X", brand: "Y://evil", model: "Z" }]).ok).toBe(false);
  });

  it("lehnt 'www.' ab", () => {
    expect(validateDraw([{ category: "X", brand: "www.boese-seite.example", model: "Z" }]).ok).toBe(false);
    expect(validateDraw([{ category: "X", brand: "WWW.BOESE-SEITE.EXAMPLE", model: "Z" }]).ok).toBe(false);
  });

  it("lehnt eine Punkt-TLD-Kombination ab (.com .net .org .tv .gg .io .de .shop .link .xyz)", () => {
    for (const tld of ["com", "net", "org", "tv", "gg", "io", "de", "shop", "link", "xyz"]) {
      const ergebnis = validateDraw([{ category: "X", brand: "Y", model: `boeseseite.${tld}` }]);
      expect(ergebnis.ok, `TLD .${tld} haette abgelehnt werden muessen`).toBe(false);
    }
  });

  it("lehnt eine TLD-Kombination unabhaengig von Gross-/Kleinschreibung ab", () => {
    expect(validateDraw([{ category: "X", brand: "Y", model: "boeseseite.COM" }]).ok).toBe(false);
  });

  it("erkennt eine TLD-Kombination auch mitten im Feld, nicht nur am Ende", () => {
    expect(validateDraw([{ category: "X", brand: "Y", model: "besucht boeseseite.com jetzt" }]).ok).toBe(false);
  });
});

// Wichtigster Test dieses Tasks: verhindert, dass die Haertung echte
// Fahrzeugdaten trifft. Prueft ALLE 748 Eintraege aus cars/vehicles.json
// plus das in zendomizer.html fest codierte Jet-Bonusfahrzeug.
describe("validateDraw: alle echten Fahrzeuge aus cars/vehicles.json bleiben gueltig", () => {
  const JET_BONUS_VEHICLE = {
    category: "Jet",
    brand: "Dassault Aviation",
    model: "Alpha Jet \u2013 Red Bull Edition",
  };
  const alleFahrzeuge = [...echteFahrzeuge, JET_BONUS_VEHICLE];

  it(`akzeptiert alle ${alleFahrzeuge.length} echten Fahrzeuge (${echteFahrzeuge.length} aus vehicles.json + Jet-Bonusfahrzeug)`, () => {
    // Bewusst nur ok:true geprueft, kein Byte-fuer-Byte-Vergleich: einzelne
    // Eintraege in vehicles.json haben schon vor dieser Haertung fuehrende/
    // folgende Leerzeichen (Datenpflege-Artefakt, z.B. "Cooper S "), die das
    // bereits bestehende .trim() in cleanField() entfernt - das ist
    // unveraendertes Altverhalten und nicht Gegenstand dieses Befunds.
    const fehlgeschlagen = [];
    for (const fahrzeug of alleFahrzeuge) {
      const ergebnis = validateDraw([
        { category: fahrzeug.category, brand: fahrzeug.brand, model: fahrzeug.model, year: fahrzeug.year },
      ]);
      if (!ergebnis.ok) {
        fehlgeschlagen.push({ fahrzeug, error: ergebnis.error });
      }
    }
    expect(fehlgeschlagen, JSON.stringify(fehlgeschlagen, null, 2)).toEqual([]);
  });
});

describe("buildMessage", () => {
  it("baut eine einzeilige Nachricht mit ' | ' als Trenner", () => {
    const nachricht = buildMessage([
      { category: "Hypercar", brand: "Pfister", model: "Comet", year: 2021 },
      { category: "Drift", brand: "Nissan", model: "Silvia", year: null },
    ]);
    expect(nachricht).toBe(
      "\uD83C\uDFB2 ZENdomizer: \u278A Hypercar: Pfister Comet (2021) | \u278B Drift: Nissan Silvia"
    );
  });

  // Twitch nimmt mehrzeilige Chat-Nachrichten nicht an (am 2026-08-11 live
  // geprueft). Dieser Test haelt das fest, damit die Nachricht nicht erneut
  // auf Zeilenumbrueche umgestellt wird.
  it("enthaelt keine Zeilenumbrueche", () => {
    const nachricht = buildMessage([
      { category: "Hypercar", brand: "Pfister", model: "Comet", year: 2021 },
      { category: "Drift", brand: "Nissan", model: "Silvia", year: null },
    ]);
    expect(nachricht).not.toMatch(/[\r\n]/);
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

// ---------------------------------------------------------------------------
// Grand-Race-Modifikator. Der Client schickt nur einen Schluessel, Text und Icon
// setzt der Worker - ueber die Twitch-Schnittstelle laeuft weiterhin kein Freitext.
// ---------------------------------------------------------------------------
describe("buildMessage: Grand-Race-Modifikator", () => {
  const ziehung = [{ category: "AGP", brand: "Ivory-Tower", model: "IVT AGP R-07", year: 2023 }];

  it("stellt den Modifikator mit Icon vor die Fahrzeuge", () => {
    const nachricht = buildMessage(ziehung, "no_collision");
    expect(nachricht).toBe("\u{1F3B2} ZENdomizer - No Collision \u{1F47B}: ➊ AGP: Ivory-Tower IVT AGP R-07 (2023)");
  });

  it("kennt alle fuenf Modifikatoren der Rotation", () => {
    const erwartet = {
      no_collision: "No Collision \u{1F47B}",
      special_selection: "Special Selection ⭐",
      pro_racing: "Pro Racing \u{1F3CE}️",
      air_only: "Air Only \u{1F6E9}️",
      special_weather: "Special Weather \u{1F327}️",
    };
    for (const [key, text] of Object.entries(erwartet)) {
      expect(buildMessage(ziehung, key)).toContain(` - ${text}: `);
    }
  });

  it("baut die Nachricht ohne Modifikator unveraendert", () => {
    expect(buildMessage(ziehung)).toBe("\u{1F3B2} ZENdomizer: ➊ AGP: Ivory-Tower IVT AGP R-07 (2023)");
    expect(buildMessage(ziehung, null)).toBe(buildMessage(ziehung));
  });

  it("ignoriert unbekannte Schluessel still, statt die Ziehung zu verlieren", () => {
    // Bringt eine neue Season einen neuen Modifikator, soll die Ziehung trotzdem
    // im Chat landen - nur eben ohne Zusatz.
    expect(buildMessage(ziehung, "hovercraft_only")).toBe(buildMessage(ziehung));
  });

  it("nimmt keinen Freitext als Modifikator an", () => {
    expect(buildMessage(ziehung, "Besucht meinen Kanal!")).toBe(buildMessage(ziehung));
    expect(buildMessage(ziehung, { label: "boese" })).toBe(buildMessage(ziehung));
    expect(buildMessage(ziehung, 42)).toBe(buildMessage(ziehung));
  });

  it("behaelt den Modifikator auch bei einer Ziehung an der 500-Zeichen-Grenze", () => {
    // Genau deshalb steht er vorne: gekuerzt wird am Ende.
    const viele = Array.from({ length: 10 }, (_, i) => ({
      category: "Street Tier 2",
      brand: "Sehr Langer Herstellername",
      model: `Modell mit reichlich Text Nummer ${i}`,
      year: 2020 + i,
    }));
    const nachricht = buildMessage(viele, "special_weather");
    expect(nachricht.length).toBeLessThanOrEqual(500);
    expect(nachricht.startsWith("\u{1F3B2} ZENdomizer - Special Weather \u{1F327}️: ")).toBe(true);
  });
});
