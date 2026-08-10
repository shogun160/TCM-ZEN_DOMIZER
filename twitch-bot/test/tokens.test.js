import { describe, it, expect } from "vitest";
import { generateToken, hashToken } from "../src/tokens.js";
import { env } from "cloudflare:test";
import {
  saveChannelToken,
  resolveChannelByToken,
  createState,
  consumeState,
} from "../src/tokens.js";

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

  it("speichert den Token niemals im Klartext (weder als Schluessel noch als Wert)", async () => {
    const token = await saveChannelToken(env, { channelLogin: "kanal_c", channelId: "333" });
    const { keys } = await env.TWITCH_TOKENS.list();
    expect(keys.some(k => k.name.includes(token))).toBe(false);
    for (const k of keys) {
      const wert = (await env.TWITCH_TOKENS.get(k.name)) ?? "";
      expect(wert).not.toContain(token);
    }
  });

  it("legt Schluessel im Format token:<sha256hex> und channel:<login> an", async () => {
    const token = await saveChannelToken(env, { channelLogin: "kanal_e", channelId: "555" });
    const hash = await hashToken(token);
    const { keys } = await env.TWITCH_TOKENS.list();
    const namen = keys.map(k => k.name);
    expect(namen).toContain(`token:${hash}`);
    expect(namen).toContain("channel:kanal_e");
    expect(`token:${hash}`).toMatch(/^token:[0-9a-f]{64}$/);
  });

  it("channel:<login> zeigt nach der Erneuerung auf den neuen Hash, nicht mehr auf den alten", async () => {
    const alt = await saveChannelToken(env, { channelLogin: "kanal_d", channelId: "444" });
    const neu = await saveChannelToken(env, { channelLogin: "kanal_d", channelId: "444" });
    const zeiger = await env.TWITCH_TOKENS.get("channel:kanal_d");
    expect(zeiger).toBe(await hashToken(neu));
    expect(zeiger).not.toBe(await hashToken(alt));
  });

  it("REGRESSION Befund 1: ein verwaister token:-Eintrag ohne passenden channel:-Zeiger gilt als ungueltig", async () => {
    // Simuliert die KV-Race aus dem Review: ein token:<hash>-Eintrag existiert,
    // aber channel:<login> zeigt nicht (mehr) darauf. Miniflare kann diese Race
    // selbst nicht erzeugen, daher wird der Waisen-Eintrag hier direkt geschrieben.
    const verwaisterToken = "nie-im-kv-verankerter-token";
    const hash = await hashToken(verwaisterToken);
    await env.TWITCH_TOKENS.put(
      `token:${hash}`,
      JSON.stringify({ channel_login: "kanal_verwaist", channel_id: "999", created_at: Date.now() })
    );
    expect(await resolveChannelByToken(env, verwaisterToken)).toBeNull();
  });

  it("liefert null statt zu werfen, wenn der KV-Wert kaputtes JSON enthaelt", async () => {
    const token = "kaputtes-json-token";
    const hash = await hashToken(token);
    await env.TWITCH_TOKENS.put(`token:${hash}`, "{ das ist kein json");
    await expect(resolveChannelByToken(env, token)).resolves.toBeNull();
  });

  it("liefert null, wenn der gefundene Eintrag kein channel_login enthaelt (leeres Objekt)", async () => {
    const token = "leerer-eintrag-token";
    const hash = await hashToken(token);
    await env.TWITCH_TOKENS.put(`token:${hash}`, JSON.stringify({}));
    expect(await resolveChannelByToken(env, token)).toBeNull();
  });
});

describe("saveChannelToken Validierung (Befund 5)", () => {
  it("lehnt einen leeren channelLogin ab", async () => {
    await expect(saveChannelToken(env, { channelLogin: "", channelId: "1" })).rejects.toThrow();
  });

  it("lehnt einen fehlenden channelLogin ab", async () => {
    await expect(saveChannelToken(env, { channelId: "1" })).rejects.toThrow();
  });

  it("lehnt einen channelLogin ueber 25 Zeichen ab", async () => {
    const zuLang = "a".repeat(26);
    await expect(saveChannelToken(env, { channelLogin: zuLang, channelId: "1" })).rejects.toThrow();
  });

  it("lehnt einen channelLogin mit Doppelpunkt ab (Kollision mit dem KV-Praefix-Trenner)", async () => {
    await expect(saveChannelToken(env, { channelLogin: "a:b", channelId: "1" })).rejects.toThrow();
  });

  it("lehnt das Kelvin-Zeichen ab, das per toLowerCase() zu ASCII 'k' kollabiert", async () => {
    // U+212A KELVIN SIGN sieht aus wie ein K, ist aber kein ASCII-Zeichen -
    // "K".toLowerCase() ergibt literal "k" und wuerde sonst denselben
    // channel:k-Zeiger treffen wie der echte Kanal "k".
    const kelvin = "K";
    expect(kelvin.toLowerCase()).toBe("k");
    await expect(saveChannelToken(env, { channelLogin: kelvin, channelId: "1" })).rejects.toThrow();
  });

  it("lehnt eine nicht-numerische channelId ab", async () => {
    await expect(saveChannelToken(env, { channelLogin: "kanal_f", channelId: "abc" })).rejects.toThrow();
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

  it("unterscheidet 'fehlender Schluessel' von 'Wert ist Leerstring' (Befund 4)", async () => {
    await env.TWITCH_TOKENS.put("state:leerer-wert", "");
    expect(await consumeState(env, "leerer-wert")).toBe(true);
  });

  it("legt state:-Eintraege mit einer TTL von 600 Sekunden an", async () => {
    const vorher = Math.floor(Date.now() / 1000);
    const state = await createState(env);
    const { keys } = await env.TWITCH_TOKENS.list({ prefix: "state:" });
    const eintrag = keys.find(k => k.name === `state:${state}`);
    expect(eintrag).toBeDefined();
    expect(eintrag.expiration).toBeGreaterThanOrEqual(vorher + 600 - 5);
    expect(eintrag.expiration).toBeLessThanOrEqual(vorher + 600 + 5);
  });
});
