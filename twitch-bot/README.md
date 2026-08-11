# ZENdomizer Twitch-Bot

Postet gezogene Fahrzeuge automatisch in den Twitch-Chat eines Kanals - und
pinnt das Ergebnis dabei immer zusätzlich an (Twitch pinnt maximal 20
Minuten, das ist eine feste Twitch-Vorgabe, nicht änderbar). Die
Verbindungsbestätigung (`🎲 ZENdomizer connected. Let's race. 🏁`) wird
dagegen nie angepinnt.

**Wichtig:** Dies ist bewusst *ein* gemeinsam nutzbarer Bot für alle
ZENdomizer-Nutzer. Ein Streamer, der die Funktion nutzen will, muss **nicht**
selbst eine Twitch-App registrieren - er tippt einmal `/mod <BotName>` in
seinem eigenen Chat ein und verbindet seinen Kanal danach über den
Twitch-Login des Worker (siehe unten). Der Client-Secret des Bots liegt
ausschließlich sicher im Cloudflare Worker, niemals im Frontend/Quellcode.

Der Zielkanal einer Nachricht ergibt sich ausschließlich aus dem
Kanal-Token, das der Worker beim Verbinden ausstellt - ein `channel`-Feld im
Request wird ignoriert. Damit kann niemand in einen fremden Kanal posten,
auch nicht mit Kenntnis der Worker-URL.

## Einmalige Einrichtung (nur für den, der den Bot betreibt)

### 1. Bot-Account anlegen
Auf twitch.tv einen normalen Account für den Bot erstellen (z.B.
`ZENdomizerBot`). Separater Account, nicht dein Streamer-Account.

### 2. Twitch-App registrieren
Auf https://dev.twitch.tv/console/apps mit dem Bot-Account registrieren:
- **Name:** frei wählbar (z.B. "ZENdomizer Bot")
- **OAuth Redirect URLs:** **beide** eintragen:
  - `http://localhost:3000` (wird nur für den einmaligen
    Autorisierungsschritt in Schritt 3 unten gebraucht, muss nicht wirklich
    erreichbar sein)
  - `https://<worker>.workers.dev/auth/callback` (die tatsächliche Worker-URL
    aus Schritt 5 unten, sobald bekannt) - das ist die Redirect-URL, die
    `GET /auth/start` beim Twitch-Login jedes Streamers verwendet. Fehlt sie,
    scheitert `/auth/start` direkt bei Twitch mit `redirect_mismatch`.
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
Worker-URL. Sie muss:
- als `https://<diese-url>/auth/callback` in den OAuth Redirect URLs der
  Twitch-App stehen (siehe Schritt 2 oben), und
- als `DEFAULT_TWITCH_WORKER_URL` in `zendomizer.html` fest eingetragen sein
  (dort steht sie im Code, es gibt kein Eingabefeld dafür im Frontend).

`TWITCH_BOT_INITIAL_REFRESH_TOKEN` wird nur beim allerersten Aufruf benutzt -
danach verwaltet der Worker Token-Rotation selbständig über den
KV-Namespace (Twitch tauscht den refresh_token bei jeder Nutzung aus, der
Worker schreibt den neuen Wert automatisch zurück in KV).

## Nutzung durch einzelne Streamer (kein eigenes Twitch-App-Setup nötig)

1. Im eigenen Twitch-Chat einmalig eintippen: `/mod ZENdomizerBot` (oder wie
   der Bot-Account heißt).
2. Im ZENdomizer-Panel auf den "Twitch"-Knopf klicken, dann auf
   "Kanal verbinden" ("Connect channel"). Das öffnet in einem neuen Tab den
   Twitch-Login des Worker (`GET /auth/start`). Der angeforderte Scope ist
   leer - Twitch zeigt entsprechend "keine besonderen Berechtigungen" an.
3. Nach der Bestätigung zeigt die Twitch-Seite den verbundenen Kanalnamen
   und einen Kanal-Token an. Diesen Token kopieren und in das Token-Feld im
   ZENdomizer-Panel einfügen.
4. Erneut auf "Kanal verbinden" klicken. Da jetzt ein Token hinterlegt ist,
   sendet das den festen Bestätigungstext
   `🎲 ZENdomizer connected. Let's race. 🏁` in den eigenen Chat (nicht
   angepinnt).

Ab jetzt postet jede Ziehung automatisch (und angepinnt) ins Chat - es gibt
keinen separaten Ein/Aus-Schalter mehr, das Vorhandensein eines gültigen
Token im Panel genügt. Der Token wird nur lokal im Browser gespeichert
(`localStorage`).

Ein Kanal-Token bleibt gültig, bis er durch einen erneuten Durchlauf des
Verbindungsschritts ersetzt wird oder der Betreiber ihn im KV löscht (siehe
unten).

## Tests

```bash
cd twitch-bot
npm install
npm test
```

Läuft über Vitest mit `@cloudflare/vitest-pool-workers` (85 Tests, Stand
dieser Doku) gegen einen lokalen, isolierten KV-Store innerhalb der
Test-Runtime - weder der echte Cloudflare-Namespace noch die echte
Twitch-API werden dabei angefasst.

## KV-Inhalte (Namespace `TWITCH_TOKENS`)

- `bot_token` - Access- und Refresh-Token des Bot-Accounts selbst (siehe
  `src/twitch.js`).
- `token:<sha256hex>` - Zuordnung eines ausgestellten Kanal-Token zu seinem
  Kanal (`channel_login`, `channel_id`). Im Klartext existiert der Token nur
  beim Streamer, im KV liegt nur sein SHA-256-Hash.
