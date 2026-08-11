/**
 * Aufrufe gegen die Twitch-API sowie die Verwaltung des Bot-Access-Tokens.
 * Unveraendert aus worker.js uebernommen.
 */

const TOKEN_KV_KEY = "bot_token";

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
export async function getValidAccessToken(env) {
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

export async function sendChatMessage({ broadcasterId, senderId, message, clientId, accessToken }) {
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
export async function pinChatMessage({ broadcasterId, moderatorId, messageId, clientId, accessToken, durationSeconds }) {
  const params = new URLSearchParams({
    broadcaster_id: broadcasterId,
    moderator_id: moderatorId,
    message_id: messageId,
    duration_seconds: String(durationSeconds),
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
