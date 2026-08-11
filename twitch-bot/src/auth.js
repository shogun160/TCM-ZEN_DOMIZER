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

// Die Oberflaechensprache reist im State mit ("de.<token>"). Sie muss den Umweg
// ueber Twitch ueberstehen, und der State ist der einzige Wert, den Twitch
// unveraendert zurueckgibt - so braucht es dafuer weder KV noch ein zweites
// Cookie. generateToken() liefert base64url (A-Za-z0-9-_), der Punkt ist also
// ein eindeutiger Trenner. Der Vergleich Cookie === Query bleibt davon
// unberuehrt: verglichen wird weiterhin der vollstaendige Wert.
const SPRACHEN = ["de", "en"];
const STANDARD_SPRACHE = "de";

function spracheAus(wert) {
  return SPRACHEN.includes(wert) ? wert : STANDARD_SPRACHE;
}

export async function handleAuthStart(request, env) {
  const url = new URL(request.url);
  const origin = url.origin;
  const lang = spracheAus(url.searchParams.get("lang"));
  const state = `${lang}.${generateToken()}`;

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
  // Die Sprache steckt im State und wird vor dem Vergleich gelesen, damit auch
  // die Fehlerseiten in der richtigen Sprache erscheinen. Der Wert ist an dieser
  // Stelle noch ungeprueft - unkritisch, weil spracheAus() nur "de" oder "en"
  // durchlaesst und die Sprache ausschliesslich die Anzeige steuert.
  const lang = spracheAus(String(state || "").split(".")[0]);

  if (!state || !cookieState || cookieState !== state) {
    return mitGeloeschtemStateCookie(htmlSeite(400, lang, "abgelaufen"));
  }

  if (!code) {
    return mitGeloeschtemStateCookie(htmlSeite(400, lang, "kein_code"));
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
    return mitGeloeschtemStateCookie(htmlSeite(502, lang, "fehlgeschlagen"));
  }

  return mitGeloeschtemStateCookie(htmlSeite(200, lang, "verbunden", { login, token }));
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

// Die Seiten dieses Flows sind die einzigen Texte, die der Worker selbst
// anzeigt - alles andere formuliert das Frontend. Sie muessen deshalb hier
// zweisprachig vorliegen; welche Sprache gilt, reist im State mit (siehe oben).
const TEXTE = {
  de: {
    verbunden_titel: "Kanal verbunden",
    verbunden_intro: (login) => `Dein Kanal <strong>${login}</strong> ist jetzt verbunden.`,
    token_intro: "Kopiere diesen Token in die Twitch-Einstellungen von ZENdomizer:",
    kopieren: "In die Zwischenablage kopieren",
    kopiert: "Kopiert!",
    kopieren_fehler: "Kopieren nicht möglich - bitte von Hand markieren",
    token_warnung: "Behandle den Token wie ein Passwort. Wer ihn hat, kann Ziehungen in deinen Chat posten. " +
      "Du kannst ihn jederzeit erneuern, indem du diese Seite noch einmal durchläufst - der alte wird dabei ungültig.",
    mod_hinweis: "Damit der Bot senden darf, muss er in deinem Chat Moderator sein:",
    abgelaufen_titel: "Sitzung abgelaufen",
    abgelaufen_text: "Dieser Autorisierungsversuch ist abgelaufen oder wurde bereits verwendet. " +
      "Das passiert auch, wenn diese Seite neu geladen wurde. Starte die Verknüpfung erneut über das " +
      "Twitch-Symbol im ZENdomizer - ein bereits erhaltener Token bleibt gültig.",
    kein_code_titel: "Autorisierung unvollständig",
    kein_code_text: "Twitch hat keinen Autorisierungscode zurückgegeben. Bitte den Vorgang erneut starten.",
    fehlgeschlagen_titel: "Verbindung fehlgeschlagen",
    fehlgeschlagen_text: "Die Anmeldung konnte nicht abgeschlossen werden. Bitte versuche es in ein paar Minuten " +
      "erneut. Falls das Problem bestehen bleibt, kontaktiere den Botbetreiber.",
  },
  en: {
    verbunden_titel: "Channel connected",
    verbunden_intro: (login) => `Your channel <strong>${login}</strong> is now connected.`,
    token_intro: "Copy this token into the Twitch settings of ZENdomizer:",
    kopieren: "Copy to clipboard",
    kopiert: "Copied!",
    kopieren_fehler: "Copying failed - please select it manually",
    token_warnung: "Treat this token like a password. Anyone who has it can post draws to your chat. " +
      "You can renew it at any time by going through this page again - the old one becomes invalid.",
    mod_hinweis: "For the bot to be allowed to send, it must be a moderator in your chat:",
    abgelaufen_titel: "Session expired",
    abgelaufen_text: "This authorization attempt has expired or was already used. This also happens if you " +
      "reloaded this page. Start the connection again via the Twitch icon in ZENdomizer - a token you already " +
      "received stays valid.",
    kein_code_titel: "Authorization incomplete",
    kein_code_text: "Twitch did not return an authorization code. Please start over.",
    fehlgeschlagen_titel: "Connection failed",
    fehlgeschlagen_text: "The sign-in could not be completed. Please try again in a few minutes. " +
      "If the problem persists, contact the bot operator.",
  },
};

function htmlSeite(status, lang, schluessel, erfolg = null) {
  const s = TEXTE[lang] || TEXTE[STANDARD_SPRACHE];
  const titel = s[`${schluessel}_titel`];

  const inhalt = erfolg
    ? `<p>${s.verbunden_intro(escapeHtml(erfolg.login))}</p>
       <p>${escapeHtml(s.token_intro)}</p>
       <code id="token">${escapeHtml(erfolg.token)}</code>
       <p><button id="kopieren" type="button"
                  data-kopiert="${escapeHtml(s.kopiert)}"
                  data-fehler="${escapeHtml(s.kopieren_fehler)}">${escapeHtml(s.kopieren)}</button></p>
       <p class="hinweis">${escapeHtml(s.token_warnung)}</p>
       <p class="hinweis">${escapeHtml(s.mod_hinweis)} <code>/mod ZENdomizerBot</code></p>
       <script>
         (function () {
           var knopf = document.getElementById("kopieren");
           var token = document.getElementById("token");
           var urspruenglich = knopf.textContent;
           knopf.addEventListener("click", function () {
             // Der Token steht im DOM, nicht in einem data-Attribut des Knopfs:
             // so gibt es ihn nur einmal auf der Seite.
             var text = token.textContent;
             function melde(meldung) {
               knopf.textContent = meldung;
               setTimeout(function () { knopf.textContent = urspruenglich; }, 2000);
             }
             if (navigator.clipboard && navigator.clipboard.writeText) {
               navigator.clipboard.writeText(text).then(
                 function () { melde(knopf.dataset.kopiert); },
                 function () { markiere(); }
               );
             } else {
               markiere();
             }
             // Fallback ohne Clipboard-API (aelterer Browser, unsicherer Kontext):
             // den Token markieren, damit Strg+C sofort greift.
             function markiere() {
               var auswahl = window.getSelection();
               var bereich = document.createRange();
               bereich.selectNodeContents(token);
               auswahl.removeAllRanges();
               auswahl.addRange(bereich);
               melde(knopf.dataset.fehler);
             }
           });
         })();
       </script>`
    : `<p>${escapeHtml(s[`${schluessel}_text`])}</p>`;

  return new Response(
    `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${escapeHtml(titel)} - ZENdomizer</title>
     <style>
       body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;
            background:#14121a;color:#eee;line-height:1.5}
       code{display:inline-block;background:#000;padding:.6rem .8rem;border-radius:.4rem;
            word-break:break-all;font-size:1.05rem}
       button{background:#9146FF;color:#fff;border:0;border-radius:.4rem;padding:.6rem 1rem;
              font:inherit;font-weight:600;cursor:pointer}
       button:hover{background:#a76bff}
       .hinweis{color:#aaa;font-size:.9rem}
     </style></head>
     <body><h1>${escapeHtml(titel)}</h1>${inhalt}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
