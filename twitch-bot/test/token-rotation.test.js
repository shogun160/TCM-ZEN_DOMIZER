import { fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { getValidAccessToken } from "../src/twitch.js";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

/**
 * KV-Attrappe statt des echten Namespace: Diese Tests brauchen exakte Kontrolle
 * darueber, WAS bei welchem Lesevorgang zurueckkommt (ein anderer Worker, der
 * zwischendurch schreibt, laesst sich anders nicht nachstellen). Ausserdem
 * stolpert die Storage-Isolation von vitest-pool-workers ueber die parallelen
 * Zugriffe, die hier ja gerade der Testgegenstand sind.
 */
function fakeKv(anfangswert = null) {
  let wert = anfangswert;
  const kv = {
    schreibvorgaenge: [],
    lesevorgaenge: 0,
    /** Legt fest, was der n-te Lesevorgang liefert (0-basiert); Rest wie gehabt. */
    beiLesevorgang: {},
    get: async () => {
      const n = kv.lesevorgaenge++;
      if (n in kv.beiLesevorgang) return kv.beiLesevorgang[n];
      return wert;
    },
    put: async (key, value) => {
      wert = JSON.parse(value);
      kv.schreibvorgaenge.push(wert);
    },
  };
  return kv;
}

const abgelaufen = { access_token: "alt", refresh_token: "alt-refresh", expires_at: Date.now() - 1000 };
const gueltig = (name) => ({ access_token: name, refresh_token: `${name}-refresh`, expires_at: Date.now() + 3_600_000 });

function testEnv(kv) {
  return {
    TWITCH_TOKENS: kv,
    TWITCH_CLIENT_ID: "client123",
    TWITCH_CLIENT_SECRET: "secret456",
  };
}

/** Ein Refresh-Interceptor, der genau EINMAL antworten darf. */
function refreshErlauben({ access = "frisch-access", refresh = "frisch-refresh", expiresIn = 3600 } = {}) {
  fetchMock
    .get("https://id.twitch.tv")
    .intercept({ path: "/oauth2/token", method: "POST" })
    .reply(200, { access_token: access, refresh_token: refresh, expires_in: expiresIn });
}

function refreshAblehnen(status = 400, body = JSON.stringify({ message: "Invalid refresh token" })) {
  fetchMock
    .get("https://id.twitch.tv")
    .intercept({ path: "/oauth2/token", method: "POST" })
    .reply(status, body);
}

// ---------------------------------------------------------------------------
// Single-Flight. Twitch entwertet den refresh_token bei jeder Nutzung: zwei
// gleichzeitige Refreshes mit demselben Token machen einen davon tot - und der
// Bot faellt Stunden spaeter fuer ALLE Kanaele aus.
// ---------------------------------------------------------------------------
describe("Paralleler Token-Refresh", () => {
  it("loest bei gleichzeitigen Aufrufen nur EINEN Refresh gegen Twitch aus", async () => {
    const kv = fakeKv(abgelaufen);
    refreshErlauben(); // genau einer - ein zweiter Aufruf fliegt mangels Interceptor auf

    const tokens = await Promise.all([
      getValidAccessToken(testEnv(kv)),
      getValidAccessToken(testEnv(kv)),
      getValidAccessToken(testEnv(kv)),
    ]);

    expect(tokens).toEqual(["frisch-access", "frisch-access", "frisch-access"]);
    expect(kv.schreibvorgaenge).toHaveLength(1);
  });

  it("bedient mehrere Streams unabhaengig - keiner geht leer aus", async () => {
    const kv = fakeKv(abgelaufen);
    refreshErlauben();

    const tokens = await Promise.all(
      Array.from({ length: 10 }, () => getValidAccessToken(testEnv(kv)))
    );

    expect(tokens).toHaveLength(10);
    expect(tokens.every((t) => t === "frisch-access")).toBe(true);
  });

  it("blockiert nachfolgende Aufrufe nicht: ein gueltiges Token kommt ohne Refresh zurueck", async () => {
    const kv = fakeKv(gueltig("noch-gut"));
    // kein Interceptor: jeder Refresh-Versuch wuerde den Test zum Scheitern bringen

    const tokens = await Promise.all(
      Array.from({ length: 5 }, () => getValidAccessToken(testEnv(kv)))
    );

    expect(tokens.every((t) => t === "noch-gut")).toBe(true);
    expect(kv.schreibvorgaenge).toHaveLength(0);
  });

  it("startet nach einem gescheiterten Refresh wieder neu (kein haengendes Promise)", async () => {
    const kv = fakeKv(abgelaufen);
    refreshAblehnen(500, "Twitch kaputt");

    await expect(getValidAccessToken(testEnv(kv))).rejects.toThrow();

    refreshErlauben();
    await expect(getValidAccessToken(testEnv(kv))).resolves.toBe("frisch-access");
  });
});

// ---------------------------------------------------------------------------
// Selbstheilung. Ist der eigene refresh_token bereits entwertet, weil ein
// anderer Worker ihn benutzt hat, liegt in KV womoeglich laengst ein frisches
// Token - das soll genutzt werden, statt den Aufruf scheitern zu lassen.
// ---------------------------------------------------------------------------
describe("Selbstheilung nach entwertetem refresh_token", () => {
  it("nutzt das inzwischen in KV liegende Token, wenn der eigene Refresh abgelehnt wird", async () => {
    const kv = fakeKv(abgelaufen);
    // Erster Lesevorgang: abgelaufener Stand. Zweiter (nach dem Fehlschlag):
    // der andere Worker war inzwischen fertig.
    kv.beiLesevorgang[1] = gueltig("von-anderem-worker");
    refreshAblehnen();

    await expect(getValidAccessToken(testEnv(kv))).resolves.toBe("von-anderem-worker");
  });

  it("nimmt NICHT denselben toten Stand erneut", async () => {
    const kv = fakeKv(abgelaufen);
    // KV liefert weiterhin denselben abgelaufenen Eintrag - daraus laesst sich nichts retten
    refreshAblehnen();

    await expect(getValidAccessToken(testEnv(kv))).rejects.toThrow(/Token-Refresh fehlgeschlagen/);
  });

  it("nimmt kein abgelaufenes Token aus KV an", async () => {
    const kv = fakeKv(abgelaufen);
    kv.beiLesevorgang[1] = { access_token: "auch-alt", refresh_token: "anders", expires_at: Date.now() - 5000 };
    refreshAblehnen();

    await expect(getValidAccessToken(testEnv(kv))).rejects.toThrow(/Token-Refresh fehlgeschlagen/);
  });
});

// ---------------------------------------------------------------------------
// Kein Rueckschritt. KV kennt kein Compare-and-Swap: wer zuletzt schreibt,
// gewinnt - auch mit einem aelteren, laengst entwerteten Token. Ein Blick vor
// dem Schreiben verhindert wenigstens den offensichtlichen Fall.
// ---------------------------------------------------------------------------
describe("Schreibschutz gegen aeltere Staende", () => {
  it("ueberschreibt kein neueres Token in KV", async () => {
    const kv = fakeKv(abgelaufen);
    // Unser Token laeuft in 60s ab, das in KV erst in 2 Stunden - unseres ist das aeltere
    refreshErlauben({ access: "unser-access", refresh: "unser-refresh", expiresIn: 60 });
    kv.beiLesevorgang[1] = { access_token: "neuer", refresh_token: "neuer-refresh", expires_at: Date.now() + 7_200_000 };

    const token = await getValidAccessToken(testEnv(kv));

    expect(token).toBe("unser-access");          // die laufende Anfrage nutzt ihr eigenes Token
    expect(kv.schreibvorgaenge).toHaveLength(0); // der neuere Stand bleibt unangetastet
  });

  it("schreibt normal, wenn in KV nichts Neueres liegt", async () => {
    const kv = fakeKv(abgelaufen);
    refreshErlauben();

    await getValidAccessToken(testEnv(kv));

    expect(kv.schreibvorgaenge).toHaveLength(1);
    expect(kv.schreibvorgaenge[0].refresh_token).toBe("frisch-refresh");
  });
});
