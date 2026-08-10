# Kanal-Token für den ZENdomizer-Twitch-Bot

**Datum:** 2026-08-11
**Status:** Entwurf, vom Betreiber freigegeben

## Problem

Der Worker nimmt heute jeden Request an, der einen Kanalnamen und einen Text
mitbringt (`twitch-bot/worker.js:46-55`). Geprüft wird nur, ob beide Felder
nicht leer sind. Wer die Worker-URL kennt, kann damit

1. in **jeden** Kanal posten, in dem der Bot Moderator ist — also in die
   Kanäle aller anderen ZENdomizer-Nutzer, und
2. **beliebigen Text** absetzen, denn `message` wird ungeprüft übernommen und
   lediglich auf 500 Zeichen gekürzt.

Beides wiegt schwer, weil der Bot in diesen Kanälen Moderator ist: Seine
Nachrichten wirken autorisiert und unterlaufen Chat-Beschränkungen wie
Slow-Mode oder Follower-Only.

Die einzige heutige Schranke ist Twitchs eigene Prüfung, ob der Bot im
Zielkanal Moderator ist. Bei einem bewusst gemeinsam genutzten Bot ist die
Menge dieser Kanäle aber genau die Menge der Nutzer — sie sind gegenseitig
ungeschützt.

## Ziel

Ein Streamer kann ausschließlich in **seinen eigenen** Kanal posten lassen,
und der Inhalt ist auf Ziehungsergebnisse begrenzt. Der Zugang bleibt
Self-Service: kein manueller Freigabeschritt durch den Betreiber.

### Nicht-Ziele

- Kein eigener Twitch-App-Eintrag für Streamer (das Kernversprechen aus
  `twitch-bot/README.md:7-11` bleibt bestehen).
- Kein Schutz gegen den Streamer selbst — wer seinen eigenen Kanal
  zuspammt, tut das auf eigene Rechnung.
