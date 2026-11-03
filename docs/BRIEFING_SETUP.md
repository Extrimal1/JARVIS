# Morning Briefing — Setup (Web Push + Versand ohne PC)

Das Morgen-Briefing stellt täglich um 07:30 (Europe/Berlin, frei
konfigurierbar) Wetter, Termine, Aufgaben, Prüfungen, Wiederholungen,
Nachrichten, Finanzen und eine begründete Empfehlung zusammen — alles
aus echten Daten. Der Versand aufs Handy läuft über Web Push und einen
serverseitigen Scheduler: **Der PC muss nicht laufen**, aber die App
muss gehostet sein (z. B. Vercel) und ein externer Cron muss sie
aufwecken.

Ohne dieses Setup zeigt die Seite `/briefing` das Briefing nur im
Browser an (lokaler Modus) — Push bleibt dann ehrlich deaktiviert.

## 1. Voraussetzungen

- Cloud-Modus aktiv (`NEXT_PUBLIC_CLOUD_ENABLED=1`, Supabase konfiguriert,
  Login funktioniert).
- Supabase-Migrationen bis inkl. `0014_briefing.sql` angewendet
  (Supabase-Dashboard → SQL Editor → Dateiinhalt einfügen → ausführen).
  Bis dahin antworten die Briefing-Routen mit 503 `migration-pending`.
- App öffentlich erreichbar via HTTPS (Web Push braucht HTTPS; auf dem
  Handy dieselbe URL öffnen wie am PC).

## 2. VAPID-Schlüssel erzeugen

```bash
node scripts/generate-vapid-keys.mjs
```

Ausgabe in `.env.local` **und** in die Env-Variablen des Hosters
eintragen, dazu den Kontakt:

```bash
VAPID_PUBLIC_KEY=…
VAPID_PRIVATE_KEY=…
VAPID_SUBJECT=mailto:deine-mail@example.com
```

Danach neu deployen. Ohne diese Schlüssel antwortet
`GET /api/briefing/public-key` mit 503 und Push bleibt aus.

## 3. Cron-Secret setzen

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Als `CRON_SECRET` in `.env.local` **und** beim Hoster eintragen, neu
deployen. Der Scheduler ruft damit `POST /api/briefing/dispatch` auf.

## 4. Scheduler einrichten (eine Option wählen)

Die Dispatch-Route prüft pro Nutzer Zeitplan + Zeitzone und versendet
höchstens einmal pro Tag — sie darf daher bedenkenlos alle 5–15 Minuten
laufen. Alle Optionen rufen auf:

```text
POST https://DEINE-APP-URL/api/briefing/dispatch
Authorization: Bearer <CRON_SECRET>
```

### Option A: cron-job.org (empfohlen, gratis, hoster-unabhängig)

1. Auf [cron-job.org](https://cron-job.org) anmelden → „Create cronjob“.
2. Title: `jarvis-briefing-dispatch`.
3. URL: `https://DEINE-APP-URL/api/briefing/dispatch`.
4. „Advanced“ → Request method: `POST`.
5. „Headers“ → Add: Name `Authorization`, Value `Bearer <CRON_SECRET>`.
6. Schedule: alle 15 Minuten (`*/15 * * * *`), Zeitzone beliebig (die
   Route rechnet selbst in Nutzerzeit um).
7. Speichern, einmal „Run now“ → Status 200 erwartet:
   `{"ok":true,"data":{"checked":…,"sent":…,"failed":0,…}}`.

### Option B: Vercel Cron (nur Vercel)

`vercel.json` liegt bereits bei (`*/15 * * * *` auf
`/api/briefing/dispatch`). Vercel sendet automatisch
`Authorization: Bearer <CRON_SECRET>`, sobald die Env-Variable
`CRON_SECRET` gesetzt ist — nichts weiter zu tun außer deployen.
Hinweis: Das Zeitraster hängt vom Vercel-Plan ab (Hobby: täglich);
für engere Raster Option A oder C verwenden.

### Option C: Supabase pg_cron (alles in Supabase)

Im Supabase SQL Editor (einmalig, `APP_URL` und `CRON_SECRET` ersetzen):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'jarvis-briefing-dispatch',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://DEINE-APP-URL/api/briefing/dispatch',
    headers := jsonb_build_object(
      'Authorization', 'Bearer DEIN-CRON-SECRET'
    )
  );
  $$
);
```

Prüfen: `select * from cron.job;` — Entfernen:
`select cron.unschedule('jarvis-briefing-dispatch');`

## 5. Handy aktivieren

1. App-URL auf dem Handy öffnen (HTTPS), einloggen.
2. `/briefing` öffnen → Zeitplan prüfen (Standard 07:30 Europe/Berlin).
3. **„Dieses Gerät aktivieren“** → Mitteilungen erlauben.
4. **„Test senden“** → Push muss erscheinen. Erst wenn der Test
   `Zugestellt an 1/1` meldet (und die Nachricht ankommt), gilt Push
   als aktiv. Vorher sagt die Seite ehrlich „noch nie nachgewiesen“.

## 6. Betrieb & Fehlersuche

- Seite `/briefing` zeigt pro Gerät „zuletzt zugestellt …“ (Beleg aus
  der Datenbank, kein Schönreden).
- Tabelle `briefing_log` protokolliert jeden Versand
  (`sent`/`partial`/`failed`/`skipped` + Detail).
- Push kommt nicht an?
  1. Test auf `/briefing` senden und Ergebnis lesen.
  2. `briefing_log` der letzten Tage prüfen.
  3. Cron-Historie prüfen (cron-job.org zeigt jeden Lauf).
  4. Geräte-Einträge auf `/briefing`: abgelaufene Endpoints (404/410)
     löscht der Versand automatisch — dann Gerät neu aktivieren.
- Zeitplan greift pro Nutzer in dessen Zeitzone; deaktivierte Nutzer
  (`enabled = false`) und Nutzer ohne Gerät werden übersprungen.
- VAPID-Schlüssel jemals rotieren: neue erzeugen, deployen, **alle**
  Geräte neu aktivieren (alte Subscriptions werden ungültig).
