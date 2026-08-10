import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { handleAuthStart, handleAuthCallback } from "../src/auth.js";
import { createState, resolveChannelByToken } from "../src/tokens.js";

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

  it("REGRESSION: verbraucht den State auch dann, wenn 'code' fehlt - sonst waere er trotz gueltigem State erneut nutzbar", async () => {
    const e = testEnv();
    const state = await createState(e);

    // Twitch leitet z.B. auch bei abgelehnter Autorisierung auf /auth/callback
    // zurueck (error=access_denied&state=...), also ganz ohne "code".
    const ersteAntwort = await handleAuthCallback(
      new Request(`https://bot.example.dev/auth/callback?state=${state}`), e
    );
    expect(ersteAntwort.status).toBe(400);

    // Der State darf jetzt nicht mehr gueltig sein - selbst mit einem "code".
    // Es duerfen dabei KEINE fetchMock-Interceptors gebraucht werden: schlaegt
    // die State-Pruefung fehl, wird Twitch gar nicht erst kontaktiert.
    const zweiteAntwort = await handleAuthCallback(
      new Request(`https://bot.example.dev/auth/callback?code=abc&state=${state}`), e
    );
    expect(zweiteAntwort.status).toBe(400);
    expect(await zweiteAntwort.text()).toContain("abgelaufen");
  });

  it("REGRESSION: liefert eine Fehlerseite statt abzustuerzen, wenn Twitch unerwartete Kontodaten liefert", async () => {
    const e = testEnv();
    const state = await createState(e);
    mockTokenTausch();
    // Ungueltiges Login-Format (Doppelpunkt kollidiert mit dem KV-Praefix-
    // Trenner) - saveChannelToken() wirft hier bewusst. Die Anfrage darf
    // trotzdem nicht mit einem nackten Worker-Fehler enden.
    mockHelixUsers("a:b", "123");

    const antwort = await handleAuthCallback(
      new Request(`https://bot.example.dev/auth/callback?code=abc&state=${state}`),
      e
    );
    expect(antwort.status).toBe(502);
    const text = await antwort.text();
    expect(text).not.toContain("Ungueltiger channelLogin");
  });

  it("REGRESSION: gibt bei fehlgeschlagenem Token-Tausch keine internen Details preis (Client-Secret, Twitch-Fehlertext)", async () => {
    const e = testEnv();
    const state = await createState(e);
    fetchMock
      .get("https://id.twitch.tv")
      .intercept({ path: "/oauth2/token", method: "POST" })
      .reply(400, { error: "invalid_grant", error_description: "client_secret=secret456 war ungueltig" });

    const antwort = await handleAuthCallback(
      new Request(`https://bot.example.dev/auth/callback?code=abc&state=${state}`),
      e
    );
    expect(antwort.status).toBe(502);
    const text = await antwort.text();
    expect(text).not.toContain("secret456");
    expect(text).not.toContain("invalid_grant");
  });

  it("REGRESSION: escaped einen Login mit HTML-Sonderzeichen sowohl im Text als auch im data-token-Attribut-Kontext", async () => {
    const e = testEnv();
    const state = await createState(e);
    mockTokenTausch();
    // Twitch-Logins koennen laut API-Vertrag keine solchen Zeichen enthalten,
    // aber die Seite darf sich nicht darauf verlassen: harter Test mit einem
    // Login, der (waere er nicht validiert) HTML injizieren wuerde.
    mockHelixUsers('"><script>alert(1)</script>', "123");

    const antwort = await handleAuthCallback(
      new Request(`https://bot.example.dev/auth/callback?code=abc&state=${state}`),
      e
    );
    // saveChannelToken lehnt dieses Login-Format ab (CHANNEL_LOGIN_RE) -
    // die Fehlerseite darf den rohen Login trotzdem nicht ungeschuetzt einbetten.
    const text = await antwort.text();
    expect(text).not.toContain("<script>alert(1)</script>");
  });
});
