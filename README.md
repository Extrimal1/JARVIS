# J.A.R.V.I.S. — Personal AI Workspace

Persönlicher KI-Assistent für Studium, Aufgaben, Termine, Finanzen,
Freizeit, Gedächtnis und Vorlesungen. Deutschsprachige UI in
dunklem Navy/Cyan-Design, responsiv vom Handy bis zum Desktop.

- **Lokal-first:** Ohne Konfiguration läuft alles im Browser
  (localStorage/IndexedDB) — kein Konto nötig.
- **Cloud-Modus:** Supabase-Backend mit Login, Synchronisierung und
  Morning Briefing per Web Push. Vorlesungs-Audio bleibt immer lokal.
- **Assistent:** Deutsch/Russisch-Sprachsteuerung mit eingebauter
  Heuristik (Standard) oder lokalem Ollama-Modell — ohne bezahlte APIs.

## Start

```bash
cd jarvis
npm install
cp .env.example .env.local
npm run dev
```

Setup im Detail: [docs/SETUP.md](docs/SETUP.md).
Morning Briefing: [docs/BRIEFING_SETUP.md](docs/BRIEFING_SETUP.md).

## Prüfen

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```
