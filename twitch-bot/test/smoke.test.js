import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Test-Umgebung", () => {
  it("stellt die KV-Bindung TWITCH_TOKENS bereit", async () => {
    await env.TWITCH_TOKENS.put("smoke", "ok");
    expect(await env.TWITCH_TOKENS.get("smoke")).toBe("ok");
  });
});
