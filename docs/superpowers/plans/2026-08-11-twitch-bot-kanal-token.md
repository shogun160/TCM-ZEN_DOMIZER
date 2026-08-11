# Kanal-Token für den Twitch-Bot — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Worker postet ausschließlich in den Kanal, der zum mitgeschickten Kanal-Token gehört, und baut die Chat-Nachricht selbst aus strukturierten Ziehungsdaten.

**Architecture:** Der monolithische `worker.js` wird in fokussierte Module unter `twitch-bot/src/` zerlegt (Tokens, Draw-Validierung, Twitch-API, Auth-Routen). `worker.js` bleibt als schlanker Router zurück. Der Streamer holt sich seinen Token per Twitch-OAuth mit leerem Scope über zwei neue Routen; der Token liegt nur als SHA-256-Hash im KV.

**Tech Stack:** Cloudflare Workers (ES-Module), KV, Web Crypto API, Vitest mit `@cloudflare/vitest-pool-workers` (Miniflare-Runtime, `fetchMock` für Twitch-API).

**Spec:** `docs/superpowers/specs/2026-08-11-twitch-bot-kanal-token-design.md`

---

## Abweichung von der Spec (bewusst)

Die Spec sah Verifikation nur per `curl` vor, weil das Repo kein Testframework hat. Dieser Plan führt stattdessen **Vitest mit `@cloudflare/vitest-pool-workers`** ein (Task 1). Grund: Es geht um Autorisierungslogik — dort ist eine wiederholbare Testsuite die Investition wert, und die sieben Verifikationsschritte der Spec lassen sich als automatisierte Tests ausdrücken statt als manuelle Runde. Die Live-Verifikation gegen den echten Worker bleibt zusätzlich erhalten (Task 13).

`package.json` und `node_modules/` liegen ausschließlich unter `twitch-bot/` und berühren die per GitHub Pages ausgelieferte Static Site nicht. `node_modules/` ist bereits in `.gitignore`.

**Wichtig für alle Tasks:** Die Tests laufen in Miniflare gegen einen **lokalen** KV-Store. Trotz echter Namespace-ID in `wrangler.toml` wird dabei nichts in Produktion geschrieben.

---

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `twitch-bot/package.json` | NEU — Dev-Dependencies und `npm test` |
| `twitch-bot/vitest.config.js` | NEU — Vitest an die Workers-Runtime binden |
| `twitch-bot/src/tokens.js` | NEU — Token erzeugen/hashen, KV-Zugriff für Token und State |
| `twitch-bot/src/draw.js` | NEU — `draw` validieren, Chat-Nachricht bauen |
| `twitch-bot/src/twitch.js` | NEU — Twitch-API-Aufrufe (aus `worker.js` verschoben) |
| `twitch-bot/src/auth.js` | NEU — `/auth/start` und `/auth/callback` |
| `twitch-bot/worker.js` | ÄNDERN — nur noch Routing plus `/announce` |
| `twitch-bot/test/*.test.js` | NEU — Tests je Modul |
| `zendomizer.html` | ÄNDERN — Token statt Kanalname, `draw` statt `message` |
| `translations/i18n.json` | ÄNDERN — neue Bedien- und Fehlertexte |
| `twitch-bot/README.md` | ÄNDERN — neuer Ablauf für Betreiber und Streamer |

---

## Task 1: Test-Infrastruktur

**Files:**
- Create: `twitch-bot/package.json`
- Create: `twitch-bot/vitest.config.js`
- Create: `twitch-bot/test/smoke.test.js`

- [ ] **Step 1: `package.json` anlegen**

```json
{
  "name": "zendomizer-twitch-bot",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.8.19",
    "vitest": "~3.0.0",
    "wrangler": "^4.0.0"
  }
}
```

- [ ] **Step 2: `vitest.config.js` anlegen**

```js
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
```

- [ ] **Step 3: Smoke-Test schreiben**

`twitch-bot/test/smoke.test.js`:

```js
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Test-Umgebung", () => {
  it("stellt die KV-Bindung TWITCH_TOKENS bereit", async () => {
    await env.TWITCH_TOKENS.put("smoke", "ok");
    expect(await env.TWITCH_TOKENS.get("smoke")).toBe("ok");
  });
});
```

- [ ] **Step 4: Installieren und ausführen**

Run: `cd twitch-bot && npm install && npm test`
Expected: PASS, 1 Test. Beim ersten Lauf lädt npm die Pakete — das dauert.

- [ ] **Step 5: Commit**

```bash
git add twitch-bot/package.json twitch-bot/vitest.config.js twitch-bot/test/smoke.test.js twitch-bot/package-lock.json
git commit -m "test: Vitest mit vitest-pool-workers fuer den Twitch-Bot einrichten"
```

---

## Task 2: Token erzeugen und hashen

**Files:**
- Create: `twitch-bot/src/tokens.js`
- Create: `twitch-bot/test/tokens.test.js`

- [ ] **Step 1: Failing Test schreiben**

`twitch-bot/test/tokens.test.js`:

```js
import { describe, it, expect } from "vitest";
import { generateToken, hashToken } from "../src/tokens.js";

describe("generateToken", () => {
  it("liefert 43 Zeichen aus dem base64url-Alphabet", () => {
    const token = generateToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("liefert bei jedem Aufruf einen anderen Wert", () => {
    const werte = new Set(Array.from({ length: 50 }, () => generateToken()));
    expect(werte.size).toBe(50);
  });
});

describe("hashToken", () => {
  it("liefert einen SHA-256-Hash als 64-stelligen Hex-String", async () => {
    const hash = await hashToken("abc");
    expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("ist deterministisch", async () => {
    expect(await hashToken("gleich")).toBe(await hashToken("gleich"));
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd twitch-bot && npm test`
Expected: FAIL — `Failed to resolve import "../src/tokens.js"`

- [ ] **Step 3: Minimale Implementierung**

`twitch-bot/src/tokens.js`:

```js
/**
 * Kanal-Tokens: Erzeugung, Hashing und KV-Zugriff.
 *
 * Im KV liegt ausschliesslich der SHA-256-Hash des Tokens - der Klartext
 * existiert nur beim Streamer. Wer KV-Inhalte einsehen kann, kann daraus
 * keine gueltigen Tokens rekonstruieren.
 */

const TOKEN_BYTES = 32;

export function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `cd twitch-bot && npm test`
Expected: PASS, 4 Tests aus `tokens.test.js` plus Smoke-Test.

- [ ] **Step 5: Commit**

```bash
git add twitch-bot/src/tokens.js twitch-bot/test/tokens.test.js
git commit -m "feat: Kanal-Token erzeugen und hashen"
```

---

## Task 3: Token und State im KV verwalten

**Files:**
- Modify: `twitch-bot/src/tokens.js`
- Modify: `twitch-bot/test/tokens.test.js`

- [ ] **Step 1: Failing Tests ergänzen**

An `twitch-bot/test/tokens.test.js` anhängen:

```js
import { env } from "cloudflare:test";
import {
  saveChannelToken,
  resolveChannelByToken,
  createState,
  consumeState,
} from "../src/tokens.js";

