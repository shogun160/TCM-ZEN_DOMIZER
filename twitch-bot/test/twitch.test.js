import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { getValidAccessToken } from "../src/twitch.js";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

function mockTokenRefresh() {
  fetchMock
    .get("https://id.twitch.tv")
    .intercept({ path: "/oauth2/token", method: "POST" })
    .reply(200, { access_token: "frisches-access-token", refresh_token: "frisches-refresh-token", expires_in: 3600 });
}

// Befund B (Sicherheitsreview): wirft env.TWITCH_TOKENS.put() nach einem
// erfolgreichen Refresh, ging der frisch rotierte Refresh-Token bislang
// verloren, OBWOHL Twitch den alten bereits entwertet hat - der Bot faellt
// dann fuer alle Nutzer aus. Die laufende Anfrage soll trotzdem gelingen
// (das frische Access-Token existiert ja bereits), nur der KV-Schreibfehler
// muss laut geloggt werden.
describe("getValidAccessToken: KV-put()-Fehler nach Token-Refresh (Befund B)", () => {
  it("liefert das frische Access-Token zurueck, auch wenn env.TWITCH_TOKENS.put() wirft", async () => {
    mockTokenRefresh();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const kaputtesKv = {
      get: (...args) => env.TWITCH_TOKENS.get(...args),
      put: async () => {
        throw new Error("KV down");
      },
    };
    const testEnv = {
      TWITCH_TOKENS: kaputtesKv,
      TWITCH_CLIENT_ID: "client123",
      TWITCH_CLIENT_SECRET: "secret456",
      TWITCH_BOT_INITIAL_REFRESH_TOKEN: "start-refresh-token",
    };

    const token = await getValidAccessToken(testEnv);

    expect(token).toBe("frisches-access-token");
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
