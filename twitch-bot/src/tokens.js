/**
 * Kanal-Tokens: Erzeugung, Hashing und KV-Zugriff.
 *
 * Im KV liegt ausschliesslich der SHA-256-Hash des Tokens - der Klartext
 * existiert nur beim Streamer. Wer KV-Inhalte einsehen kann, kann daraus
 * keine gueltigen Tokens rekonstruieren.
 */

const TOKEN_BYTES = 32;

export function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const STATE_TTL_SECONDS = 600;

/**
 * Legt einen frischen Kanal-Token an und gibt ihn im Klartext zurueck.
 * Ein zuvor fuer denselben Kanal ausgestellter Token wird dabei entwertet.
 */
export async function saveChannelToken(env, { channelLogin, channelId }) {
  const login = String(channelLogin).toLowerCase();

  const alterHash = await env.TWITCH_TOKENS.get(`channel:${login}`);
  if (alterHash) await env.TWITCH_TOKENS.delete(`token:${alterHash}`);

  const token = generateToken();
  const hash = await hashToken(token);

  await env.TWITCH_TOKENS.put(
    `token:${hash}`,
    JSON.stringify({ channel_login: login, channel_id: String(channelId), created_at: Date.now() })
  );
  await env.TWITCH_TOKENS.put(`channel:${login}`, hash);

  return token;
}

export async function resolveChannelByToken(env, token) {
  if (typeof token !== "string" || token.length === 0) return null;
  const hash = await hashToken(token);
  return await env.TWITCH_TOKENS.get(`token:${hash}`, "json");
}

export async function createState(env) {
  const state = generateToken();
  await env.TWITCH_TOKENS.put(`state:${state}`, "1", { expirationTtl: STATE_TTL_SECONDS });
  return state;
}

/** Prueft den State und verbraucht ihn dabei (einmalige Verwendung). */
export async function consumeState(env, state) {
  if (typeof state !== "string" || state.length === 0) return false;
  const key = `state:${state}`;
  const vorhanden = await env.TWITCH_TOKENS.get(key);
  if (!vorhanden) return false;
  await env.TWITCH_TOKENS.delete(key);
  return true;
}
