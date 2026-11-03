# Jarvis — Setup

Persönlicher KI-Workspace (Next.js + React + Supabase): Studium,
Aufgaben, Termine, Finanzen, Freizeit, Gedächtnis, Vorlesungen,
Assistent und Morning Briefing. UI-Sprache: Deutsch.

## Modi

- **Lokal (Standard):** Alle Daten liegen im Browser (localStorage /
  IndexedDB). Kein Login, kein Backend nötig.
- **Cloud:** Supabase-Backend mit Login, Synchronisierung und
  Web-Push-Briefing. Vorlesungs-Audio bleibt immer lokal auf dem
  Gerät (siehe Hinweis auf der Vorlesungs-Seite).

## Schnellstart lokal

```bash
cd jarvis
npm install
cp .env.example .env.local   # NEXT_PUBLIC_CLOUD_ENABLED leer lassen
npm run dev                  # http://localhost:3000
```

## Cloud-Modus einrichten

1. Supabase-Projekt anlegen (https://supabase.com) und ein Konto
   unter Authentication → Users anlegen. Es gibt keine öffentliche
   Registrierung — das Konto wird einmalig dort angelegt.
2. `.env.local` aus `.env.example` befüllen:
   - `NEXT_PUBLIC_CLOUD_ENABLED=1`
   - `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`
     (nur serverseitig verwendet), `SUPABASE_JWKS_URL`
3. Migrationen **manuell und in Reihenfolge** im Supabase-SQL-Editor
   ausführen (die App wendet nie automatisch an):
   `supabase/migrations/0001_core.sql` … `0016_link_ownership.sql`.
   Details zu den jüngsten Schritten: `docs/MIGRATION_0015.md`,
   `docs/MIGRATION_0016.md`. Bis zum Anwenden antworten
   Cloud-Routen ehrlich mit `migration-pending` (503) statt
   Fake-Daten.
4. Assistent-Anbieter wählen (`ASSISTANT_PROVIDER`):
   - `heuristic` (Standard): eingebaute Deutsch/Russisch-Regeln,
     kein Setup, keine Kosten.
   - `ollama`: lokales Modell via `OLLAMA_BASE_URL` + `OLLAMA_MODEL`.
5. Optional: Morning Briefing nach `docs/BRIEFING_SETUP.md`
   einrichten (VAPID-Schlüssel, `CRON_SECRET`, Cron-Job).
6. Optional: Transkriptions-Worker für Vorlesungen
   (`LECTURE_WORKER_URL`, `LECTURE_WORKER_TOKEN`). Ohne Worker zeigt
   die Vorlesungs-Seite ehrlich „nicht verfügbar" — nie ein
   Fake-Transkript.
7. `npm run dev` starten und unter `/login` anmelden.

## Nützliche Befehle

```bash
npm test          # Node-Testsuite (tests/*.test.ts)
npx tsc --noEmit  # Typprüfung
npm run lint      # ESLint über app/src/tests
npm run build     # Produktions-Build
```

## Sicherheit in Kürze

- Login ist ratenbegrenzt (10 Versuche / 10 Min. pro IP+Konto).
- Alle Cloud-Tabellen haben owner-only RLS; Migration 0016 härtet
  zusätzlich alle Fremdschlüssel-Links gegen direkte Writes.
- Storage-Buckets sind privat; der Browser lädt nur über signierte
  Kurzzeit-URLs hoch/herunter.
- Secrets (`*_SECRET_*`, `VAPID_PRIVATE_KEY`, `CRON_SECRET`,
  Worker-Token) sind strikt serverseitig — nie `NEXT_PUBLIC_*`.
- `.env.local` niemals committen (siehe `.gitignore`).