describe("saveChannelToken / resolveChannelByToken", () => {
  it("findet den Kanal zum gespeicherten Token", async () => {
    const token = await saveChannelToken(env, { channelLogin: "kanal_a", channelId: "111" });
    const treffer = await resolveChannelByToken(env, token);
    expect(treffer.channel_login).toBe("kanal_a");
    expect(treffer.channel_id).toBe("111");
    expect(typeof treffer.created_at).toBe("number");
  });

  it("liefert null fuer einen unbekannten Token", async () => {
    expect(await resolveChannelByToken(env, "voellig-erfunden")).toBeNull();
  });

  it("liefert null fuer einen leeren oder fehlenden Token", async () => {
    expect(await resolveChannelByToken(env, "")).toBeNull();
    expect(await resolveChannelByToken(env, undefined)).toBeNull();
  });

  it("entwertet den alten Token, wenn ein Kanal neu verbunden wird", async () => {
    const alt = await saveChannelToken(env, { channelLogin: "kanal_b", channelId: "222" });
    const neu = await saveChannelToken(env, { channelLogin: "kanal_b", channelId: "222" });
    expect(neu).not.toBe(alt);
    expect(await resolveChannelByToken(env, alt)).toBeNull();
    expect((await resolveChannelByToken(env, neu)).channel_login).toBe("kanal_b");
  });

  it("speichert den Token niemals im Klartext", async () => {
    const token = await saveChannelToken(env, { channelLogin: "kanal_c", channelId: "333" });
    const { keys } = await env.TWITCH_TOKENS.list();
    expect(keys.some(k => k.name.includes(token))).toBe(false);
  });
});

