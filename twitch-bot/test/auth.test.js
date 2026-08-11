import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { handleAuthStart, handleAuthCallback, readStateCookie } from "../src/auth.js";
import { generateToken, resolveChannelByToken } from "../src/tokens.js";

const STATE_COOKIE_NAME = "__Host-zd_state";

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

  // Befund 1+2: der State wird nicht mehr im KV abgelegt (kein Write, kein
  // KV-Quota-Verbrauch), sondern per Double-Submit-Cookie an den Browser
  // gebunden, der /auth/start aufgerufen hat.
  it("setzt ein __Host-zd_state-Cookie mit demselben Wert wie der state in der Redirect-URL", async () => {
    const antwort = await handleAuthStart(
      new Request("https://bot.example.dev/auth/start"),
      { ...env, TWITCH_CLIENT_ID: "client123" }
    );
    const ziel = new URL(antwort.headers.get("Location"));
    const state = ziel.searchParams.get("state");

    const cookie = antwort.headers.get("Set-Cookie");
    expect(cookie).toBeTruthy();
    expect(cookie).toContain(`${STATE_COOKIE_NAME}=${state}`);
  });

  it("setzt das State-Cookie mit HttpOnly, Secure, SameSite=Lax, Path=/ und einer Max-Age von 600s", async () => {
    const antwort = await handleAuthStart(
      new Request("https://bot.example.dev/auth/start"),
      { ...env, TWITCH_CLIENT_ID: "client123" }
    );
    const cookie = antwort.headers.get("Set-Cookie");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=600/);
  });
});

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

/**
 * Baut eine /auth/callback-Anfrage so, wie sie ein Browser schicken wuerde,
 * der zuvor echt /auth/start durchlaufen hat: Query-State und Cookie sind
 * identisch. `cookieState: undefined` laesst das Cookie ganz weg (simuliert
 * z.B. einen Browser, der es nie hatte, oder einen, dem es zuvor schon
 * geloescht wurde).
 */
function callbackAnfrage({ code, state, cookieState }) {
  const params = new URLSearchParams();
  if (code !== undefined) params.set("code", code);
  if (state !== undefined) params.set("state", state);

  const headers = {};
  if (cookieState !== undefined) {
    headers["Cookie"] = `${STATE_COOKIE_NAME}=${cookieState}`;
  }

  return new Request(`https://bot.example.dev/auth/callback?${params.toString()}`, { headers });
}

