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
