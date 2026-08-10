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

const TWITCH_MAX_MESSAGE_LENGTH = 500; // von Twitch vorgegebenes Limit fuer Chat-Nachrichten
const TOKEN_KV_KEY = "bot_token";
const PIN_DURATION_SECONDS = 1200; // 20 Minuten - Twitch-Maximum fuer Pin Chat Message

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

/**
 * Liefert ein gueltiges Access-Token fuer den Bot-Account. Nutzt den in KV
 * gecachten Token, solange er noch nicht abgelaufen ist (mit 60s Puffer);
 * andernfalls wird per refresh_token ein neues Token geholt.
 *
 * WICHTIG: Twitch rotiert den refresh_token bei jeder Nutzung (der alte wird
 * ungueltig). Der neue refresh_token wird deshalb IMMER zurueck in KV
 * geschrieben - ohne das wuerde der Bot nach dem ersten Refresh dauerhaft
 * ausfallen.
 */
async function getValidAccessToken(env) {
  const stored = await env.TWITCH_TOKENS.get(TOKEN_KV_KEY, "json");

  if (stored && stored.access_token && stored.expires_at > Date.now() + 60_000) {
    return stored.access_token;
  }

  const refreshToken = stored?.refresh_token || env.TWITCH_BOT_INITIAL_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error(
      "Kein refresh_token vorhanden (weder in KV noch als TWITCH_BOT_INITIAL_REFRESH_TOKEN-Secret). " +
      "Einmalige OAuth-Erstautorisierung noetig - siehe twitch-bot/README.md."
    );
  }

  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Twitch Token-Refresh fehlgeschlagen (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const expiresAt = Date.now() + data.expires_in * 1000;

  await env.TWITCH_TOKENS.put(
    TOKEN_KV_KEY,
    JSON.stringify({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: expiresAt,
    })
  );

  return data.access_token;
}

async function resolveUserId(login, clientId, accessToken) {
  const res = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
    headers: {
      "Client-Id": clientId,
      "Authorization": `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Twitch Users-API Fehler (${res.status}).`);
  }
  const data = await res.json();
  return data.data?.[0]?.id || null;
}

async function sendChatMessage({ broadcasterId, senderId, message, clientId, accessToken }) {
  const res = await fetch("https://api.twitch.tv/helix/chat/messages", {
    method: "POST",
    headers: {
      "Client-Id": clientId,
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      broadcaster_id: broadcasterId,
      sender_id: senderId,
      message,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Twitch Send-Chat-Message-API Fehler (${res.status}): ${errText}`);
  }
  const data = await res.json();
  return data.data?.[0] || { is_sent: false };
}

/**
 * Pinnt eine bereits gesendete Nachricht an. Endpunkt-Details (PUT
 * /helix/chat/pins, Query-Parameter) basieren auf der aktuellen Twitch-API-
 * Referenz, konnten aber nicht live gegen echte Bot-Credentials getestet
 * werden (kein Testaccount verfuegbar). Bitte nach dem Deployment einmal
 * bewusst mit "Nachricht anpinnen" aktiv testen - falls der Pin-Call einen
 * Fehler wirft, wird das Senden der Nachricht selbst NICHT beeintraechtigt
 * (siehe Aufrufer), nur `pinned:false` + `pinError` im Response.
 */
async function pinChatMessage({ broadcasterId, moderatorId, messageId, clientId, accessToken }) {
  const params = new URLSearchParams({
    broadcaster_id: broadcasterId,
    moderator_id: moderatorId,
    message_id: messageId,
    duration_seconds: String(PIN_DURATION_SECONDS),
  });
  const res = await fetch(`https://api.twitch.tv/helix/chat/pins?${params.toString()}`, {
    method: "PUT",
    headers: {
      "Client-Id": clientId,
      "Authorization": `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Twitch Pin-API Fehler (${res.status}): ${errText}`);
  }
  return true;
}
