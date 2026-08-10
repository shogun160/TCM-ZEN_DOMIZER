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
