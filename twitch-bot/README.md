# ZENdomizer Twitch-Bot

Postet gezogene Fahrzeuge automatisch in den Twitch-Chat eines Kanals - optional
zusätzlich angepinnt (Twitch pinnt maximal 20 Minuten, das ist eine feste
Twitch-Vorgabe, nicht änderbar).

**Wichtig:** Dies ist bewusst *ein* gemeinsam nutzbarer Bot für alle
ZENdomizer-Nutzer. Ein Streamer, der die Funktion nutzen will, muss **nicht**
selbst eine Twitch-App registrieren oder sich einloggen - er tippt nur einmal
`/mod <BotName>` in seinem eigenen Chat ein. Der Client-Secret des Bots liegt
ausschließlich sicher im Cloudflare Worker, niemals im Frontend/Quellcode.

## Einmalige Einrichtung (nur für den, der den Bot betreibt)

### 1. Bot-Account anlegen
Auf twitch.tv einen normalen Account für den Bot erstellen (z.B.
`ZENdomizerBot`). Separater Account, nicht dein Streamer-Account.

### 2. Twitch-App registrieren
Auf https://dev.twitch.tv/console/apps mit dem Bot-Account registrieren:
- **Name:** frei wählbar (z.B. "ZENdomizer Bot")
- **OAuth Redirect URLs:** `http://localhost:3000` (wird nur für den
  einmaligen Autorisierungsschritt unten gebraucht, muss nicht wirklich
  erreichbar sein)
- **Client Type:** **Confidential** (wichtig - nur dann läuft der
  refresh_token nicht nach 30 Tagen ab, siehe Twitch-Doku zu Refresh Tokens)

Client-ID und Client-Secret notieren.

### 3. Einmalige OAuth-Autorisierung (Bot-Account)
Im Browser, eingeloggt als Bot-Account, folgende URL öffnen (Platzhalter
ersetzen):

```
https://id.twitch.tv/oauth2/authorize?client_id=DEINE_CLIENT_ID&redirect_uri=http://localhost:3000&response_type=code&scope=user:write:chat+moderator:manage:chat_messages
```

Nach Bestätigung leitet der Browser auf `http://localhost:3000/?code=XXXXX`
weiter (die Seite lädt nicht, das ist egal - der `code`-Parameter aus der
Adresszeile wird gebraucht).

Diesen Code gegen Tokens eintauschen:

```bash
curl -X POST 'https://id.twitch.tv/oauth2/token' \
  -d 'client_id=DEINE_CLIENT_ID' \
  -d 'client_secret=DEIN_CLIENT_SECRET' \
  -d 'code=DER_CODE_AUS_DER_URL' \
  -d 'grant_type=authorization_code' \
  -d 'redirect_uri=http://localhost:3000'
```

Die Antwort enthält `access_token` und `refresh_token`. Beide kurz notieren
(der `refresh_token` wird unten als Startwert gebraucht).

### 4. Bot User-ID ermitteln

```bash
curl -X GET 'https://api.twitch.tv/helix/users' \
  -H 'Authorization: Bearer DEIN_ACCESS_TOKEN_AUS_SCHRITT_3' \
  -H 'Client-Id: DEINE_CLIENT_ID'
```

Die `id` aus der Antwort ist `TWITCH_BOT_USER_ID`.

### 5. Cloudflare Worker deployen
Voraussetzung: kostenloser Cloudflare-Account + [wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/).

```bash
cd twitch-bot
wrangler login
wrangler kv namespace create TWITCH_TOKENS
# die zurückgegebene "id" in wrangler.toml bei kv_namespaces eintragen

wrangler secret put TWITCH_CLIENT_ID
wrangler secret put TWITCH_CLIENT_SECRET
wrangler secret put TWITCH_BOT_USER_ID
wrangler secret put TWITCH_BOT_INITIAL_REFRESH_TOKEN   # der refresh_token aus Schritt 3
wrangler secret put ALLOWED_ORIGIN                      # optional, z.B. https://shogun160.github.io - Enter leer lassen für offen

wrangler deploy
```

Die von `wrangler deploy` ausgegebene URL (z.B.
`https://zendomizer-twitch-bot.DEINSUBDOMAIN.workers.dev`) ist die
Worker-URL, die in Zendomizer unter den Twitch-Einstellungen eingetragen
wird (als Standard-URL im Code hinterlegbar, siehe Haupt-README).

`TWITCH_BOT_INITIAL_REFRESH_TOKEN` wird nur beim allerersten Aufruf benutzt -
danach verwaltet der Worker Token-Rotation selbständig über den
KV-Namespace (Twitch tauscht den refresh_token bei jeder Nutzung aus, der
Worker schreibt den neuen Wert automatisch zurück in KV).

## Nutzung durch einzelne Streamer (kein Setup nötig)

1. Im eigenen Twitch-Chat einmalig eintippen: `/mod ZENdomizerBot` (oder wie
   der Bot-Account heißt).
2. In Zendomizer unter Einstellungen den eigenen Twitch-Kanalnamen eintragen
   und die Twitch-Integration aktivieren.

Das war's - keine eigene Twitch-App, kein eigener OAuth-Login nötig.

## Bekannte Einschränkungen / offene Punkte

- Der Pin-Endpunkt (`PUT /helix/chat/pins`) basiert auf der aktuellen
  Twitch-API-Referenz, konnte aber mangels Testaccount nicht live
  gegengeprüft werden. Falls das Pinnen nach dem Deployment fehlschlägt,
  wird trotzdem die normale Chat-Nachricht gesendet (Pin-Fehler blockiert
  das Senden nicht) - bitte den `pinError` im Worker-Response bzw. die
  Cloudflare-Logs (`wrangler tail`) prüfen und ggf. hier melden.
- Twitch AutoMod kann einzelne Nachrichten zurückhalten
  (`drop_reason: automod_held`) - bei Fahrzeugnamen unwahrscheinlich, aber
  möglich.
- Kein eingebauter Schutz gegen Missbrauch über die Worker-URL hinaus -
  Twitch selbst verhindert das Senden aber automatisch, wenn der Bot in
  einem Kanal nicht Moderator ist.
