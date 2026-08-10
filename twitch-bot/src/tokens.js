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

// Login-Validierung laeuft bewusst auf dem ROHEN (noch nicht kleingeschriebenen)
// Input: Twitch-Logins sind reines ASCII ([A-Za-z0-9_]). Wuerde man erst
// String(...).toLowerCase() aufrufen und danach gegen /^[a-z0-9_]+$/ pruefen,
// entkommt U+212A KELVIN SIGN der Pruefung, weil "K".toLowerCase() (Kelvin)
// zu literal ASCII "k" kollabiert - die Pruefung saehe dann einen bereits
// "sauberen" String und wuerde den Kanal-Zeiger des echten Kanals "k" kapern.
// Deshalb: erst validieren, dann erst kleinschreiben.
const CHANNEL_LOGIN_RE = /^[A-Za-z0-9_]{1,25}$/;
const CHANNEL_ID_RE = /^\d+$/;

/**
 * Legt einen frischen Kanal-Token an und gibt ihn im Klartext zurueck.
 * Ein zuvor fuer denselben Kanal ausgestellter Token wird dabei entwertet.
 */
export async function saveChannelToken(env, { channelLogin, channelId }) {
  if (typeof channelLogin !== "string" || !CHANNEL_LOGIN_RE.test(channelLogin)) {
    throw new Error(`Ungueltiger channelLogin: ${JSON.stringify(channelLogin)}`);
  }
  const login = channelLogin.toLowerCase();

  const id = String(channelId);
  if (!CHANNEL_ID_RE.test(id)) {
    throw new Error(`Ungueltige channelId: ${JSON.stringify(channelId)}`);
  }

  const alterHash = await env.TWITCH_TOKENS.get(`channel:${login}`);

  const token = generateToken();
  const hash = await hashToken(token);

  // Reihenfolge ist sicherheitsrelevant (Befund 1): erst den neuen Token
  // schreiben, dann den Kanal-Zeiger umbiegen (das ist der Commit-Punkt),
  // und ERST DANACH den alten Token loeschen. Bricht der Ablauf vor dem
  // Commit-Punkt ab, bleibt der alte Token weiter gueltig statt dass der
  // Kanal ohne funktionierenden Token dasteht.
  await env.TWITCH_TOKENS.put(
    `token:${hash}`,
    JSON.stringify({ channel_login: login, channel_id: id, created_at: Date.now() })
  );
  await env.TWITCH_TOKENS.put(`channel:${login}`, hash);

  if (alterHash) await env.TWITCH_TOKENS.delete(`token:${alterHash}`);

  return token;
}

/**
 * Loest einen Token zum zugehoerigen Kanal auf.
 *
 * Cloudflare KV ist eventual consistent (auch fuer delete()), daher gilt
 * channel:<login> als alleinige Wahrheitsquelle: ein token:<hash>-Eintrag
 * zaehlt nur, wenn der aktuelle Kanal-Zeiger auch wirklich auf ihn zeigt.
 * So werden ueberholte oder verwaiste Eintraege sicher abgelehnt (Befund 1).
 */
export async function resolveChannelByToken(env, token) {
  if (typeof token !== "string" || token.length === 0) return null;
  const hash = await hashToken(token);
  const eintrag = await env.TWITCH_TOKENS.get(`token:${hash}`, "json").catch(() => null);
  if (!eintrag?.channel_login) return null;
  const aktuellerHash = await env.TWITCH_TOKENS.get(`channel:${eintrag.channel_login}`);
  if (aktuellerHash !== hash) return null;
  return eintrag;
}

export async function createState(env) {
  const state = generateToken();
  await env.TWITCH_TOKENS.put(`state:${state}`, "1", { expirationTtl: STATE_TTL_SECONDS });
  return state;
}

/**
 * Prueft den State und verbraucht ihn dabei (einmalige Verwendung).
 *
 * Achtung: Cloudflare KV ist eventual consistent, auch fuer delete(). Ein
 * Replay innerhalb des Propagationsfensters (bis zu ~60s pro PoP) kann daher
 * durchgehen. Strikte Einmaligkeit ist mit KV allein nicht erreichbar - dafuer
 * braeuchte es ein Durable Object. Diese Funktion ist eine Abschwaechung
 * gegen versehentliche Doppelverwendung, keine harte Sicherheitszusage.
 */
export async function consumeState(env, state) {
  if (typeof state !== "string" || state.length === 0) return false;
  const key = `state:${state}`;
  const vorhanden = await env.TWITCH_TOKENS.get(key);
  if (vorhanden === null) return false;
  await env.TWITCH_TOKENS.delete(key);
  return true;
}