- Kein Rate-Limiting (siehe „Bewusst weggelassen").

## Kernidee

**Der Kanalname verschwindet aus dem Request.** Statt `channel` schickt das
Frontend einen **Kanal-Token**; der Worker schlägt den zugehörigen Kanal
selbst nach. „In fremde Kanäle posten" ist damit nicht verboten, sondern
nicht mehr ausdrückbar — das Feld dafür existiert nicht mehr.

Den Token holt sich der Streamer per einmaligem Twitch-Login auf einer
Mini-Seite des Workers. Der Login läuft über die Twitch-App des Betreibers,
der Streamer registriert also weiterhin keine eigene.

## Architektur

Der Worker bekommt drei Routen statt einer.

| Route | Methode | Zweck |
|---|---|---|
| `/auth/start` | GET | Leitet zum Twitch-Login weiter |
| `/auth/callback` | GET | Identität prüfen, Token erzeugen, anzeigen |
| `/announce` | POST | Ziehungsergebnis posten, verlangt Token |

`POST /` (die heutige Route) entfällt.

### `/auth/start`

Erzeugt einen zufälligen `state`-Wert, legt ihn mit 600 Sekunden TTL im KV
unter `state:<wert>` ab und leitet weiter auf (`<WORKER_ORIGIN>` wird aus
`new URL(request.url).origin` abgeleitet, nicht konfiguriert):

```
https://id.twitch.tv/oauth2/authorize
  ?client_id=<TWITCH_CLIENT_ID>
  &redirect_uri=<WORKER_ORIGIN>/auth/callback
  &response_type=code
  &scope=
  &state=<wert>
```

**Der Scope bleibt leer.** Für den Identitätsnachweis genügt das: Mit dem
resultierenden User-Token liefert `GET /helix/users` ohne Parameter genau den
angemeldeten Nutzer. Der Streamer sieht auf der Twitch-Seite entsprechend
„keine besonderen Berechtigungen", was die Hürde niedrig hält.

### `/auth/callback`

1. `state` gegen KV prüfen, danach löschen. Fehlt er oder ist er abgelaufen:
   Abbruch mit Hinweisseite (Schutz gegen untergeschobene Autorisierungen).
2. `code` gegen ein User-Access-Token tauschen (`grant_type=authorization_code`).
3. `GET /helix/users` aufrufen → `login` und `id` des Streamers.
4. **Das User-Access-Token verwerfen.** Es wird nach diesem Schritt nicht mehr
   gebraucht und nirgends gespeichert.
5. Kanal-Token erzeugen, im KV ablegen (siehe unten), HTML-Seite mit dem Token
   und einer kurzen Anleitung ausliefern.

Existiert für den Kanal bereits ein Token, wird der alte Eintrag gelöscht —
ein erneuter Durchlauf erneuert den Token und entzieht dem alten die
Gültigkeit. Das ist zugleich der Widerrufsweg bei Verlust.

### `/announce`

```json
{
  "token": "…",
  "pin": true,
  "draw": [
    {"category": "Hypercar", "brand": "Pfister", "model": "Comet", "year": 2021}
  ]
}
```

Ablauf: Token hashen → KV-Lookup → Kanal ermitteln → `draw` validieren →
Nachricht bauen → senden → optional pinnen. Der bestehende Code für
Token-Refresh (`getValidAccessToken`), Senden (`sendChatMessage`) und Pinnen
(`pinChatMessage`) bleibt unverändert.

Da die Kanal-ID beim Verbinden gespeichert wird, entfällt der Aufruf von
`resolveUserId()` pro Nachricht (`worker.js:64`) — ein Twitch-API-Aufruf
weniger je Ziehung. Die Funktion selbst wird im Auth-Flow weiterverwendet
bzw. durch den dortigen `/helix/users`-Aufruf ersetzt; doppelte Logik soll
dabei nicht entstehen.

**CORS bleibt unverändert:** `buildCorsHeaders()` und das optionale
`ALLOWED_ORIGIN`-Secret gelten weiter für `/announce`. Die beiden
`/auth/*`-Routen liefern HTML für den Browser und brauchen keine
CORS-Header.

## Datenmodell (KV-Namespace `TWITCH_TOKENS`)

| Key | Wert | Zweck |
|---|---|---|
| `bot_token` | `{access_token, refresh_token, expires_at}` | unverändert, Bot-Tokens |
| `token:<sha256hex>` | `{channel_login, channel_id, created_at}` | Token → Kanal |
| `channel:<login>` | `<sha256hex>` | Kanal → Token, für Erneuerung/Widerruf |
| `state:<wert>` | `"1"`, TTL 600 s | CSRF-Schutz im OAuth-Flow |

**Der Token wird nur als SHA-256-Hash gespeichert.** Der Klartext existiert
ausschließlich beim Streamer. Wer später KV-Inhalte einsehen kann, kann daraus
keine gültigen Tokens rekonstruieren.

**`channel:<login>` ist die alleinige Wahrheitsquelle.** Ein
`token:<hash>`-Eintrag gilt nur, wenn der aktuelle Kanal-Zeiger auch wirklich
auf ihn zeigt — `resolveChannelByToken()` prüft das bei jedem Lookup gegen.
Grund: Cloudflare KV ist eventual consistent, auch beim Löschen. Hinge die
Gültigkeit allein daran, dass der alte Eintrag gelöscht wurde, könnte ein
überholter Token die Erneuerung überleben und mangels Zeiger dauerhaft
unwiderrufbar bleiben. Mit der Gegenprüfung ist ein verwaister Eintrag
wirkungslos, und `wrangler kv key delete channel:<login>` entzieht einem
Kanal vollständig die Berechtigung.

Beim Ausstellen gilt deshalb diese Reihenfolge: erst `token:<hash>` schreiben,
dann `channel:<login>` umbiegen (der Commit-Punkt), erst danach den alten
Eintrag löschen. Bricht der Vorgang vorher ab, bleibt der alte Token gültig —
besser, als den Kanal ohne funktionierenden Token zurückzulassen.

`saveChannelToken()` validiert den Login gegen `/^[A-Za-z0-9_]{1,25}$/` **vor**
dem Kleinschreiben. Umgekehrt wäre die Prüfung wirkungslos: `"K"`
(U+212A KELVIN SIGN) wird von `toLowerCase()` zu ASCII `"k"` und wäre danach
vom echten Kanal `k` nicht mehr zu unterscheiden — er könnte dessen
Kanal-Zeiger kapern.

`consumeState()` kann Einmaligkeit aus demselben Konsistenzgrund nicht
garantieren: Ein Replay innerhalb des Propagationsfensters kann durchgehen.
Der State-Parameter ist eine Abschwächung gegen versehentliche
Doppelverwendung, keine harte Zusage — dafür bräuchte es ein Durable Object.

Token-Erzeugung: 32 Byte aus `crypto.getRandomValues()`, base64url-kodiert
(43 Zeichen). Beides ist in der Workers-Runtime nativ verfügbar.

## Nachrichtenaufbau im Worker

Der Worker bildet das heutige Frontend-Format exakt nach
(`zendomizer.html:1744-1750` und `:1293-1296`):

```
🎲 ZENdomizer: <category>: <brand> <model> (<year>) | <category>: …
```

Das Jahr entfällt, wenn `year` fehlt. Kategorien bleiben Rohwerte aus
`vehicles.json` — genau wie heute, der Worker braucht damit keine
i18n-Daten. Die 500-Zeichen-Grenze wird wie bisher angewandt.

### Validierung von `draw`

- Array, 1 bis 10 Einträge
- je Eintrag `category`, `brand`, `model` als nicht-leere Strings,
  `year` optional als Zahl
- jedes Feld auf 100 Zeichen begrenzt
- Steuerzeichen und Zeilenumbrüche werden entfernt

Verstößt etwas dagegen: `400`, nichts wird gesendet. Damit lässt sich über
`draw` kein Freitext einschleusen.

## Frontend-Änderungen (`zendomizer.html`)

- Feld „Kanalname" entfällt, stattdessen: Button **„Kanal verbinden"**
  (öffnet `<workerUrl>/auth/start` in neuem Tab) und ein Token-Feld.
- Nach dem Verbinden zeigt das Panel den verbundenen Kanal an.
- `formatTwitchMessage()` entfällt — die Formatierung liegt jetzt im Worker.
- `sendTwitchAnnouncement()` schickt `{token, pin, draw}` an `/announce`;
  `draw` entsteht aus `lastSelection` durch Übernahme der Felder
  `category`, `brand`, `model`, `year`.
- localStorage: `zendomizerTwitchChannel` entfällt, `zendomizerTwitchToken`
  kommt hinzu. `zendomizerTwitchWorkerUrl`, `…Enabled` und `…Pin` bleiben.
- Neue i18n-Schlüssel in `translations/i18n.json` für die neuen Bedienelemente
  und Fehlermeldungen (DE und EN, entsprechend dem bestehenden Bestand).

## Fehlerfälle

| Situation | Antwort | Anzeige im Panel |
|---|---|---|
| Token fehlt oder unbekannt | `401` | „Kanal nicht verbunden" + Link zum Verbinden |
| `draw` fehlt oder unplausibel | `400` | allgemeiner Fehlertext |
| Bot ist kein Moderator | `200`, `success:false` | Twitchs `drop_reason`, wie heute |
| Pinnen scheitert | `200`, `success:true` | Nachricht gilt als gesendet, `pinError` gemeldet |
| `state` ungültig/abgelaufen | HTML-Hinweisseite | — |

Fehlgeschlagene Twitch-Posts stören die Ziehung weiterhin nicht
(`zendomizer.html:1794-1795`).

## Einmalige Einrichtung durch den Betreiber

In der Twitch-App auf dev.twitch.tv eine zweite OAuth-Redirect-URL eintragen:

```
https://zendomizer-twitch-bot.shogun160.workers.dev/auth/callback
```

Weitere Secrets sind nicht nötig — der Auth-Flow nutzt die bereits gesetzten
`TWITCH_CLIENT_ID` und `TWITCH_CLIENT_SECRET`.

## Migration

Das Feature ist wenige Stunden alt, praktisch ist der Betreiber der einzige
Nutzer. Ein Migrationspfad wäre Ballast: Wer eine alte Konfiguration hat,
bekommt beim ersten Versuch den `401` samt Hinweis und ist nach einem Klick
auf „Kanal verbinden" wieder betriebsbereit. Der alte localStorage-Schlüssel
`zendomizerTwitchChannel` wird ersatzlos ignoriert.

## Verifikation

Das Repo hat kein Testframework (kein `package.json`), geprüft wird daher per
`curl` gegen den deployten Worker:

1. **Ohne Token** → `401`, keine Nachricht im Chat.
2. **Mit erfundenem Token** → `401`, keine Nachricht im Chat.
3. **Mit gültigem Token** → Nachricht erscheint im Kanal des Tokens.
4. **Mit gültigem Token und zusätzlich mitgeschicktem fremden `channel`-Feld**
   → Nachricht erscheint **im Kanal des Tokens**, nicht im fremden Kanal.
   Das ist der eigentliche Beweis, dass die Lücke geschlossen ist.
5. **`draw` mit eingeschleustem Freitext** (etwa `model` mit URL und
   Zeilenumbruch) → `400` oder bereinigte Ausgabe, kein Freitext im Chat.
6. **Vollständiger Durchlauf** im Browser: verbinden, GO drücken, Ziehung
   erscheint im Chat, mit und ohne Pin.
7. **Token-Erneuerung**: erneut verbinden, alter Token muss danach `401`
   liefern.

## Bewusst weggelassen

- **Rate-Limiting pro Kanal.** Ziehungen sind selten, Twitch drosselt selbst,
  und ein entwendeter Token kann nach diesem Umbau nur noch Fahrzeuglisten
  posten. Nachrüstbar, falls es je nötig wird.
- **Betreiber-Oberfläche zum Sperren von Kanälen.** Ein Kanal lässt sich bei
  Bedarf direkt per `wrangler kv key delete` entfernen.
- **Mehrere Tokens je Kanal.** Ein Token pro Kanal genügt; ein erneuter
  Login erzeugt einen frischen.
