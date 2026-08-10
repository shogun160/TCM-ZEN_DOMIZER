/**
 * Einmalige Kanal-Verbindung per Twitch-OAuth.
 *
 * Der Scope bleibt bewusst leer: Fuer den Identitaetsnachweis genuegt der
 * Aufruf von /helix/users mit dem User-Token. Der Streamer sieht auf der
 * Twitch-Seite entsprechend "keine besonderen Berechtigungen".
 */

import { createState, consumeState, saveChannelToken } from "./tokens.js";

export async function handleAuthStart(request, env) {
  const origin = new URL(request.url).origin;
  const state = await createState(env);

  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    redirect_uri: `${origin}/auth/callback`,
    response_type: "code",
    scope: "",
    state,
  });

  return new Response(null, {
    status: 302,
    headers: { Location: `https://id.twitch.tv/oauth2/authorize?${params.toString()}` },
  });
}

export async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  // Der State wird IMMER zuerst geprueft und verbraucht - unabhaengig davon,
  // ob der Rest der Anfrage gueltig ist. Wuerde man erst den `code` pruefen
  // und bei dessen Fehlen fruehzeitig zurueckkehren, bliebe ein gueltiger
  // State liegen und waere spaeter erneut nutzbar. Twitch leitet z.B. auch
  // bei abgelehnter Autorisierung auf /auth/callback zurueck
  // (?error=access_denied&state=...) - ganz ohne "code".
  if (!(await consumeState(env, state))) {
    return htmlSeite(400, "Sitzung abgelaufen",
      "Dieser Autorisierungsversuch ist abgelaufen oder wurde bereits verwendet. Bitte erneut starten.");
  }

  if (!code) {
    return htmlSeite(400, "Autorisierung unvollstaendig",
      "Twitch hat keinen Autorisierungscode zurueckgegeben. Bitte den Vorgang erneut starten.");
  }

  let token, login;
  try {
    const accessToken = await tauscheCodeGegenToken(code, `${url.origin}/auth/callback`, env);
    const nutzer = await ermittleAngemeldetenNutzer(accessToken, env.TWITCH_CLIENT_ID);
    // Das User-Access-Token wird ab hier nicht mehr gebraucht und nirgends gespeichert.
    login = nutzer.login;

    // saveChannelToken() bewusst INNERHALB dieses try-Blocks: es wirft bei
    // unerwarteten Twitch-Kontodaten (siehe CHANNEL_LOGIN_RE/CHANNEL_ID_RE in
    // tokens.js). Ausserhalb des try-Blocks wuerde ein solcher Wurf als
    // unbehandelte Exception bis zum Worker durchschlagen - der Streamer saehe
    // dann Cloudflares nackte Fehlerseite statt einer verstaendlichen Antwort.
    token = await saveChannelToken(env, { channelLogin: nutzer.login, channelId: nutzer.id });
  } catch (err) {
    // Die Fehlermeldung wird bewusst NICHT an den Browser durchgereicht:
    // Twitch-Fehlerantworten koennen Teile des Requests spiegeln, und
    // saveChannelToken()-Fehlermeldungen enthalten die (potenziell von
    // Twitch gelieferten, also aussenstehend beeinflussbaren) Rohwerte.
    // Details landen stattdessen im Server-Log.
    console.error("auth callback fehlgeschlagen:", err);
    return htmlSeite(502, "Verbindung fehlgeschlagen",
      "Die Anmeldung konnte nicht abgeschlossen werden. Bitte versuche es in ein paar Minuten erneut. " +
      "Falls das Problem bestehen bleibt, kontaktiere den Botbetreiber.");
  }

  return htmlSeite(200, "Kanal verbunden", null, { login, token });
}

async function tauscheCodeGegenToken(code, redirectUri, env) {
  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`Token-Tausch fehlgeschlagen (${res.status}).`);

  const data = await res.json();
  return data.access_token;
}

async function ermittleAngemeldetenNutzer(accessToken, clientId) {
  const res = await fetch("https://api.twitch.tv/helix/users", {
    headers: { "Client-Id": clientId, "Authorization": `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Users-API Fehler (${res.status}).`);

  const data = await res.json();
  const nutzer = data.data?.[0];
  if (!nutzer) throw new Error("Twitch lieferte keinen Nutzer zurueck.");
  return { login: nutzer.login, id: nutzer.id };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, z => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[z]
  ));
}

function htmlSeite(status, titel, text, erfolg = null) {
  const inhalt = erfolg
    ? `<p>Dein Kanal <strong>${escapeHtml(erfolg.login)}</strong> ist jetzt verbunden.</p>
       <p>Kopiere diesen Token in die Twitch-Einstellungen von ZENdomizer:</p>
       <code data-token="${escapeHtml(erfolg.token)}">${escapeHtml(erfolg.token)}</code>
       <p class="hinweis">Behandle den Token wie ein Passwort. Wer ihn hat, kann
          Ziehungen in deinen Chat posten. Du kannst ihn jederzeit erneuern,
          indem du diese Seite noch einmal durchlaeufst - der alte wird dabei
          ungueltig.</p>
       <p class="hinweis">Damit der Bot senden darf, muss er in deinem Chat
          Moderator sein: <code>/mod ZENdomizerBot</code></p>`
    : `<p>${escapeHtml(text)}</p>`;

  return new Response(
    `<!doctype html><html lang="de"><head><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${escapeHtml(titel)} - ZENdomizer</title>
     <style>
       body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;
            background:#14121a;color:#eee;line-height:1.5}
       code{display:inline-block;background:#000;padding:.6rem .8rem;border-radius:.4rem;
            word-break:break-all;font-size:1.05rem}
       .hinweis{color:#aaa;font-size:.9rem}
     </style></head>
     <body><h1>${escapeHtml(titel)}</h1>${inhalt}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