describe("handleAuthCallback", () => {
  it("erzeugt bei gueltigem Code einen Token fuer den angemeldeten Kanal", async () => {
    const e = testEnv();
    const state = generateToken();
    mockTokenTausch();
    mockHelixUsers("streamer_x", "999");

    const antwort = await handleAuthCallback(
      callbackAnfrage({ code: "abc", state, cookieState: state }),
      e
    );

    expect(antwort.status).toBe(200);
    expect(antwort.headers.get("Content-Type")).toContain("text/html");

    const html = await antwort.text();
    // Der Token steht im Inhalt des code-Elements, nicht in einem
    // data-Attribut - so gibt es ihn nur einmal auf der Seite.
    const treffer = html.match(/<code id="token">([A-Za-z0-9_-]{43})<\/code>/);
    expect(treffer).not.toBeNull();

    const kanal = await resolveChannelByToken(e, treffer[1]);
    expect(kanal.channel_login).toBe("streamer_x");
    expect(kanal.channel_id).toBe("999");
  });

  it("lehnt einen State ohne passendes Cookie ab, ohne Twitch zu kontaktieren", async () => {
    const antwort = await handleAuthCallback(
      callbackAnfrage({ code: "abc", state: "gefaelscht" }),
      testEnv()
    );
    expect(antwort.status).toBe(400);
    expect(await antwort.text()).toContain("abgelaufen");
  });

  it("lehnt einen fehlenden Code ab", async () => {
    const e = testEnv();
    const state = generateToken();
    const antwort = await handleAuthCallback(
      callbackAnfrage({ state, cookieState: state }),
      e
    );
    expect(antwort.status).toBe(400);
  });

  // REGRESSION: Der State ist nur einmal nutzbar, weil handleAuthCallback
  // das Cookie in JEDER Antwort loescht (Max-Age=0) - ein echter Browser
  // wuerde es beim naechsten Versuch also nicht mehr mitschicken. Diese
  // zweite Anfrage simuliert genau das: derselbe Query-State, aber kein
  // Cookie mehr (wie nach dem Loeschen durch die erste Antwort).
  it("der State ist nach einem abgeschlossenen Callback nicht erneut nutzbar", async () => {
    const e = testEnv();
    const state = generateToken();
    mockTokenTausch();
    mockHelixUsers("streamer_y", "888");

    await handleAuthCallback(callbackAnfrage({ code: "abc", state, cookieState: state }), e);
    const zweite = await handleAuthCallback(callbackAnfrage({ code: "abc", state }), e);
    expect(zweite.status).toBe(400);
  });

  // REGRESSION (Befund 1): Genau der vom Reviewer verifizierte Angriff -
  // ein State aus einer fremden Anfrage (kein Cookie im Opfer-Browser) darf
  // nicht eingeloest werden koennen, selbst mit korrektem `code`.
  it("REGRESSION Befund 1: lehnt einen gueltigen State ohne das zugehoerige Cookie ab (State-Fixation-Angriff)", async () => {
    const e = testEnv();
    const state = generateToken();

    const antwort = await handleAuthCallback(
      callbackAnfrage({ code: "angreifer-code", state }), // kein cookieState
      e
    );
    expect(antwort.status).toBe(400);
    expect(await antwort.text()).toContain("abgelaufen");
  });

  it("lehnt ab, wenn das Cookie einen anderen Wert hat als der Query-State", async () => {
    const e = testEnv();
    const antwort = await handleAuthCallback(
      callbackAnfrage({ code: "abc", state: "state-a", cookieState: "state-b" }),
      e
    );
    expect(antwort.status).toBe(400);
    expect(await antwort.text()).toContain("abgelaufen");
  });

  it("lehnt ab, wenn der Query-State ganz fehlt, selbst mit passendem Cookie", async () => {
    const e = testEnv();
    const state = generateToken();
    const antwort = await handleAuthCallback(
      callbackAnfrage({ code: "abc", cookieState: state }),
      e
    );
    expect(antwort.status).toBe(400);
  });

  it("loescht das State-Cookie nach dem Callback (Erfolgsfall)", async () => {
    const e = testEnv();
    const state = generateToken();
    mockTokenTausch();
    mockHelixUsers("streamer_cookie", "777");

    const antwort = await handleAuthCallback(
      callbackAnfrage({ code: "abc", state, cookieState: state }),
      e
    );
    const cookie = antwort.headers.get("Set-Cookie");
    expect(cookie).toMatch(new RegExp(`^${STATE_COOKIE_NAME}=;`));
    expect(cookie).toMatch(/Max-Age=0/);
    expect(cookie).not.toContain(state);
  });

  it("loescht das State-Cookie auch im Fehlerfall (fehlendes Cookie)", async () => {
    const antwort = await handleAuthCallback(
      callbackAnfrage({ code: "abc", state: "irrelevant" }),
      testEnv()
    );
    const cookie = antwort.headers.get("Set-Cookie");
    expect(cookie).toMatch(new RegExp(`^${STATE_COOKIE_NAME}=;`));
    expect(cookie).toMatch(/Max-Age=0/);
  });

  it("REGRESSION: liefert eine Fehlerseite statt abzustuerzen, wenn Twitch unerwartete Kontodaten liefert", async () => {
    const e = testEnv();
    const state = generateToken();
    mockTokenTausch();
    // Ungueltiges Login-Format (Doppelpunkt kollidiert mit dem KV-Praefix-
    // Trenner) - saveChannelToken() wirft hier bewusst. Die Anfrage darf
    // trotzdem nicht mit einem nackten Worker-Fehler enden.
    mockHelixUsers("a:b", "123");

    const antwort = await handleAuthCallback(
      callbackAnfrage({ code: "abc", state, cookieState: state }),
      e
    );
    expect(antwort.status).toBe(502);
    const text = await antwort.text();
    expect(text).not.toContain("Ungueltiger channelLogin");
  });

  it("REGRESSION: gibt bei fehlgeschlagenem Token-Tausch keine internen Details preis (Client-Secret, Twitch-Fehlertext)", async () => {
    const e = testEnv();
    const state = generateToken();
    fetchMock
      .get("https://id.twitch.tv")
      .intercept({ path: "/oauth2/token", method: "POST" })
      .reply(400, { error: "invalid_grant", error_description: "client_secret=secret456 war ungueltig" });

    const antwort = await handleAuthCallback(
      callbackAnfrage({ code: "abc", state, cookieState: state }),
      e
    );
    expect(antwort.status).toBe(502);
    const text = await antwort.text();
    expect(text).not.toContain("secret456");
    expect(text).not.toContain("invalid_grant");
  });

  it("REGRESSION: escaped einen Login mit HTML-Sonderzeichen sowohl im Text als auch im data-token-Attribut-Kontext", async () => {
    const e = testEnv();
    const state = generateToken();
    mockTokenTausch();
    // Twitch-Logins koennen laut API-Vertrag keine solchen Zeichen enthalten,
    // aber die Seite darf sich nicht darauf verlassen: harter Test mit einem
    // Login, der (waere er nicht validiert) HTML injizieren wuerde.
    mockHelixUsers('"><script>alert(1)</script>', "123");

    const antwort = await handleAuthCallback(
      callbackAnfrage({ code: "abc", state, cookieState: state }),
      e
    );
    // saveChannelToken lehnt dieses Login-Format ab (CHANNEL_LOGIN_RE) -
    // die Fehlerseite darf den rohen Login trotzdem nicht ungeschuetzt einbetten.
    const text = await antwort.text();
    expect(text).not.toContain("<script>alert(1)</script>");
  });
});

