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
  // REGRESSION (Befund 4): request.json() liefert bei einem Body, der aus
  // dem Wort "null" besteht, den Wert `null` zurueck (gueltiges JSON!) -
  // kein Parse-Fehler, also nicht vom try/catch um request.json() erfasst.
  // Der direkt folgende Zugriff body.token wuerde ausserhalb jedes
  // try-Blocks werfen (TypeError) und als nackter Cloudflare-500 ohne
  // CORS-Header enden.
  it("lehnt einen null-JSON-Body mit 400 ab, statt abzustuerzen", async () => {
    const antwort = await worker.fetch(
      new Request("https://bot.example.dev/announce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "null",
      }),
      testEnv()
    );
    expect(antwort.status).toBe(400);
    const payload = await antwort.json();
    expect(payload.success).toBe(false);
  });

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
    expect(gesendetesBody.message).toBe("🎲 ZENdomizer: ➊ Hypercar: Pfister Comet (2021)");
  });

  it("stellt einen mitgeschickten Modifikator der Nachricht voran", async () => {
    const e = testEnv();
    await botTokenSetzen(e);
    const token = await saveChannelToken(e, { channelLogin: "kanal_eins", channelId: "111" });

    let gesendetesBody = null;
    fetchMock.get("https://api.twitch.tv")
      .intercept({ path: "/helix/chat/messages", method: "POST" })
      .reply(200, (opts) => {
        gesendetesBody = JSON.parse(opts.body);
        return { data: [{ is_sent: true, message_id: "msg-mod" }] };
      });

    await worker.fetch(anfrage({ token, draw: DRAW, modifier: "no_collision" }), e);

    expect(gesendetesBody.message).toBe("🎲 ZENdomizer - No Collision 👻: ➊ Hypercar: Pfister Comet (2021)");
  });

  it("laesst die Ziehung durch, wenn der Modifikator unbekannt ist", async () => {
    const e = testEnv();
    await botTokenSetzen(e);
    const token = await saveChannelToken(e, { channelLogin: "kanal_eins", channelId: "111" });

    let gesendetesBody = null;
    fetchMock.get("https://api.twitch.tv")
      .intercept({ path: "/helix/chat/messages", method: "POST" })
      .reply(200, (opts) => {
        gesendetesBody = JSON.parse(opts.body);
        return { data: [{ is_sent: true, message_id: "msg-mod2" }] };
      });

    // Freitext im modifier-Feld darf weder im Chat landen noch die Ziehung kippen
    const antwort = await worker.fetch(anfrage({ token, draw: DRAW, modifier: "BESUCHT MEINEN KANAL" }), e);

    expect(antwort.status).toBe(200);
    expect(gesendetesBody.message).toBe("🎲 ZENdomizer: ➊ Hypercar: Pfister Comet (2021)");
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

  // REGRESSION: Der alte Router pruefte den Pfad bei POST-Anfragen nicht
  // gegen - jeder unbekannte POST-Pfad (z.B. versehentlich /auth/start)
  // waere still in handleAnnounce() gelandet. Das war unbeabsichtigt.
  it("lehnt POST auf /auth/start ab, statt es als /announce zu behandeln", async () => {
    const antwort = await worker.fetch(
      new Request("https://bot.example.dev/auth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "irrelevant", draw: DRAW }),
      }),
      testEnv()
    );
    expect(antwort.status).toBe(404);
  });

  it("lehnt POST auf einen unbekannten Pfad mit 404 ab", async () => {
    const antwort = await worker.fetch(
      new Request("https://bot.example.dev/voellig/unbekannt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "irrelevant", draw: DRAW }),
      }),
      testEnv()
    );
    expect(antwort.status).toBe(404);
  });

  it("lehnt GET auf einen unbekannten Pfad mit 404 ab", async () => {
    const antwort = await worker.fetch(
      new Request("https://bot.example.dev/voellig/unbekannt"), testEnv()
    );
    expect(antwort.status).toBe(404);
  });

  // REGRESSION: Fehlermeldungen von getValidAccessToken()/sendChatMessage()
  // koennen `res.text()` einer Twitch-Fehlerantwort enthalten (siehe
  // src/twitch.js) - dieselbe Ueberlegung wie beim Auth-Callback
  // (src/auth.js): Details duerfen nicht 1:1 an den Aufrufer durchgereicht
  // werden, sondern nur generisch + ins Server-Log.
  it("gibt bei einem Twitch-API-Fehler beim Senden keine internen Details preis", async () => {
    const e = testEnv();
    await botTokenSetzen(e);
    const token = await saveChannelToken(e, { channelLogin: "kanal_drei", channelId: "333" });

    fetchMock.get("https://api.twitch.tv")
      .intercept({ path: "/helix/chat/messages", method: "POST" })
      .reply(500, "interner Twitch-Fehlertext mit potenziell gespiegelten Anfrageteilen");

    const antwort = await worker.fetch(anfrage({ token, draw: DRAW }), e);
    const payload = await antwort.json();

    expect(antwort.status).toBe(500);
    expect(payload.success).toBe(false);
    expect(payload.error).not.toMatch(/interner Twitch-Fehlertext/);
  });

  it("gibt bei einem Twitch-API-Fehler beim Anpinnen keine internen Details in pinError preis", async () => {
    const e = testEnv();
    await botTokenSetzen(e);
    const token = await saveChannelToken(e, { channelLogin: "kanal_vier", channelId: "444" });

    fetchMock.get("https://api.twitch.tv")
      .intercept({ path: "/helix/chat/messages", method: "POST" })
      .reply(200, { data: [{ is_sent: true, message_id: "msg-3" }] });
    fetchMock.get("https://api.twitch.tv")
      .intercept({ path: /\/helix\/chat\/pins/, method: "PUT" })
      .reply(500, "interner Pin-Fehlertext mit potenziell gespiegelten Anfrageteilen");

    const antwort = await worker.fetch(anfrage({ token, draw: DRAW, pin: true }), e);
    const payload = await antwort.json();

    expect(antwort.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.pinned).toBe(false);
    expect(payload.pinError).not.toMatch(/interner Pin-Fehlertext/);
  });
});

