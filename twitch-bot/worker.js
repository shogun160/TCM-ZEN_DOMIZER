/**
 * ZENdomizer Twitch-Bot Worker
 * -----------------------------
 * Nimmt Ziehungsergebnisse von zendomizer.html entgegen und postet sie als
 * Chat-Bot-Account in den Twitch-Chat - optional zusaetzlich angepinnt
 * (Twitch "Pin Chat Message", max. 20 Minuten, feste Twitch-Vorgabe).
 *
 * Der Zielkanal ergibt sich AUSSCHLIESSLICH aus dem mitgeschickten
 * Kanal-Token. Ein Kanalname im Request wird ignoriert - damit kann niemand
 * in fremde Kanaele posten, auch nicht mit Kenntnis der Worker-URL.
 *
 * Routen:
 *   GET  /auth/start     - leitet den Streamer zum Twitch-Login weiter
 *   GET  /auth/callback  - stellt nach erfolgreichem Login den Token aus
 *   POST /announce       - postet ein Ziehungsergebnis
 * Alle anderen Pfad/Methoden-Kombinationen werden explizit abgelehnt (siehe
 * routeAnnounce weiter unten) statt implizit auf /announce durchzufallen.
 *
 * Benoetigte Secrets (per `wrangler secret put <NAME>` setzen):
 *   TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_BOT_USER_ID,
 *   TWITCH_BOT_INITIAL_REFRESH_TOKEN, ALLOWED_ORIGIN (optional)
 * Benoetigte KV-Bindung (siehe wrangler.toml): TWITCH_TOKENS
 */

import { getValidAccessToken, sendChatMessage, pinChatMessage } from "./src/twitch.js";
import { handleAuthStart, handleAuthCallback } from "./src/auth.js";
import { resolveChannelByToken } from "./src/tokens.js";
import { validateDraw, buildMessage, buildConnectedMessage, validateFilters } from "./src/draw.js";

const PIN_DURATION_SECONDS = 1200; // 20 Minuten - Twitch-Maximum

export default {
  async fetch(request, env) {
    const pfad = new URL(request.url).pathname;

    // Die Auth-Routen liefern HTML fuer eine normale Browser-Navigation
    // (der Streamer klickt/wird umgeleitet) - keine Cross-Origin-Fetch-
    // Anfrage einer Webseite. CORS-Header steuern nur Cross-Origin
    // fetch()/XHR-Zugriffe, nicht Top-Level-Navigation, daher brauchen
    // diese Routen bewusst keine CORS-Header.
    if (request.method === "GET" && pfad === "/auth/start") {
      return handleAuthStart(request, env);
    }
    if (request.method === "GET" && pfad === "/auth/callback") {
      return handleAuthCallback(request, env);
    }

    const corsHeaders = buildCorsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Nur /announce ist eine bekannte POST-Route. Ohne diese Pruefung wuerde
    // z.B. ein POST auf /auth/start oder auf einen Tippfehler-Pfad still in
    // handleAnnounce() landen, weil der alte Router den Pfad fuer POST nie
    // gegengeprueft hat - das war unbeabsichtigt und wird hier bewusst
    // geschlossen.
    if (pfad !== "/announce") {
      return json({ success: false, error: "Nicht gefunden." }, 404, corsHeaders);
    }

    if (request.method !== "POST") {
      return json({ success: false, error: "Nur POST erlaubt." }, 405, corsHeaders);
    }

    return handleAnnounce(request, env, corsHeaders);
  },
};

