/**
 * Einmalige Kanal-Verbindung per Twitch-OAuth.
 *
 * Der Scope bleibt bewusst leer: Fuer den Identitaetsnachweis genuegt der
 * Aufruf von /helix/users mit dem User-Token. Der Streamer sieht auf der
 * Twitch-Seite entsprechend "keine besonderen Berechtigungen".
 */

import { generateToken, saveChannelToken } from "./tokens.js";

// Befund 1+2 (Sicherheitsreview): der State wurde frueher im KV abgelegt
// (createState/consumeState) - das band ihn an nichts weiter als "existiert
// im KV", nicht an den Browser, der /auth/start aufgerufen hatte. Ein State
// aus einer FREMDEN /auth/start-Anfrage liess sich daher in einer voellig
// unabhaengigen Callback-Anfrage einloesen (State-Fixation). Ausserdem war
// jeder GET auf /auth/start ein unauthentifizierter KV-Write - ein einzelnes
// <img src="/auth/start"> auf einer fremden Seite haette das KV-Freetier-
// Tageskontingent erschoepfen und den Bot komplett lahmlegen koennen.
//
// Der Ersatz ist ein zustandsloses Double-Submit-Cookie: /auth/start setzt
// den State sowohl in die Redirect-URL als auch als HttpOnly-Cookie fuer die
// Worker-Origin. /auth/callback verlangt, dass Query-State und Cookie-Wert
// uebereinstimmen. Ein Angreifer kann im Browser des Opfers weder das Cookie
// setzen (SameSite=Lax, HttpOnly, __Host-Praefix schliesst Domain/Subdomain-
// Tricks aus) noch den Wert erraten (43 Zeichen aus crypto.getRandomValues).
// Kein KV-Write mehr auf /auth/start - Befund 2 damit ebenfalls behoben.
const STATE_COOKIE_NAME = "__Host-zd_state";
const STATE_COOKIE_TTL_SECONDS = 600;

export async function handleAuthStart(request, env) {
  const origin = new URL(request.url).origin;
  const state = generateToken();

  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    redirect_uri: `${origin}/auth/callback`,
    response_type: "code",
    scope: "",
    state,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://id.twitch.tv/oauth2/authorize?${params.toString()}`,
      "Set-Cookie": `${STATE_COOKIE_NAME}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${STATE_COOKIE_TTL_SECONDS}`,
    },
  });
}

export async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = readStateCookie(request);

  // Der State-Vergleich steht IMMER zuerst - unabhaengig davon, ob der Rest
  // der Anfrage gueltig ist. Ein simpler ===-Vergleich (statt zeitkonstant)
  // reicht hier aus: es gibt kein serverseitig gehaltenes Geheimnis, gegen
  // das ein Angreifer byteweise per Timing raten koennte - beide Werte
  // (Cookie UND Query-State) stammen aus DERSELBEN Anfrage, die der
  // Angreifer selbst formuliert. Er kennt also in jeder eigenen Anfrage
  // ohnehin beide Seiten des Vergleichs; ein Timing-Seitenkanal wuerde ihm
  // nichts verraten, das er nicht schon weiss. Das eigentliche Geheimnis ist
  // der Cookie-Wert im Browser DES OPFERS - den bekommt der Angreifer weder
  // durch Raten noch durch Timing zu fassen, weil er ihn dem Server niemals
  // vorlegen kann (HttpOnly + SameSite=Lax + __Host-Praefix).
  if (!state || !cookieState || cookieState !== state) {
    return mitGeloeschtemStateCookie(htmlSeite(400, "Sitzung abgelaufen",
      "Dieser Autorisierungsversuch ist abgelaufen oder wurde bereits verwendet. Bitte erneut starten."));
  }

  if (!code) {
    return mitGeloeschtemStateCookie(htmlSeite(400, "Autorisierung unvollstaendig",
      "Twitch hat keinen Autorisierungscode zurueckgegeben. Bitte den Vorgang erneut starten."));
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
    return mitGeloeschtemStateCookie(htmlSeite(502, "Verbindung fehlgeschlagen",
      "Die Anmeldung konnte nicht abgeschlossen werden. Bitte versuche es in ein paar Minuten erneut. " +
      "Falls das Problem bestehen bleibt, kontaktiere den Botbetreiber."));
  }

  return mitGeloeschtemStateCookie(htmlSeite(200, "Kanal verbunden", null, { login, token }));
}

/**
 * Liest den State-Cookie robust aus dem Cookie-Header.
 *
 * Der Header kann mehrere durch ";" getrennte Cookies enthalten, mit
 * uneinheitlichen Leerzeichen ("a=1;b=2" ebenso wie "a=1;  b=2"), oder ganz
 * fehlen (kein Cookie-Header gesetzt). Alle drei Faelle werden hier
 * abgedeckt und in test/auth.test.js direkt getestet.
 */
export function readStateCookie(request) {
  const header = request.headers.get("Cookie");
  if (!header) return null;

  for (const teil of header.split(";")) {
    const trennstelle = teil.indexOf("=");
    if (trennstelle === -1) continue;
    const name = teil.slice(0, trennstelle).trim();
    if (name === STATE_COOKIE_NAME) return teil.slice(trennstelle + 1).trim();
  }
  return null;
}

/**
 * Haengt an JEDE Antwort von handleAuthCallback (Erfolg wie Fehlerfall) ein
 * Set-Cookie an, das das State-Cookie sofort ablaufen laesst - der State ist
 * ohnehin nur fuer genau diesen einen Versuch gedacht. Baut dafuer bewusst
 * eine NEUE Response mit einem aus response.headers kopierten Headers-
 * Objekt, statt htmlSeite() direkt zusaetzliche Header uebergeben zu lassen:
 * htmlSeite() setzt seinen "headers"-Objektliteral selbst und wuerde ein
 * zusaetzlich hineingereichtes Set-Cookie sonst leicht wieder verlieren,
 * wenn die Objekte an der falschen Stelle gemergt werden.
 */
function mitGeloeschtemStateCookie(response) {
  const headers = new Headers(response.headers);
  headers.append(
    "Set-Cookie",
    `${STATE_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
  );
  return new Response(response.body, { status: response.status, headers });
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