- `channel:<login>` - Zeiger vom Kanal-Login auf den Hash seines aktuell
  gültigen Token. Das ist die alleinige Wahrheitsquelle: Ein
  `token:<hash>`-Eintrag zählt nur, wenn `channel:<login>` auch wirklich auf
  ihn zeigt (siehe `resolveChannelByToken` in `src/tokens.js`).

**Einem Kanal die Berechtigung entziehen:** den Schlüssel `channel:<login>`
löschen. Der zugehörige `token:<hash>`-Eintrag bleibt zwar zunächst
bestehen, zeigt danach aber ins Leere und wird von `resolveChannelByToken`
abgelehnt.

```bash
wrangler kv key list --namespace-id=<id-aus-wrangler.toml> --remote
wrangler kv key delete --namespace-id=<id-aus-wrangler.toml> --remote "channel:<login>"
```

**Achtung:** `wrangler kv key list` ohne `--remote` liest den leeren
lokalen Dev-Store und suggeriert fälschlich, es sei nichts gespeichert -
für den echten Inhalt des produktiven Namespace ist `--remote` nötig.

## Bekannte Einschränkungen / offene Punkte

- Twitch AutoMod kann einzelne Nachrichten zurückhalten
  (`drop_reason: automod_held`) - bei Fahrzeugnamen unwahrscheinlich, aber
  möglich.
- **Zeichen-Whitelist für die Fahrzeugfelder (seit 2026-08-11).**
  `category` (max. 24 Zeichen), `brand` (max. 40) und `model` (max. 64)
  erlauben nur noch Unicode-Buchstaben, -Ziffern und die Satzzeichen, die in
  `cars/vehicles.json` tatsächlich vorkommen (`- . ( ) ® / + ' ' " – :`,
  siehe `DISALLOWED_CHARS` in `src/draw.js`); alles andere wird entfernt,
  nicht abgelehnt, damit künftige Datenpflege in `vehicles.json` nicht
  versehentlich die gesamte Twitch-Funktion für betroffene Ziehungen
  lahmlegt. Zusätzlich werden URL-Muster (`://`, `www.`, Punkt-TLD-
  Kombinationen wie `.com`/`.tv`/`.io`/…) mit 400 abgelehnt. **Das
  verhindert klickbare Links, aber keinen reinen Klartext-Werbetext** -
  wer einen gültigen Kanal-Token hat, kann Buchstaben, Ziffern und die
  erlaubten Satzzeichen weiterhin frei zu Werbebotschaften kombinieren
  (z.B. "BESUCHT MEINEN KANAL"), solange kein URL-Muster erkannt wird und
  die gesenkten Feldgrenzen eingehalten werden. Die Autorisierungsgrenze
  bleibt intakt (nur der eigene Kanal ist betroffen), der Bot-Account ist
  aber weiterhin eine geteilte Ressource - Klartext-Missbrauch bleibt
  möglich und könnte im Extremfall trotzdem zur Sperre durch Twitch führen.
- **Fehlerbehandlung der Bot-Token-Rotation (seit 2026-08-11).** Wirft
  `env.TWITCH_TOKENS.put()` nach einem erfolgreichen Refresh (z.B. KV-
  Ausfall), liefert `getValidAccessToken()` trotzdem das frische
  Access-Token für die laufende Anfrage zurück und protokolliert den
  Schreibfehler laut per `console.error` - vorher ging der frisch rotierte
  Refresh-Token in diesem Fall spurlos verloren, obwohl Twitch den alten
  bereits entwertet hatte, und der Bot fiel für alle Nutzer aus.
- **Parallele Token-Rotation (entschärft seit 2026-08-11).** Twitch entwertet
  den Refresh-Token bei jeder Nutzung. Liefen zwei Refreshes gleichzeitig,
  konnte ein toter Token im KV (`bot_token`) landen - der Bot fiel dann beim
  nächsten Refresh **für alle Kanäle** aus, bis
  `TWITCH_BOT_INITIAL_REFRESH_TOKEN` von Hand neu gesetzt wurde. Drei
  Maßnahmen greifen jetzt ineinander:
  1. **Single-Flight:** Parallele Aufrufe innerhalb eines Worker-Isolates
     teilen sich einen Refresh, statt zwei zu starten. Gebündelt wird nur der
     Refresh - mehrere Kanäle ziehen weiterhin gleichzeitig und unabhängig.
  2. **Selbstheilung:** Lehnt Twitch den eigenen Refresh-Token ab, wird KV
     erneut gelesen; liegt dort inzwischen ein frisches Token, wird dieses
     genutzt.
  3. **Schreibschutz:** Steht in KV bereits ein Token mit späterem Ablauf,
     wird der eigene, ältere Stand nicht darübergeschrieben.

  **Verbleibendes Restrisiko:** Der Single-Flight wirkt nur je Isolate, und KV
  ist eventual consistent - zwei Anfragen aus verschiedenen Rechenzentren
  können weiterhin gleichzeitig refreshen. Der Bot fällt dadurch aber nicht
  mehr dauerhaft aus, sondern verliert schlimmstenfalls eine einzelne Ziehung.
  Vollständig ausschließen ließe sich das nur mit einem Durable Object als
  Serialisierungspunkt (seit April 2025 auch im Free-Plan verfügbar, bislang
  bewusst nicht umgesetzt).
- **Mehrzeilige Chat-Nachrichten sind nicht möglich.** Am 2026-08-11 live
  geprüft: Die Twitch-Chat-API nimmt `\n` innerhalb einer Nachricht nicht an
  (der Chat ist historisch IRC-basiert, dort trennt `\n` Nachrichten
  voneinander). Mehrere Ziehungs-Einträge werden deshalb einzeilig mit
  ` | ` getrennt (siehe `ITEM_SEPARATOR` in `src/draw.js`).
- Senden und Pinnen wurden am 2026-08-11 live gegen einen echten Kanal
  verifiziert.