describe("readStateCookie (Cookie-Header-Parsing)", () => {
  it("liest den Wert, wenn es das einzige Cookie ist", () => {
    const req = new Request("https://bot.example.dev/x", {
      headers: { Cookie: `${STATE_COOKIE_NAME}=abc123` },
    });
    expect(readStateCookie(req)).toBe("abc123");
  });

  it("findet das Cookie zwischen mehreren anderen Cookies", () => {
    const req = new Request("https://bot.example.dev/x", {
      headers: { Cookie: `foo=bar; ${STATE_COOKIE_NAME}=abc123; baz=qux` },
    });
    expect(readStateCookie(req)).toBe("abc123");
  });

  it("toleriert unregelmaessige Leerzeichen zwischen den Cookies", () => {
    const req = new Request("https://bot.example.dev/x", {
      headers: { Cookie: `foo=bar;${STATE_COOKIE_NAME}=abc123;   baz=qux` },
    });
    expect(readStateCookie(req)).toBe("abc123");
  });

  it("liefert null, wenn der Cookie-Header ganz fehlt", () => {
    const req = new Request("https://bot.example.dev/x");
    expect(readStateCookie(req)).toBeNull();
  });

  it("liefert null, wenn das gesuchte Cookie nicht dabei ist", () => {
    const req = new Request("https://bot.example.dev/x", {
      headers: { Cookie: "foo=bar; baz=qux" },
    });
    expect(readStateCookie(req)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sprache. Die Seiten dieses Flows sind die einzigen Texte, die der Worker
// selbst anzeigt - sie sollen der im ZENdomizer eingestellten Sprache folgen.
// Der Wert reist im State mit, weil Twitch nur diesen unveraendert zurueckgibt.
// ---------------------------------------------------------------------------
describe("Sprache im Auth-Flow", () => {
  async function startMit(query) {
    return handleAuthStart(
      new Request(`https://bot.example.dev/auth/start${query}`),
      { ...env, TWITCH_CLIENT_ID: "client123" }
    );
  }

  it("stellt die Sprache dem State voran", async () => {
    const antwort = await startMit("?lang=en");
    const state = new URL(antwort.headers.get("Location")).searchParams.get("state");
    expect(state.startsWith("en.")).toBe(true);
    // Das Cookie traegt denselben vollstaendigen Wert - sonst schluege der
    // Vergleich im Callback fehl.
    expect(antwort.headers.get("Set-Cookie")).toContain(`${STATE_COOKIE_NAME}=${state};`);
  });

  it("faellt ohne Angabe und bei Unsinn auf Deutsch zurueck", async () => {
    for (const query of ["", "?lang=", "?lang=klingon", "?lang=de"]) {
      const antwort = await startMit(query);
      const state = new URL(antwort.headers.get("Location")).searchParams.get("state");
      expect(state.startsWith("de."), `bei "${query}"`).toBe(true);
    }
  });

  it("liefert die Erfolgsseite in der Sprache des State", async () => {
    const e = testEnv();
    const state = `en.${generateToken()}`;
    mockTokenTausch();
    mockHelixUsers("streamer_en", "1234");

    const antwort = await handleAuthCallback(callbackAnfrage({ code: "abc", state, cookieState: state }), e);
    const html = await antwort.text();

    expect(html).toContain('<html lang="en"');
    expect(html).toContain("is now connected");
    expect(html).toContain("Copy to clipboard");
    expect(html).not.toContain("Zwischenablage");
  });

  it("liefert auch die Fehlerseiten uebersetzt", async () => {
    const state = `en.${generateToken()}`;
    // Cookie fehlt -> "Sitzung abgelaufen", trotzdem auf Englisch
    const antwort = await handleAuthCallback(callbackAnfrage({ code: "abc", state }), testEnv());
    const html = await antwort.text();

    expect(antwort.status).toBe(400);
    expect(html).toContain('<html lang="en"');
    expect(html).toContain("Session expired");
  });

  it("bleibt bei manipulierter Sprache im State auf Deutsch", async () => {
    const state = `<script>.${generateToken()}`;
    const antwort = await handleAuthCallback(callbackAnfrage({ code: "abc", state }), testEnv());
    const html = await antwort.text();

    expect(html).toContain('<html lang="de"');
    expect(html).not.toContain("<script>.");
  });
});

describe("Token-Seite", () => {
  it("bietet einen Knopf zum Kopieren an", async () => {
    const e = testEnv();
    const state = `de.${generateToken()}`;
    mockTokenTausch();
    mockHelixUsers("streamer_kopie", "555");

    const html = await (await handleAuthCallback(callbackAnfrage({ code: "abc", state, cookieState: state }), e)).text();

    expect(html).toContain('id="kopieren"');
    expect(html).toContain("In die Zwischenablage kopieren");
    expect(html).toContain("navigator.clipboard");
  });

  it("nennt den Token genau einmal", async () => {
    const e = testEnv();
    const state = `de.${generateToken()}`;
    mockTokenTausch();
    mockHelixUsers("streamer_einmal", "556");

    const html = await (await handleAuthCallback(callbackAnfrage({ code: "abc", state, cookieState: state }), e)).text();
    const token = html.match(/<code id="token">([A-Za-z0-9_-]{43})<\/code>/)[1];

    expect(html.split(token).length - 1).toBe(1);
  });
});