describe("createState / consumeState", () => {
  it("akzeptiert einen frisch erzeugten State genau einmal", async () => {
    const state = await createState(env);
    expect(await consumeState(env, state)).toBe(true);
    expect(await consumeState(env, state)).toBe(false);
  });

  it("lehnt unbekannte und leere States ab", async () => {
    expect(await consumeState(env, "nie-erzeugt")).toBe(false);
    expect(await consumeState(env, "")).toBe(false);
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd twitch-bot && npm test`
Expected: FAIL — `saveChannelToken is not a function`

- [ ] **Step 3: Implementierung ergänzen**

An `twitch-bot/src/tokens.js` anhängen:

```js
const STATE_TTL_SECONDS = 600;

/**
 * Legt einen frischen Kanal-Token an und gibt ihn im Klartext zurueck.
 * Ein zuvor fuer denselben Kanal ausgestellter Token wird dabei entwertet.
 */
export async function saveChannelToken(env, { channelLogin, channelId }) {
  const login = String(channelLogin).toLowerCase();

  const alterHash = await env.TWITCH_TOKENS.get(`channel:${login}`);
  if (alterHash) await env.TWITCH_TOKENS.delete(`token:${alterHash}`);

  const token = generateToken();
  const hash = await hashToken(token);

  await env.TWITCH_TOKENS.put(
    `token:${hash}`,
    JSON.stringify({ channel_login: login, channel_id: String(channelId), created_at: Date.now() })
  );
  await env.TWITCH_TOKENS.put(`channel:${login}`, hash);

  return token;
}

export async function resolveChannelByToken(env, token) {
  if (typeof token !== "string" || token.length === 0) return null;
  const hash = await hashToken(token);
  return await env.TWITCH_TOKENS.get(`token:${hash}`, "json");
}

export async function createState(env) {
  const state = generateToken();
  await env.TWITCH_TOKENS.put(`state:${state}`, "1", { expirationTtl: STATE_TTL_SECONDS });
  return state;
}

/** Prueft den State und verbraucht ihn dabei (einmalige Verwendung). */
export async function consumeState(env, state) {
  if (typeof state !== "string" || state.length === 0) return false;
  const key = `state:${state}`;
  const vorhanden = await env.TWITCH_TOKENS.get(key);
  if (!vorhanden) return false;
  await env.TWITCH_TOKENS.delete(key);
  return true;
}
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `cd twitch-bot && npm test`
Expected: PASS, alle Tests.

- [ ] **Step 5: Commit**

```bash
git add twitch-bot/src/tokens.js twitch-bot/test/tokens.test.js
git commit -m "feat: Kanal-Token und OAuth-State im KV verwalten"
```

---

## Task 4: `draw` validieren

**Files:**
- Create: `twitch-bot/src/draw.js`
- Create: `twitch-bot/test/draw.test.js`

- [ ] **Step 1: Failing Test schreiben**

`twitch-bot/test/draw.test.js`:

```js
import { describe, it, expect } from "vitest";
import { validateDraw } from "../src/draw.js";

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
      { category: "Hypercar", brand: "Pfister\nBesuch example.com", model: "Comet\u0007" },
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
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd twitch-bot && npm test`
Expected: FAIL — `Failed to resolve import "../src/draw.js"`

- [ ] **Step 3: Implementierung**

`twitch-bot/src/draw.js`:

```js
/**
 * Validierung der Ziehungsdaten und Aufbau der Chat-Nachricht.
 *
 * Das Frontend schickt ausschliesslich strukturierte Felder - die Nachricht
 * selbst entsteht hier. Dadurch laesst sich ueber die API kein Freitext in
 * den Chat einschleusen.
 */

const MAX_DRAW_ITEMS = 10;
const MAX_FIELD_LENGTH = 100;

function cleanField(value) {
  if (typeof value === "number") value = String(value);
  if (typeof value !== "string") return "";
  return value
    // Steuerzeichen inkl. Zeilenumbruch durch Leerzeichen ersetzen
    .replace(/[\u0000-\u001F\u007F]/g, " ")
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
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `cd twitch-bot && npm test`
Expected: PASS, alle Tests aus `draw.test.js`.

- [ ] **Step 5: Commit**

```bash
git add twitch-bot/src/draw.js twitch-bot/test/draw.test.js
git commit -m "feat: Ziehungsdaten im Worker validieren"
```

---

## Task 5: Chat-Nachricht im Worker bauen

**Files:**
- Modify: `twitch-bot/src/draw.js`
- Modify: `twitch-bot/test/draw.test.js`

Das Format bildet das bisherige Frontend-Verhalten nach (`zendomizer.html:1744-1750` und `:1293-1296`).

- [ ] **Step 1: Failing Tests ergänzen**

An `twitch-bot/test/draw.test.js` anhängen (Import oben um `buildMessage` erweitern):

```js
import { buildMessage } from "../src/draw.js";

describe("buildMessage", () => {
  it("baut das bisherige Frontend-Format nach", () => {
    const nachricht = buildMessage([
      { category: "Hypercar", brand: "Pfister", model: "Comet", year: 2021 },
      { category: "Drift", brand: "Nissan", model: "Silvia", year: null },
    ]);
    expect(nachricht).toBe("🎲 ZENdomizer: Hypercar: Pfister Comet (2021) | Drift: Nissan Silvia");
  });

  it("kuerzt auf das Twitch-Limit von 500 Zeichen", () => {
    const viele = Array.from({ length: 10 }, () => ({
      category: "K".repeat(100), brand: "B".repeat(100), model: "M".repeat(100), year: 2020,
    }));
    const nachricht = buildMessage(viele);
    expect(nachricht.length).toBeLessThanOrEqual(500);
    expect(nachricht.endsWith("…")).toBe(true);
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd twitch-bot && npm test`
Expected: FAIL — `buildMessage is not a function`

- [ ] **Step 3: Implementierung ergänzen**

An `twitch-bot/src/draw.js` anhängen:

```js
const TWITCH_MAX_MESSAGE_LENGTH = 500;

function formatVehicleName(v) {
  return v.year ? `${v.brand} ${v.model} (${v.year})` : `${v.brand} ${v.model}`;
}

export function buildMessage(items) {
  const teile = items.map(v => `${v.category}: ${formatVehicleName(v)}`);
  const nachricht = `🎲 ZENdomizer: ${teile.join(" | ")}`;
  return nachricht.length > TWITCH_MAX_MESSAGE_LENGTH
    ? nachricht.slice(0, TWITCH_MAX_MESSAGE_LENGTH - 1) + "…"
    : nachricht;
}
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `cd twitch-bot && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add twitch-bot/src/draw.js twitch-bot/test/draw.test.js
git commit -m "feat: Chat-Nachricht im Worker aus Ziehungsdaten bauen"
```

---

## Task 6: Twitch-API-Aufrufe in ein eigenes Modul

Reines Verschieben ohne Verhaltensänderung, damit `worker.js` schlank wird.

**Files:**
- Create: `twitch-bot/src/twitch.js`
- Modify: `twitch-bot/worker.js`

- [ ] **Step 1: `src/twitch.js` anlegen**

Die Funktionen `getValidAccessToken`, `resolveUserId`, `sendChatMessage`, `pinChatMessage` samt der Konstanten `TOKEN_KV_KEY` und `PIN_DURATION_SECONDS` **unverändert** aus `worker.js` (Zeilen 24-25 und 126-248) nach `twitch-bot/src/twitch.js` verschieben. Jede der vier Funktionen bekommt `export` vorangestellt. Die erklärenden Kommentare mitnehmen — besonders den zum Pin-Endpunkt (`worker.js:220-228`).

Kopf der neuen Datei:

```js
/**
 * Aufrufe gegen die Twitch-API sowie die Verwaltung des Bot-Access-Tokens.
 * Unveraendert aus worker.js uebernommen.
 */
```

- [ ] **Step 2: In `worker.js` importieren**

Ganz oben in `twitch-bot/worker.js`:

```js
import {
  getValidAccessToken,
  resolveUserId,
  sendChatMessage,
  pinChatMessage,
} from "./src/twitch.js";
```

Die verschobenen Funktionsrümpfe und die beiden Konstanten aus `worker.js` löschen.

- [ ] **Step 3: Prüfen, dass nichts verlorenging**

Run: `cd twitch-bot && grep -n "function \|^const " worker.js src/twitch.js`
Expected: Jede der vier Funktionen erscheint genau einmal, nur in `src/twitch.js`.

- [ ] **Step 4: Tests laufen lassen**

Run: `cd twitch-bot && npm test`
Expected: PASS, unverändert — dieser Task ändert kein Verhalten.

- [ ] **Step 5: Commit**

```bash
git add twitch-bot/src/twitch.js twitch-bot/worker.js
git commit -m "refactor: Twitch-API-Aufrufe nach src/twitch.js verschieben"
```

---

## Task 7: `/auth/start`

**Files:**
- Create: `twitch-bot/src/auth.js`
- Create: `twitch-bot/test/auth.test.js`

- [ ] **Step 1: Failing Test schreiben**

`twitch-bot/test/auth.test.js`:

```js
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { handleAuthStart } from "../src/auth.js";

describe("handleAuthStart", () => {
  it("leitet mit den erwarteten Parametern zu Twitch weiter", async () => {
    const antwort = await handleAuthStart(
      new Request("https://bot.example.dev/auth/start"),
      { ...env, TWITCH_CLIENT_ID: "client123" }
    );

    expect(antwort.status).toBe(302);
    const ziel = new URL(antwort.headers.get("Location"));
    expect(ziel.origin + ziel.pathname).toBe("https://id.twitch.tv/oauth2/authorize");
    expect(ziel.searchParams.get("client_id")).toBe("client123");
    expect(ziel.searchParams.get("response_type")).toBe("code");
    expect(ziel.searchParams.get("redirect_uri")).toBe("https://bot.example.dev/auth/callback");
    expect(ziel.searchParams.get("scope")).toBe("");
    expect(ziel.searchParams.get("state")).toBeTruthy();
  });

  it("leitet die Redirect-URI aus der aufgerufenen URL ab", async () => {
    const antwort = await handleAuthStart(
      new Request("https://anderer-worker.dev/auth/start"),
      { ...env, TWITCH_CLIENT_ID: "client123" }
    );
    const ziel = new URL(antwort.headers.get("Location"));
    expect(ziel.searchParams.get("redirect_uri")).toBe("https://anderer-worker.dev/auth/callback");
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd twitch-bot && npm test`
Expected: FAIL — `Failed to resolve import "../src/auth.js"`

- [ ] **Step 3: Implementierung**

`twitch-bot/src/auth.js`:

```js
/**
 * Einmalige Kanal-Verbindung per Twitch-OAuth.
 *
 * Der Scope bleibt bewusst leer: Fuer den Identitaetsnachweis genuegt der
 * Aufruf von /helix/users mit dem User-Token. Der Streamer sieht auf der
 * Twitch-Seite entsprechend "keine besonderen Berechtigungen".
 */

import { createState, consumeState, saveChannelToken } from "./tokens.js";

export async function handleAuthStart(request, env) {
  const origin = new URL(request.url).origin;
  const state = await createState(env);

  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    redirect_uri: `${origin}/auth/callback`,
    response_type: "code",
    scope: "",
    state,
  });

  return new Response(null, {
    status: 302,
    headers: { Location: `https://id.twitch.tv/oauth2/authorize?${params.toString()}` },
  });
}
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `cd twitch-bot && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add twitch-bot/src/auth.js twitch-bot/test/auth.test.js
git commit -m "feat: /auth/start leitet zum Twitch-Login weiter"
```

---

## Task 8: `/auth/callback`

**Files:**
- Modify: `twitch-bot/src/auth.js`
- Modify: `twitch-bot/test/auth.test.js`

- [ ] **Step 1: Failing Tests ergänzen**

An `twitch-bot/test/auth.test.js` anhängen (Import oben um `handleAuthCallback` erweitern):

```js
import { fetchMock } from "cloudflare:test";
import { beforeAll, afterEach } from "vitest";
import { createState, resolveChannelByToken } from "../src/tokens.js";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const testEnv = () => ({
  ...env,
  TWITCH_CLIENT_ID: "client123",
  TWITCH_CLIENT_SECRET: "secret456",
});

function mockTokenTausch() {
  fetchMock
    .get("https://id.twitch.tv")
    .intercept({ path: "/oauth2/token", method: "POST" })
    .reply(200, { access_token: "user-token", refresh_token: "egal", expires_in: 3600 });
}

function mockHelixUsers(login, id) {
  fetchMock
    .get("https://api.twitch.tv")
    .intercept({ path: "/helix/users", method: "GET" })
    .reply(200, { data: [{ id, login }] });
}

describe("handleAuthCallback", () => {
  it("erzeugt bei gueltigem Code einen Token fuer den angemeldeten Kanal", async () => {
    const e = testEnv();
    const state = await createState(e);
    mockTokenTausch();
    mockHelixUsers("streamer_x", "999");

    const antwort = await handleAuthCallback(
      new Request(`https://bot.example.dev/auth/callback?code=abc&state=${state}`),
      e
    );

    expect(antwort.status).toBe(200);
    expect(antwort.headers.get("Content-Type")).toContain("text/html");

    const html = await antwort.text();
    const treffer = html.match(/data-token="([A-Za-z0-9_-]{43})"/);
    expect(treffer).not.toBeNull();

    const kanal = await resolveChannelByToken(e, treffer[1]);
    expect(kanal.channel_login).toBe("streamer_x");
    expect(kanal.channel_id).toBe("999");
  });

  it("lehnt einen unbekannten State ab, ohne Twitch zu kontaktieren", async () => {
    const antwort = await handleAuthCallback(
      new Request("https://bot.example.dev/auth/callback?code=abc&state=gefaelscht"),
      testEnv()
    );
    expect(antwort.status).toBe(400);
    expect(await antwort.text()).toContain("abgelaufen");
  });

  it("lehnt einen fehlenden Code ab", async () => {
    const e = testEnv();
    const state = await createState(e);
    const antwort = await handleAuthCallback(
      new Request(`https://bot.example.dev/auth/callback?state=${state}`),
      e
    );
    expect(antwort.status).toBe(400);
  });

  it("verbraucht den State, sodass er nicht erneut nutzbar ist", async () => {
    const e = testEnv();
    const state = await createState(e);
    mockTokenTausch();
    mockHelixUsers("streamer_y", "888");

    await handleAuthCallback(
      new Request(`https://bot.example.dev/auth/callback?code=abc&state=${state}`), e
    );
    const zweite = await handleAuthCallback(
      new Request(`https://bot.example.dev/auth/callback?code=abc&state=${state}`), e
    );
    expect(zweite.status).toBe(400);
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd twitch-bot && npm test`
Expected: FAIL — `handleAuthCallback is not a function`

- [ ] **Step 3: Implementierung ergänzen**

An `twitch-bot/src/auth.js` anhängen:

```js
export async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code) {
    return htmlSeite(400, "Autorisierung unvollstaendig",
      "Twitch hat keinen Autorisierungscode zurueckgegeben. Bitte den Vorgang erneut starten.");
  }
  if (!(await consumeState(env, state))) {
    return htmlSeite(400, "Sitzung abgelaufen",
      "Dieser Autorisierungsversuch ist abgelaufen oder wurde bereits verwendet. Bitte erneut starten.");
  }

  let login, id;
  try {
    const accessToken = await tauscheCodeGegenToken(code, `${url.origin}/auth/callback`, env);
    ({ login, id } = await ermittleAngemeldetenNutzer(accessToken, env.TWITCH_CLIENT_ID));
    // Das User-Access-Token wird ab hier nicht mehr gebraucht und nirgends gespeichert.
  } catch (err) {
    return htmlSeite(502, "Twitch nicht erreichbar",
      `Die Anmeldung konnte nicht abgeschlossen werden: ${err.message || err}`);
  }

  const token = await saveChannelToken(env, { channelLogin: login, channelId: id });

  return htmlSeite(200, "Kanal verbunden", null, { login, token });
}

async function tauscheCodeGegenToken(code, redirectUri, env) {
  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`Token-Tausch fehlgeschlagen (${res.status}).`);

  const data = await res.json();
  return data.access_token;
}

async function ermittleAngemeldetenNutzer(accessToken, clientId) {
  const res = await fetch("https://api.twitch.tv/helix/users", {
    headers: { "Client-Id": clientId, "Authorization": `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Users-API Fehler (${res.status}).`);

  const data = await res.json();
  const nutzer = data.data?.[0];
  if (!nutzer) throw new Error("Twitch lieferte keinen Nutzer zurueck.");
  return { login: nutzer.login, id: nutzer.id };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, z => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[z]
  ));
}

function htmlSeite(status, titel, text, erfolg = null) {
  const inhalt = erfolg
    ? `<p>Dein Kanal <strong>${escapeHtml(erfolg.login)}</strong> ist jetzt verbunden.</p>
       <p>Kopiere diesen Token in die Twitch-Einstellungen von ZENdomizer:</p>
       <code data-token="${escapeHtml(erfolg.token)}">${escapeHtml(erfolg.token)}</code>
       <p class="hinweis">Behandle den Token wie ein Passwort. Wer ihn hat, kann
          Ziehungen in deinen Chat posten. Du kannst ihn jederzeit erneuern,
          indem du diese Seite noch einmal durchlaeufst - der alte wird dabei
          ungueltig.</p>
       <p class="hinweis">Damit der Bot senden darf, muss er in deinem Chat
          Moderator sein: <code>/mod ZENdomizerBot</code></p>`
    : `<p>${escapeHtml(text)}</p>`;

  return new Response(
    `<!doctype html><html lang="de"><head><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${escapeHtml(titel)} - ZENdomizer</title>
     <style>
       body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;
            background:#14121a;color:#eee;line-height:1.5}
       code{display:inline-block;background:#000;padding:.6rem .8rem;border-radius:.4rem;
            word-break:break-all;font-size:1.05rem}
       .hinweis{color:#aaa;font-size:.9rem}
     </style></head>
     <body><h1>${escapeHtml(titel)}</h1>${inhalt}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `cd twitch-bot && npm test`
Expected: PASS, alle vier Callback-Tests.

- [ ] **Step 5: Commit**

```bash
git add twitch-bot/src/auth.js twitch-bot/test/auth.test.js
git commit -m "feat: /auth/callback stellt Kanal-Tokens aus"
```

---

## Task 9: Routing und `/announce`

Hier schließt sich die Lücke: Der Kanal kommt aus dem Token, nie aus dem Request.

**Files:**
- Modify: `twitch-bot/worker.js`
- Create: `twitch-bot/test/announce.test.js`

- [ ] **Step 1: Failing Tests schreiben**

`twitch-bot/test/announce.test.js`:

```js
import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import worker from "../worker.js";
import { saveChannelToken } from "../src/tokens.js";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const testEnv = () => ({
  ...env,
  TWITCH_CLIENT_ID: "client123",
  TWITCH_CLIENT_SECRET: "secret456",
  TWITCH_BOT_USER_ID: "bot42",
});

const DRAW = [{ category: "Hypercar", brand: "Pfister", model: "Comet", year: 2021 }];

function anfrage(body) {
  return new Request("https://bot.example.dev/announce", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Bot-Token aus KV bedienen, damit kein Refresh gegen Twitch noetig ist. */
async function botTokenSetzen(e) {
  await e.TWITCH_TOKENS.put("bot_token", JSON.stringify({
    access_token: "bot-access", refresh_token: "bot-refresh", expires_at: Date.now() + 3_600_000,
  }));
}

describe("POST /announce", () => {
  it("lehnt Anfragen ohne Token mit 401 ab", async () => {
    const antwort = await worker.fetch(anfrage({ draw: DRAW }), testEnv());
    expect(antwort.status).toBe(401);
    expect((await antwort.json()).success).toBe(false);
  });

  it("lehnt erfundene Tokens mit 401 ab", async () => {
    const antwort = await worker.fetch(anfrage({ token: "voellig-erfunden", draw: DRAW }), testEnv());
    expect(antwort.status).toBe(401);
  });

  it("postet in den Kanal des Tokens", async () => {
    const e = testEnv();
    await botTokenSetzen(e);
    const token = await saveChannelToken(e, { channelLogin: "kanal_eins", channelId: "111" });

    let gesendetesBody = null;
    fetchMock.get("https://api.twitch.tv")
      .intercept({ path: "/helix/chat/messages", method: "POST" })
      .reply(200, (opts) => {
        gesendetesBody = JSON.parse(opts.body);
        return { data: [{ is_sent: true, message_id: "msg-1" }] };
      });

    const antwort = await worker.fetch(anfrage({ token, draw: DRAW }), e);

    expect(antwort.status).toBe(200);
    expect((await antwort.json()).success).toBe(true);
    expect(gesendetesBody.broadcaster_id).toBe("111");
    expect(gesendetesBody.message).toBe("🎲 ZENdomizer: Hypercar: Pfister Comet (2021)");
  });

  it("ignoriert ein mitgeschicktes fremdes channel-Feld", async () => {
    const e = testEnv();
    await botTokenSetzen(e);
    const token = await saveChannelToken(e, { channelLogin: "kanal_eins", channelId: "111" });

    let gesendetesBody = null;
    fetchMock.get("https://api.twitch.tv")
      .intercept({ path: "/helix/chat/messages", method: "POST" })
      .reply(200, (opts) => {
        gesendetesBody = JSON.parse(opts.body);
        return { data: [{ is_sent: true, message_id: "msg-2" }] };
      });

    await worker.fetch(anfrage({ token, draw: DRAW, channel: "fremder_kanal" }), e);

    expect(gesendetesBody.broadcaster_id).toBe("111");
  });

  it("lehnt ungueltiges draw mit 400 ab", async () => {
    const e = testEnv();
    const token = await saveChannelToken(e, { channelLogin: "kanal_zwei", channelId: "222" });
    const antwort = await worker.fetch(anfrage({ token, draw: [] }), e);
    expect(antwort.status).toBe(400);
  });

  it("beantwortet GET mit 405", async () => {
    const antwort = await worker.fetch(new Request("https://bot.example.dev/announce"), testEnv());
    expect(antwort.status).toBe(405);
  });

  it("beantwortet OPTIONS mit CORS-Headern", async () => {
    const antwort = await worker.fetch(
      new Request("https://bot.example.dev/announce", { method: "OPTIONS" }), testEnv()
    );
    expect(antwort.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd twitch-bot && npm test`
Expected: FAIL — die alte Route antwortet nicht wie erwartet (u.a. 400 statt 401).

- [ ] **Step 3: `worker.js` neu schreiben**

`twitch-bot/worker.js` vollständig ersetzen durch:

```js
/**
 * ZENdomizer Twitch-Bot Worker
 * -----------------------------
 * Nimmt Ziehungsergebnisse von zendomizer.html entgegen und postet sie als
 * Chat-Bot-Account in den Twitch-Chat - optional zusaetzlich angepinnt
 * (Twitch "Pin Chat Message", max. 20 Minuten, feste Twitch-Vorgabe).
 *
 * Der Zielkanal ergibt sich AUSSCHLIESSLICH aus dem mitgeschickten
 * Kanal-Token. Ein Kanalname im Request wird ignoriert - damit kann niemand
 * in fremde Kanaele posten, auch nicht mit Kenntnis der Worker-URL.
 *
 * Routen:
 *   GET  /auth/start     - leitet den Streamer zum Twitch-Login weiter
 *   GET  /auth/callback  - stellt nach erfolgreichem Login den Token aus
 *   POST /announce       - postet ein Ziehungsergebnis
 *
 * Benoetigte Secrets (per `wrangler secret put <NAME>` setzen):
 *   TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_BOT_USER_ID,
 *   TWITCH_BOT_INITIAL_REFRESH_TOKEN, ALLOWED_ORIGIN (optional)
 * Benoetigte KV-Bindung (siehe wrangler.toml): TWITCH_TOKENS
 */

import { getValidAccessToken, sendChatMessage, pinChatMessage } from "./src/twitch.js";
import { handleAuthStart, handleAuthCallback } from "./src/auth.js";
import { resolveChannelByToken } from "./src/tokens.js";
import { validateDraw, buildMessage } from "./src/draw.js";

const PIN_DURATION_SECONDS = 1200; // 20 Minuten - Twitch-Maximum

export default {
  async fetch(request, env) {
    const pfad = new URL(request.url).pathname;

    if (request.method === "GET" && pfad === "/auth/start") {
      return handleAuthStart(request, env);
    }
    if (request.method === "GET" && pfad === "/auth/callback") {
      return handleAuthCallback(request, env);
    }

    const corsHeaders = buildCorsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return json({ success: false, error: "Nur POST erlaubt." }, 405, corsHeaders);
    }

    return handleAnnounce(request, env, corsHeaders);
  },
};

async function handleAnnounce(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ success: false, error: "Ungueltiger JSON-Body." }, 400, corsHeaders);
  }

  // Der Kanal kommt aus dem Token, niemals aus dem Request.
  const kanal = await resolveChannelByToken(env, body.token);
  if (!kanal) {
    return json({
      success: false,
      error: "Kanal nicht verbunden. Bitte den Kanal in den Twitch-Einstellungen neu verbinden.",
      code: "token_invalid",
    }, 401, corsHeaders);
  }

  const geprueft = validateDraw(body.draw);
  if (!geprueft.ok) {
    return json({ success: false, error: geprueft.error }, 400, corsHeaders);
  }

  const nachricht = buildMessage(geprueft.items);
  const shouldPin = body.pin === true;

  try {
    const accessToken = await getValidAccessToken(env);

    const sendResult = await sendChatMessage({
      broadcasterId: kanal.channel_id,
      senderId: env.TWITCH_BOT_USER_ID,
      message: nachricht,
      clientId: env.TWITCH_CLIENT_ID,
      accessToken,
    });

    if (!sendResult.is_sent) {
      const grund = sendResult.drop_reason?.message
        || "Unbekannter Grund (evtl. Bot nicht Moderator im Kanal?).";
      return json({
        success: false,
        error: `Nachricht wurde von Twitch nicht gesendet: ${grund}`,
      }, 200, corsHeaders);
    }

    let pinned = false;
    let pinError = null;
    if (shouldPin) {
      try {
        await pinChatMessage({
          broadcasterId: kanal.channel_id,
          moderatorId: env.TWITCH_BOT_USER_ID,
          messageId: sendResult.message_id,
          clientId: env.TWITCH_CLIENT_ID,
          accessToken,
          durationSeconds: PIN_DURATION_SECONDS,
        });
        pinned = true;
      } catch (e) {
        // Nachricht ist bereits gesendet - ein Pin-Fehler soll das Ergebnis
        // nicht als kompletten Fehlschlag markieren.
        pinError = e.message || String(e);
      }
    }

    return json({
      success: true,
      channel: kanal.channel_login,
      message_id: sendResult.message_id,
      pinned,
      pinError,
    }, 200, corsHeaders);
  } catch (err) {
    return json({ success: false, error: err.message || String(err) }, 500, corsHeaders);
  }
}

function buildCorsHeaders(env) {
  // ALLOWED_ORIGIN optional als Secret/Var setzbar, um den Worker auf eine
  // bestimmte Zendomizer-Instanz einzuschraenken. Ohne Angabe: offen (*).
  const origin = env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN.length > 0 ? env.ALLOWED_ORIGIN : "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 4: `pinChatMessage` auf den übergebenen Wert umstellen**

In `twitch-bot/src/twitch.js` die Signatur erweitern, damit die Konstante nur an einer Stelle lebt:

```js
export async function pinChatMessage({ broadcasterId, moderatorId, messageId, clientId, accessToken, durationSeconds }) {
  const params = new URLSearchParams({
    broadcaster_id: broadcasterId,
    moderator_id: moderatorId,
    message_id: messageId,
    duration_seconds: String(durationSeconds),
  });
  // ... unveraendert weiter
```

Die Konstante `PIN_DURATION_SECONDS` aus `src/twitch.js` entfernen — sie steht jetzt in `worker.js`.

Außerdem `resolveUserId()` aus `src/twitch.js` **löschen**: Die Kanal-ID wird beim Verbinden gespeichert und beim Senden aus dem Token gelesen, den Namen-zu-ID-Aufruf braucht niemand mehr. `src/auth.js` hat mit `ermittleAngemeldetenNutzer()` seinen eigenen `/helix/users`-Aufruf (ohne `login`-Parameter, er fragt nach dem angemeldeten Nutzer) — beide Funktionen nebeneinander wären doppelte Logik.

Run: `cd twitch-bot && grep -rn "resolveUserId" .  --exclude-dir=node_modules`
Expected: keine Treffer.

- [ ] **Step 5: Tests laufen lassen**

Run: `cd twitch-bot && npm test`
Expected: PASS, alle Tests inklusive der sieben aus `announce.test.js`.

- [ ] **Step 6: Commit**

```bash
git add twitch-bot/worker.js twitch-bot/src/twitch.js twitch-bot/test/announce.test.js
git commit -m "feat: Zielkanal ausschliesslich aus dem Kanal-Token ableiten"
```

---

## Task 10: Frontend auf Token umstellen

**Files:**
- Modify: `zendomizer.html:972-982` (Einstellungs-Panel)
- Modify: `zendomizer.html:1698-1801` (Twitch-Logik)
- Modify: `zendomizer.html:2074-2077` (Aufruf nach der Ziehung)

- [ ] **Step 1: Panel-Markup ersetzen**

`zendomizer.html:974-981` — der Block innerhalb `<div id="twitchSettingsPanel">` wird zu:

```html
<label><input type="checkbox" id="twitchEnabled" onchange="saveTwitchSettings()"><span id="twitchEnabledLabel">Twitch settings label</span></label>
<button id="twitchConnectBtn" class="filter-control" onclick="openTwitchConnect()">Kanal verbinden</button>
<input type="text" id="twitchToken" oninput="saveTwitchSettings()" />
<label><input type="checkbox" id="twitchPin" onchange="saveTwitchSettings()"><span id="twitchPinLabel">Twitch pin label</span></label>
<input type="text" id="twitchWorkerUrl" oninput="saveTwitchSettings()" />
<button id="twitchTestBtn" class="filter-control" onclick="testTwitchAnnounce()">Twitch test label</button>
<div id="twitchStatusMsg" class="twitch-status-msg"></div>
```

Das Feld `twitchChannel` entfällt ersatzlos.

- [ ] **Step 2: Lade- und Speicherlogik anpassen**

`loadTwitchSettings()` (`:1700-1715`) und `saveTwitchSettings()` (`:1717-1726`): jeden Bezug auf `zendomizerTwitchChannel` / `twitchChannel` durch `zendomizerTwitchToken` / `twitchToken` ersetzen:

```js
    function loadTwitchSettings() {
      const enabled = localStorage.getItem("zendomizerTwitchEnabled") === "true";
      const pin = localStorage.getItem("zendomizerTwitchPin") === "true";
      const token = localStorage.getItem("zendomizerTwitchToken") || "";
      const workerUrl = localStorage.getItem("zendomizerTwitchWorkerUrl") || DEFAULT_TWITCH_WORKER_URL;

      const enabledBox = document.getElementById("twitchEnabled");
      const pinBox = document.getElementById("twitchPin");
      const tokenInput = document.getElementById("twitchToken");
      const workerInput = document.getElementById("twitchWorkerUrl");

      if (enabledBox) enabledBox.checked = enabled;
      if (pinBox) pinBox.checked = pin;
      if (tokenInput) tokenInput.value = token;
      if (workerInput) workerInput.value = workerUrl;
    }

    function saveTwitchSettings() {
      const enabled = document.getElementById("twitchEnabled")?.checked || false;
      const pin = document.getElementById("twitchPin")?.checked || false;
      const token = (document.getElementById("twitchToken")?.value || "").trim();
      const workerUrl = (document.getElementById("twitchWorkerUrl")?.value || "").trim();

      localStorage.setItem("zendomizerTwitchEnabled", String(enabled));
      localStorage.setItem("zendomizerTwitchPin", String(pin));
      localStorage.setItem("zendomizerTwitchToken", token);
      localStorage.setItem("zendomizerTwitchWorkerUrl", workerUrl);

      const statusEl = document.getElementById("twitchStatusMsg");
      if (statusEl) {
        statusEl.textContent = "";
        statusEl.classList.remove("error");
      }
    }
```

- [ ] **Step 3: „Kanal verbinden" ergänzen**

Direkt nach `saveTwitchSettings()` einfügen:

```js
    function openTwitchConnect() {
      const workerUrl = (document.getElementById("twitchWorkerUrl")?.value || "").trim();
      const statusEl = document.getElementById("twitchStatusMsg");
      if (!workerUrl) {
        if (statusEl) {
          statusEl.textContent = t("twitch_worker_url_missing");
          statusEl.classList.add("error");
        }
        return;
      }
      window.open(workerUrl.replace(/\/+$/, "") + "/auth/start", "_blank", "noopener");
    }
```

- [ ] **Step 4: `formatTwitchMessage` durch `buildTwitchDraw` ersetzen**

`formatTwitchMessage()` (`:1744-1750`) vollständig ersetzen durch:

```js
    // Strukturierte Ziehungsdaten fuer den Worker. Die Chat-Zeile baut der
    // Worker daraus selbst - so kann ueber diese Schnittstelle kein Freitext
    // in den Chat gelangen.
    function buildTwitchDraw(selection) {
      if (!selection || selection.length === 0) return [];
      return selection
        .filter(v => v && v.category)
        .map(v => ({ category: v.category, brand: v.brand, model: v.model, year: v.year }));
    }
```

- [ ] **Step 5: `sendTwitchAnnouncement` umstellen**

`sendTwitchAnnouncement()` (`:1752-1797`) ersetzen durch:

```js
    async function sendTwitchAnnouncement(draw) {
      const enabled = localStorage.getItem("zendomizerTwitchEnabled") === "true";
      if (!enabled) return;

      const token = (localStorage.getItem("zendomizerTwitchToken") || "").trim();
      const workerUrl = (localStorage.getItem("zendomizerTwitchWorkerUrl") || DEFAULT_TWITCH_WORKER_URL || "").trim();
      const pin = localStorage.getItem("zendomizerTwitchPin") === "true";

      const statusEl = document.getElementById("twitchStatusMsg");

      if (!token || !workerUrl) {
        if (statusEl) {
          statusEl.textContent = t("twitch_not_configured");
          statusEl.classList.add("error");
        }
        return;
      }
      if (!draw || draw.length === 0) return;

      try {
        const res = await fetch(workerUrl.replace(/\/+$/, "") + "/announce", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, draw, pin }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.status === 401) {
          throw new Error(t("twitch_channel_not_connected"));
        }
        if (!res.ok || !data.success) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        if (statusEl) {
          statusEl.textContent = data.pinned ? t("twitch_sent_and_pinned") : t("twitch_sent");
          statusEl.classList.remove("error");
        }
      } catch (err) {
        console.warn("⚠️ Twitch-Ankündigung fehlgeschlagen:", err);
        if (statusEl) {
          statusEl.textContent = `${t("twitch_send_error")}: ${err.message || err}`;
          statusEl.classList.add("error");
        }
        // Bewusst kein showToast() - ein fehlgeschlagener Twitch-Post soll die
        // normale Ziehung nicht stoeren.
      }
    }

    function testTwitchAnnounce() {
      sendTwitchAnnouncement([
        { category: "Test", brand: "ZENdomizer", model: "Testfahrzeug", year: new Date().getFullYear() },
      ]);
    }
```

- [ ] **Step 6: Aufrufstelle nach der Ziehung anpassen**

`zendomizer.html:2076` ändern:

```js
        sendTwitchAnnouncement(buildTwitchDraw(lastSelection));
```

- [ ] **Step 7: Prüfen, dass keine alten Bezüge übrig sind**

Run: `cd ~/Code/TCM-ZEN_DOMIZER && grep -n "twitchChannel\|zendomizerTwitchChannel\|formatTwitchMessage" zendomizer.html`
Expected: keine Treffer.

- [ ] **Step 8: Commit**

```bash
git add zendomizer.html
git commit -m "feat: Frontend nutzt Kanal-Token statt Kanalname"
```

---

## Task 11: Übersetzungen ergänzen

**Files:**
- Modify: `translations/i18n.json`

- [ ] **Step 1: Bestehende Struktur ansehen**

Run: `cd ~/Code/TCM-ZEN_DOMIZER && grep -n "twitch_" translations/i18n.json`
Expected: die vorhandenen Twitch-Schlüssel je Sprache — die neuen exakt daneben einsortieren.

- [ ] **Step 2: Neue Schlüssel ergänzen**

Für **jede** vorhandene Sprache ergänzen. Deutsch:

```json
"twitch_connect": "Kanal verbinden",
"twitch_token_label": "Kanal-Token",
"twitch_channel_not_connected": "Kanal nicht verbunden - bitte über \"Kanal verbinden\" neu autorisieren.",
"twitch_worker_url_missing": "Bitte zuerst die Worker-URL eintragen."
```

Englisch:

```json
"twitch_connect": "Connect channel",
"twitch_token_label": "Channel token",
"twitch_channel_not_connected": "Channel not connected - please authorize again via \"Connect channel\".",
"twitch_worker_url_missing": "Please enter the worker URL first."
```

Ein etwaiger Schlüssel `twitch_channel_label` (Beschriftung des alten Kanalfelds) entfällt.

- [ ] **Step 3: JSON validieren**

Run: `cd ~/Code/TCM-ZEN_DOMIZER && python3 -c "import json; d=json.load(open('translations/i18n.json')); print('valide, Sprachen:', list(d.get('meta', {}).keys()))"`
Expected: `valide, Sprachen: [...]` — **kein** Traceback.

Diese Prüfung ist Pflicht: Eine kaputte `i18n.json` legt dieselbe `Promise.all`-Kette lahm wie seinerzeit die fehlerhafte `vehicles.json` und damit die ganze Seite.

- [ ] **Step 4: Beschriftungen im Panel verdrahten**

Zuerst ansehen, wie die vorhandenen Twitch-Beschriftungen gesetzt werden:

Run: `cd ~/Code/TCM-ZEN_DOMIZER && grep -n "twitchEnabledLabel\|twitchPinLabel\|twitchTestBtn" zendomizer.html`

In `applyTranslations()` stehen dort Zuweisungen nach diesem Muster (die genauen Zeilen liefert der Befehl oben):

```js
const el = document.getElementById("twitchEnabledLabel");
if (el) el.textContent = t("twitch_enabled_label");
```

Nach demselben Muster ergänzen — Schlüsselnamen exakt so wie in Task 11 Step 2 angelegt:

```js
const connectBtn = document.getElementById("twitchConnectBtn");
if (connectBtn) connectBtn.textContent = t("twitch_connect");

const tokenInput = document.getElementById("twitchToken");
if (tokenInput) tokenInput.placeholder = t("twitch_token_label");
```

Das Worker-URL-Feld behält seine bestehende Behandlung.

- [ ] **Step 5: Commit**

```bash
git add translations/i18n.json zendomizer.html
git commit -m "i18n: Texte fuer die Kanal-Verbindung ergaenzen"
```

---

## Task 12: README aktualisieren

**Files:**
- Modify: `twitch-bot/README.md`

- [ ] **Step 1: Abschnitt „Nutzung durch einzelne Streamer" ersetzen**

```markdown
## Nutzung durch einzelne Streamer

1. Im eigenen Twitch-Chat einmalig eintippen: `/mod ZENdomizerBot`
2. In Zendomizer unter den Twitch-Einstellungen auf **Kanal verbinden**
   klicken. Es öffnet sich eine Twitch-Anmeldung, die *keine* besonderen
   Berechtigungen anfordert - sie dient allein dem Nachweis, dass dir der
   Kanal gehört.
3. Den angezeigten Kanal-Token in das Token-Feld einfügen, Häkchen setzen.

Der Token wirkt wie ein Passwort für den eigenen Chat. Er lässt sich
jederzeit erneuern, indem man den Verbinden-Schritt wiederholt - der alte
Token wird dabei ungültig.

**Ein Kanalname wird nicht mehr eingetragen.** Der Worker leitet den
Zielkanal ausschließlich aus dem Token ab; in fremde Kanäle kann damit
niemand posten, auch nicht mit Kenntnis der Worker-URL.
```

- [ ] **Step 2: Setup-Abschnitt um die Redirect-URL ergänzen**

In Abschnitt „2. Twitch-App registrieren" bei den OAuth Redirect URLs ergänzen:

```markdown
- **OAuth Redirect URLs:** zusätzlich zur `http://localhost:3000` aus der
  Erstautorisierung die Callback-URL des Workers eintragen:
  `https://<dein-worker>.workers.dev/auth/callback`
```

- [ ] **Step 3: Einschränkungsliste korrigieren**

Den Punkt „Kein eingebauter Schutz gegen Missbrauch über die Worker-URL hinaus" ersetzen durch:

```markdown
- Der Zugriff ist über Kanal-Tokens abgesichert: Der Worker postet nur in
  den Kanal, der zum jeweiligen Token gehört, und ausschließlich
  Ziehungsergebnisse (kein Freitext).
- Kein Rate-Limiting: Ein Streamer kann seinen eigenen Chat zuspammen.
  Twitch drosselt serverseitig mit.
```

Den Hinweis zum ungetesteten Pin-Endpunkt ebenfalls streichen — Senden und Pinnen wurden am 2026-08-11 live verifiziert.

- [ ] **Step 4: Tests dokumentieren**

Am Ende ergänzen:

```markdown
## Tests

```bash
cd twitch-bot
npm install
npm test
```

Die Tests laufen über `@cloudflare/vitest-pool-workers` in einer lokalen
Workers-Runtime mit eigenem KV-Store — sie fassen weder den echten
KV-Namespace noch Twitch an.
```

- [ ] **Step 5: Commit**

```bash
git add twitch-bot/README.md
git commit -m "docs: README auf den Kanal-Token-Ablauf umstellen"
```

---

## Task 13: Deployen und live verifizieren

**Files:** keine — reine Verifikation gegen den echten Worker.

- [ ] **Step 1: Voraussetzung prüfen**

Die Callback-URL muss in der Twitch-App eingetragen sein:
`https://zendomizer-twitch-bot.shogun160.workers.dev/auth/callback`
(vom Betreiber am 2026-08-11 erledigt).

- [ ] **Step 2: Testsuite vor dem Deploy**

Run: `cd twitch-bot && npm test`
Expected: PASS, alles grün. Bei Fehlschlag **nicht** deployen.

- [ ] **Step 3: Deployen**

Run: `cd twitch-bot && npx wrangler deploy`
Expected: `Deployed zendomizer-twitch-bot triggers` samt Versions-ID.

- [ ] **Step 4: Abweisung ohne Token prüfen**

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST \
  https://zendomizer-twitch-bot.shogun160.workers.dev/announce \
  -H 'Content-Type: application/json' \
  -d '{"draw":[{"category":"Test","brand":"ZEN","model":"X"}]}'
```

Expected: `HTTP 401`, `"code":"token_invalid"`, **keine** Nachricht im Chat.

- [ ] **Step 5: Abweisung mit erfundenem Token prüfen**

Gleicher Aufruf mit `"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"`.
Expected: `HTTP 401`, **keine** Nachricht im Chat.

- [ ] **Step 6: Kanal verbinden**

Im Browser `https://zendomizer-twitch-bot.shogun160.workers.dev/auth/start` öffnen,
mit dem **Streamer-Account** (nicht dem Bot-Account) anmelden, Token notieren.

Expected: Seite „Kanal verbunden" mit korrektem Kanalnamen und 43-stelligem Token.

- [ ] **Step 7: Erfolgsfall prüfen**

```bash
curl -s -X POST https://zendomizer-twitch-bot.shogun160.workers.dev/announce \
  -H 'Content-Type: application/json' \
  -d '{"token":"<TOKEN>","pin":false,"draw":[{"category":"Hypercar","brand":"Pfister","model":"Comet","year":2021}]}'
```

Expected: `"success":true`, `"channel":"<dein-kanal>"`, Nachricht sichtbar im Chat.

- [ ] **Step 8: Der entscheidende Test — fremder Kanal**

Gleicher Aufruf, zusätzlich `"channel":"irgendein_fremder_kanal"` im Body.

Expected: `"channel"` in der Antwort ist **dein** Kanal, die Nachricht landet **in deinem** Chat. Das belegt, dass die Lücke geschlossen ist.

- [ ] **Step 9: Freitext-Einschleusung prüfen**

Aufruf mit `"model":"Comet\nhttp://spam.example"`.
Expected: `400`, oder Nachricht ohne Zeilenumbruch und ohne separate Zeile im Chat.

- [ ] **Step 10: Token-Erneuerung prüfen**

`/auth/start` erneut durchlaufen, dann den **alten** Token verwenden.
Expected: `HTTP 401` für den alten, `success:true` für den neuen Token.

- [ ] **Step 11: Durchlauf im Browser**

Lokalen Server starten (`python3 -m http.server 8765` im Repo-Wurzelverzeichnis), Seite öffnen, Token eintragen, Häkchen setzen, GO drücken — mit und ohne Pin.
Expected: Ziehungsergebnis erscheint im Chat, Panel meldet Erfolg.

- [ ] **Step 12: Ergebnisse festhalten**

Die Resultate der Schritte 4-11 im PR beschreiben, insbesondere Schritt 8.

---

## Offene Punkte für den Betreiber

- **Kosmetik:** In `cars/vehicles.json:7326` steht `"Traxxas X-Maxx Ulitmate"` statt `"Ultimate"`. Unabhängig von diesem Plan, aber im Chat sichtbar.
- **Alter Bot-Token:** `TWITCH_BOT_INITIAL_REFRESH_TOKEN` bleibt unverändert nötig, die Bot-Token-Rotation im KV ist von diesem Umbau nicht betroffen.