describe("POST /announce mit type=connected", () => {
  // Der Bestaetigungstext ist im Worker fest verdrahtet (siehe src/draw.js,
  // buildConnectedMessage()). Das Frontend darf ihn nicht mitschicken, sonst
  // waere die Freitext-Sperre wieder offen - genau das prueft dieser Block.
  it("postet die feste Bestaetigungsnachricht mit gueltigem Token", async () => {
    const e = testEnv();
    await botTokenSetzen(e);
    const token = await saveChannelToken(e, { channelLogin: "kanal_fuenf", channelId: "555" });

    let gesendetesBody = null;
    fetchMock.get("https://api.twitch.tv")
      .intercept({ path: "/helix/chat/messages", method: "POST" })
      .reply(200, (opts) => {
        gesendetesBody = JSON.parse(opts.body);
        return { data: [{ is_sent: true, message_id: "msg-connected" }] };
      });

    const antwort = await worker.fetch(anfrage({ token, type: "connected" }), e);

    expect(antwort.status).toBe(200);
    expect((await antwort.json()).success).toBe(true);
    expect(gesendetesBody.broadcaster_id).toBe("555");
    expect(gesendetesBody.message).toBe("🎲 ZENdomizer connected. Let's race. 🏁");
  });

  it("lehnt type=connected ohne Token mit 401 ab - die Token-Pruefung kommt vor allem anderen", async () => {
    const antwort = await worker.fetch(anfrage({ type: "connected" }), testEnv());
    expect(antwort.status).toBe(401);
  });

  it("ignoriert ein mitgeschicktes draw- und message-Feld bei type=connected", async () => {
    const e = testEnv();
    await botTokenSetzen(e);
    const token = await saveChannelToken(e, { channelLogin: "kanal_sechs", channelId: "666" });

    let gesendetesBody = null;
    fetchMock.get("https://api.twitch.tv")
      .intercept({ path: "/helix/chat/messages", method: "POST" })
      .reply(200, (opts) => {
        gesendetesBody = JSON.parse(opts.body);
        return { data: [{ is_sent: true, message_id: "msg-connected-2" }] };
      });

    await worker.fetch(anfrage({
      token,
      type: "connected",
      draw: DRAW,
      message: "eingeschleuster Freitext mit http://boese-seite.example",
    }), e);

    expect(gesendetesBody.message).toBe("🎲 ZENdomizer connected. Let's race. 🏁");
  });

  it("lehnt einen unbekannten type-Wert mit 400 ab, statt still auf den Ziehungspfad durchzufallen", async () => {
    const e = testEnv();
    const token = await saveChannelToken(e, { channelLogin: "kanal_sieben", channelId: "777" });

    const antwort = await worker.fetch(anfrage({ token, type: "irgendwas", draw: DRAW }), e);

    expect(antwort.status).toBe(400);
    expect((await antwort.json()).success).toBe(false);
  });
});
