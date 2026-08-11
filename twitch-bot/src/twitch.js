/**
 * Aufrufe gegen die Twitch-API sowie die Verwaltung des Bot-Access-Tokens.
 * Unveraendert aus worker.js uebernommen.
 */

const TOKEN_KV_KEY = "bot_token";
const ABLAUF_PUFFER_MS = 60_000;

/**
 * Laeuft in diesem Worker-Isolate bereits ein Refresh, haengen sich weitere
 * Aufrufer an dessen Promise, statt einen zweiten Refresh zu starten
 * ("Single-Flight"). Das ist der wichtigste Schutz, denn Twitch entwertet den
 * refresh_token bei jeder Nutzung: zwei parallele Refreshes mit demselben
 * Token machen einen davon tot.
 *
 * Wichtig: gebuendelt wird nur der REFRESH, nicht die Anfragen. Mehrere
 * Kanaele ziehen weiterhin gleichzeitig und unabhaengig voneinander - sie
 * teilen sich lediglich ein Token, statt es sich gegenseitig zu entwerten.
 */
let laufenderRefresh = null;

function istVerwendbar(eintrag) {
  return !!eintrag?.access_token && eintrag.expires_at > Date.now() + ABLAUF_PUFFER_MS;
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
 *
 * VERBLEIBENDE EINSCHRAENKUNG: Der Single-Flight wirkt nur innerhalb eines
 * Isolates. Zwei Anfragen, die Cloudflare in verschiedenen Isolates oder
 * Rechenzentren bedient, koennen weiterhin gleichzeitig refreshen - KV ist
 * eventual consistent, ein frisch geschriebenes Token ist nicht sofort
 * ueberall sichtbar. Fuer diesen Fall gibt es die Selbstheilung und den
 * Schreibschutz unten: der Bot faellt dadurch nicht mehr dauerhaft aus,
 * sondern verliert im schlechtesten Fall eine einzelne Ziehung. Vollstaendig
 * ausschliessen liesse sich das nur mit einem Durable Object als
 * Serialisierungspunkt (siehe README.md, "Bekannte Einschraenkungen").
 */
export async function getValidAccessToken(env) {
  const stored = await env.TWITCH_TOKENS.get(TOKEN_KV_KEY, "json");

  if (istVerwendbar(stored)) {
    return stored.access_token;
  }

  if (!laufenderRefresh) {
    // finally() gibt das Ergebnis unveraendert weiter und raeumt den Platzhalter
    // in JEDEM Fall ab - auch nach einem Fehler, sonst haenge der naechste
    // Aufruf dauerhaft am selben gescheiterten Promise.
    laufenderRefresh = refreshBotToken(env, stored).finally(() => {
      laufenderRefresh = null;
    });
  }
  return laufenderRefresh;
}

async function refreshBotToken(env, stored) {
  const verwendeterRefreshToken = stored?.refresh_token || env.TWITCH_BOT_INITIAL_REFRESH_TOKEN;
  if (!verwendeterRefreshToken) {
    throw new Error(
      "Kein refresh_token vorhanden (weder in KV noch als TWITCH_BOT_INITIAL_REFRESH_TOKEN-Secret). " +
      "Einmalige OAuth-Erstautorisierung noetig - siehe twitch-bot/README.md."
    );
  }

  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: verwendeterRefreshToken,
  });

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();

    // Selbstheilung: Lehnt Twitch unseren refresh_token ab, hat ihn womoeglich
    // ein anderer Worker bereits verbraucht - dann liegt in KV inzwischen ein
    // frisches Token. Das ist genau der Fall, der den Bot frueher fuer alle
    // Kanaele lahmgelegt hat, bis jemand von Hand eingegriffen hat.
    const inzwischen = await env.TWITCH_TOKENS.get(TOKEN_KV_KEY, "json").catch(() => null);
    if (istVerwendbar(inzwischen) && inzwischen.refresh_token !== verwendeterRefreshToken) {
      console.warn(
        "Bot-Token-Rotation: eigener refresh_token wurde abgelehnt, in KV lag aber bereits " +
        "ein frisches Token (offenbar hat ein paralleler Aufruf rotiert). Dieses wird genutzt."
      );
      return inzwischen.access_token;
    }

    throw new Error(`Twitch Token-Refresh fehlgeschlagen (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const expiresAt = Date.now() + data.expires_in * 1000;

  // put() bewusst in try/catch: Twitch hat den REFRESH_TOKEN oben bereits
  // entwertet, das frische access_token ist also unabhaengig vom KV-Write
  // gueltig. Wirft put() (z.B. KV-Ausfall/Quota), soll die laufende Anfrage
  // trotzdem mit dem frischen Token gelingen, statt an einem Schreibfehler
  // zu scheitern - VORHER haette ein werfendes put() das return darunter nie
  // erreicht und den frisch rotierten refresh_token verloren, obwohl Twitch
  // den alten schon entwertet hatte: der Bot waere fuer ALLE Nutzer
  // ausgefallen, bis TWITCH_BOT_INITIAL_REFRESH_TOKEN manuell neu gesetzt
  // wird. console.error() macht den Ausfall trotzdem sichtbar, statt ihn
  // stillschweigend zu schlucken.
  try {
    // Schreibschutz: KV kennt kein Compare-and-Swap, es gewinnt schlicht der
    // letzte Schreibvorgang. Liegt dort inzwischen ein Token, das SPAETER
    // ablaeuft als unseres, stammt es aus einem juengeren Refresh - unseres
    // darueberzuschreiben wuerde einen bereits entwerteten refresh_token
    // festschreiben und den Bot beim naechsten Mal ausfallen lassen.
    const inzwischen = await env.TWITCH_TOKENS.get(TOKEN_KV_KEY, "json");
    if (inzwischen?.expires_at > expiresAt) {
      console.warn(
        "Bot-Token-Rotation: in KV liegt bereits ein neueres Token - der eigene, aeltere " +
        "Stand wird NICHT geschrieben. Die laufende Anfrage nutzt ihr eigenes Access-Token."
      );
    } else {
      await env.TWITCH_TOKENS.put(
        TOKEN_KV_KEY,
        JSON.stringify({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: expiresAt,
        })
      );
    }
  } catch (err) {
    console.error(
      "Bot-Token-Rotation: Schreiben des neuen refresh_token in KV fehlgeschlagen - " +
      "der alte refresh_token ist bei Twitch bereits entwertet, der neue ging NICHT " +
      "verloren (dieser Aufruf liefert das frische access_token trotzdem zurueck), " +
      "aber der naechste Refresh-Versuch wird ohne manuellen Eingriff scheitern. " +
      "Sobald KV wieder erreichbar ist, sollte zeitnah erneut ein Refresh ausgeloest " +
      "werden (z.B. durch eine echte Ziehung); haelt der Ausfall an, " +
      "TWITCH_BOT_INITIAL_REFRESH_TOKEN manuell neu setzen (siehe README.md).",
      err
    );
  }

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
    const fehler = new Error(`Twitch Send-Chat-Message-API Fehler (${res.status}): ${errText}`);
    // Der Status wandert mit, damit der Aufrufer "Bot ist kein Moderator" (403)
    // von einem allgemeinen Ausfall unterscheiden kann - der Fehlertext selbst
    // darf den Aufrufer nicht erreichen, er kann Teile der Anfrage spiegeln.
    fehler.status = res.status;
    throw fehler;
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
