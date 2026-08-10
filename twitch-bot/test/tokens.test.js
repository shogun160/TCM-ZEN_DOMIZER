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