async function handleAnnounce(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ success: false, error: "Ungueltiger JSON-Body." }, 400, corsHeaders);
  }

  // REGRESSION (Befund 4): request.json() liefert bei einem Body, der
  // woertlich aus "null" besteht, den Wert `null` zurueck - das ist
  // gueltiges JSON und wirft daher NICHT im try/catch oben. Ohne diese
  // Pruefung wuerde der folgende body.token-Zugriff eine unbehandelte
  // TypeError werfen (ausserhalb jedes try-Blocks) und als nackter
  // Cloudflare-500 ohne CORS-Header beim Aufrufer landen. Andere Nicht-
  // Objekte (Zahl, String, Array, Boolean) werfen bereits korrekt 401, weil
  // z.B. (123).token einfach undefined ist statt zu werfen - nur `null` und
  // `undefined` brauchen diese explizite Absicherung.
  if (!body || typeof body !== "object") {
    return json({ success: false, error: "Ungueltiger JSON-Body." }, 400, corsHeaders);
  }

  // Der Kanal kommt aus dem Token, niemals aus dem Request. Diese Pruefung
  // steht bewusst vor jeder anderen Verarbeitung (auch vor der draw-
  // Validierung): ohne gueltigen Token gibt es nichts zu tun.
  const kanal = await resolveChannelByToken(env, body.token);
  if (!kanal) {
    return json({
      success: false,
      error: "Kanal nicht verbunden. Bitte den Kanal in den Twitch-Einstellungen neu verbinden.",
      code: "token_invalid",
    }, 401, corsHeaders);
  }

  // Der "connected"-Pfad postet ausschliesslich die feste, im Worker
  // verdrahtete Bestaetigungsnachricht (buildConnectedMessage() in
  // src/draw.js) - ein mitgeschicktes draw oder message wird nicht
  // ausgewertet. Ein unbekannter type-Wert wird bewusst mit 400
  // abgelehnt statt still auf den Ziehungspfad durchzufallen: das haelt
  // den Vertrag der API eindeutig (jeder Aufrufer weiss sofort, ob sein
  // type unterstuetzt wird) und verhindert, dass ein Tippfehler im
  // Frontend unbemerkt eine Ziehungsnachricht statt der erwarteten
  // Bestaetigung postet.
  let nachricht;
  if (body.type === "connected") {
    nachricht = buildConnectedMessage();
  } else if (body.type !== undefined) {
    return json({ success: false, error: `Unbekannter Wert fuer 'type': ${JSON.stringify(body.type)}.` }, 400, corsHeaders);
  } else {
    const geprueft = validateDraw(body.draw);
    if (!geprueft.ok) {
      return json({ success: false, error: geprueft.error }, 400, corsHeaders);
    }
    // body.filters wird nur mitgeschickt, wenn die Einstellungen vom Standard
    // abweichen. Unbekannte Schluessel ignoriert validateFilters still, ein
    // Link-Muster in Marke/Land lehnt es dagegen ab - wie bei den Fahrzeugfeldern.
    const filter = validateFilters(body.filters);
    if (!filter.ok) {
      return json({ success: false, error: filter.error }, 400, corsHeaders);
    }

    // body.modifier ist ein Schluessel aus einer festen Liste, kein Text - ein
    // unbekannter Wert wird in buildMessage() still ignoriert (siehe MODIFIERS).
    nachricht = buildMessage(geprueft.items, body.modifier, filter.teile);
  }

  const shouldPin = body.pin === true;

  try {
    const accessToken = await getValidAccessToken(env);

    const sendResult = await sendChatMessage({
      broadcasterId: kanal.channel_id,
      senderId: env.TWITCH_BOT_USER_ID,
      message: nachricht,
      clientId: env.TWITCH_CLIENT_ID,
      accessToken,
    });

    if (!sendResult.is_sent) {
      const grund = sendResult.drop_reason?.message
        || "Unbekannter Grund (evtl. Bot nicht Moderator im Kanal?).";
      return json({
        success: false,
        error: `Nachricht wurde von Twitch nicht gesendet: ${grund}`,
      }, 200, corsHeaders);
    }

    let pinned = false;
    let pinError = null;
    if (shouldPin) {
      try {
        await pinChatMessage({
          broadcasterId: kanal.channel_id,
          moderatorId: env.TWITCH_BOT_USER_ID,
          messageId: sendResult.message_id,
          clientId: env.TWITCH_CLIENT_ID,
          accessToken,
          durationSeconds: PIN_DURATION_SECONDS,
        });
        pinned = true;
      } catch (e) {
        // Nachricht ist bereits gesendet - ein Pin-Fehler soll das Ergebnis
        // nicht als kompletten Fehlschlag markieren. Die Detailmeldung
        // enthaelt aber `res.text()` der Twitch-API (siehe pinChatMessage in
        // src/twitch.js) und damit potenziell von Twitch gespiegelte
        // Anfrageteile - dieselbe Ueberlegung wie beim Auth-Callback
        // (src/auth.js). Deshalb landet nur eine generische Meldung beim
        // Aufrufer, die Details gehen ins Server-Log.
        console.error("Pin fehlgeschlagen:", e);
        pinError = "Anpinnen fehlgeschlagen.";
      }
    }

    return json({
      success: true,
      channel: kanal.channel_login,
      message_id: sendResult.message_id,
      pinned,
      pinError,
    }, 200, corsHeaders);
  } catch (err) {
    // Wie im Auth-Callback (src/auth.js): Fehler aus getValidAccessToken()
    // und sendChatMessage() koennen `res.text()` einer Twitch-Fehlerantwort
    // enthalten (siehe src/twitch.js) - die kann Teile der eigenen Anfrage
    // spiegeln. Details deshalb nur ins Server-Log, nicht an den Aufrufer.
    console.error("Announce fehlgeschlagen:", err);
    return json({ success: false, error: "Nachricht konnte nicht gesendet werden." }, 500, corsHeaders);
  }
}

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
