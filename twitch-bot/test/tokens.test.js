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
