# Migration 0015 — Aufgaben-Fälligkeiten, Import-Hashes, Cloud-Kill-Switch

`supabase/migrations/0015_gk_additions.sql` ist wie die Vorgänger
**REVIEW-ONLY**: nach Prüfung manuell im Supabase-Dashboard (SQL Editor →
Dateiinhalt einfügen → ausführen) oder per `supabase db push` anwenden.
Nichts in der App führt die Datei automatisch aus.

Rein additiv, drei Spalten:

- `tasks.due_date` (nullable) — Fälligkeitsdatum für Aufgaben.
- `finance_import_batches.sha256` (nullable) — Datei-Hash zur
  Duplikaterkennung beim PDF-Import.
- `user_settings.memory_enabled` (NOT NULL DEFAULT true) — Cloud-Seite
  des Gedächtnis-Kill-Switches (geräteübergreifend).

Verhalten vor dem Anwenden (ehrliche Degradation, keine Fehler im
Normalbetrieb):

- Fälligkeiten funktionieren lokal, werden in der Cloud aber nicht
  gespeichert (die API sendet die Spalte nur, wenn ein Datum gesetzt
  ist).
- Der Import prüft Duplikate weiter per Dateiname + Größe; Hashes
  greifen erst nach der Migration (der Upload versucht es mit Hash
  und wiederholt einmal ohne).
- Der Kill-Switch wirkt nur auf dem jeweiligen Gerät (wie bisher);
  die Einstellungs-API behandelt die fehlende Spalte als „aktiviert“.
