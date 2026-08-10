/**
 * ZENdomizer Twitch-Bot Worker
 * -----------------------------
 * Nimmt Ziehungsergebnisse von zendomizer.html entgegen und postet sie als
 * Chat-Bot-Account in den Twitch-Chat des angegebenen Kanals - optional
 * zusaetzlich angepinnt (Twitch "Pin Chat Message", max. 20 Minuten,
 * feste Twitch-Vorgabe, nicht konfigurierbar).
 *
 * Der Bot muss in jedem Zielkanal Moderator sein (einfach `/mod <botname>`
 * im eigenen Chat eintippen) - dann braucht der jeweilige Streamer keine
 * eigene Twitch-App/OAuth-Einrichtung. Siehe README.md in diesem Ordner.
 *
 * Benoetigte Secrets (per `wrangler secret put <NAME>` setzen):
 *   TWITCH_CLIENT_ID       - Client-ID der (Confidential-)Twitch-App
 *   TWITCH_CLIENT_SECRET   - Client-Secret der Twitch-App
 *   TWITCH_BOT_USER_ID     - Twitch User-ID des Bot-Accounts
 * Benoetigte KV-Namespace-Bindung (siehe wrangler.toml):
 *   TWITCH_TOKENS          - haelt {access_token, refresh_token, expires_at}
 *                             des Bot-Accounts. Initial befuellt via
 *                             scripts/seed-token.md (einmaliger OAuth-Schritt).
 */

import {
  getValidAccessToken,
  resolveUserId,
  sendChatMessage,
  pinChatMessage,
} from "./src/twitch.js";

const TWITCH_MAX_MESSAGE_LENGTH = 500; // von Twitch vorgegebenes Limit fuer Chat-Nachrichten

export default {
  async fetch(request, env) {
    const corsHeaders = buildCorsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return json({ success: false, error: "Nur POST erlaubt." }, 405, corsHeaders);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ success: false, error: "Ungueltiger JSON-Body." }, 400, corsHeaders);
    }

    const channel = typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "";
    const message = typeof body.message === "string" ? body.message : "";
    const shouldPin = body.pin === true;

    if (!channel) {
      return json({ success: false, error: "Feld 'channel' fehlt oder ist leer." }, 400, corsHeaders);
    }
    if (!message) {
      return json({ success: false, error: "Feld 'message' fehlt oder ist leer." }, 400, corsHeaders);
    }

    const safeMessage = message.length > TWITCH_MAX_MESSAGE_LENGTH
      ? message.slice(0, TWITCH_MAX_MESSAGE_LENGTH - 1) + "…"
      : message;

    try {
      const accessToken = await getValidAccessToken(env);

      const broadcasterId = await resolveUserId(channel, env.TWITCH_CLIENT_ID, accessToken);
      if (!broadcasterId) {
        return json({ success: false, error: `Twitch-Kanal "${channel}" wurde nicht gefunden.` }, 404, corsHeaders);
      }

      const sendResult = await sendChatMessage({
        broadcasterId,
        senderId: env.TWITCH_BOT_USER_ID,
        message: safeMessage,
        clientId: env.TWITCH_CLIENT_ID,
        accessToken,
      });

      if (!sendResult.is_sent) {
        const reason = sendResult.drop_reason?.message || "Unbekannter Grund (evtl. Bot nicht Moderator im Kanal?).";
        return json({ success: false, error: `Nachricht wurde von Twitch nicht gesendet: ${reason}` }, 200, corsHeaders);
      }

      let pinned = false;
      let pinError = null;
      if (shouldPin) {
        try {
          await pinChatMessage({
            broadcasterId,
            moderatorId: env.TWITCH_BOT_USER_ID,
            messageId: sendResult.message_id,
            clientId: env.TWITCH_CLIENT_ID,
            accessToken,
          });
          pinned = true;
        } catch (e) {
          // Nachricht wurde bereits erfolgreich gesendet - Pin-Fehler soll das
          // Gesamtergebnis nicht als kompletten Fehlschlag markieren.
          pinError = e.message || String(e);
        }
      }

      return json({ success: true, message_id: sendResult.message_id, pinned, pinError }, 200, corsHeaders);
    } catch (err) {
      return json({ success: false, error: err.message || String(err) }, 500, corsHeaders);
    }
  },
};

function buildCorsHeaders(env) {
  // ALLOWED_ORIGIN optional als Secret/Var setzbar, um den Worker auf eine
  // bestimmte Zendomizer-Instanz einzuschraenken. Ohne Angabe: offen (*).
  const origin = env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN.length > 0 ? env.ALLOWED_ORIGIN : "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
