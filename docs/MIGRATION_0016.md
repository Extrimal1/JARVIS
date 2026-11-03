# Migration 0016: Link-Ownership-Härtung (REVIEW-ONLY)

**Datei:** `supabase/migrations/0016_link_ownership.sql`
**Status:** Manuell in Supabase prüfen und anwenden — die App führt
keine Migration automatisch aus. Kein Reset, kein Delete, keine
Datenänderung: nur RLS-Policies werden neu gefasst.

## Warum

Alle Owner-Policies prüfen `auth.uid() = user_id`, aber
Fremdschlüssel-Spalten (Frage/Thema/Prüfung/Dokument/Thread/…)
wurden nicht auf Ownership geprüft. Die API-Routen validieren
Ownership serverseitig (Quiz-Config, Review-Stempelung), aber ein
Client mit eigenem User-JWT konnte per direktem PostgREST-Call
Zeilen anlegen, die *fremde* Zeilen referenzieren. Kein Datenleck
(Selects bleiben owner-only), aber fremde Links verfälschen Joins,
Zählungen und Mastery-Mathematik.

## Was sich ändert

`WITH CHECK`-Klauseln fordern zusätzlich: Referenzierte Zeilen
müssen existieren **und** dem Schreibenden gehören. Betroffen:

- `study_review_events` (Insert): Frage Pflicht-owned, Thema/Prüfung owned-oder-null
- `quiz_questions` (Insert/Update): Prüfung/Thema/Dokument
- `study_entries` (Insert/Update): `parent_id` (Topic-Baum)
- `study_summaries` (Insert/Update): Dokument
- `conversation_messages` (Insert): Thread
- `finance_transactions` (Insert/Update): Import-Batch
- `lifestyle_saved` (Insert): Ort
- Lecture-Tabellen: Sessions, Recordings, Transcript-Segmente,
  Insights, Source-Links, Processing-Jobs, Retrieval-Chunks,
  Study-Guides, Flashcards, Card-Reviews, Exam-Attempts,
  Tutor-Threads, Tutor-Messages

Select-/Delete-Policies sind unverändert (bereits owner-only).
`lecture_practice_exams.question_ids` (UUID-Array) bleibt
anwendungsseitig validiert — Arrays sind in `WITH CHECK` ohne
Hilfsfunktion nicht ownership-prüfbar, und die Tabelle hat derzeit
keine Writer-Route.

## Anwenden

1. Supabase-Dashboard → SQL-Editor → Dateiinhalt einfügen → prüfen → ausführen.
2. Oder: `supabase db push` (wenn die CLI verdrahtet ist).

## Verhalten vor dem Anwenden

Ehrliche Degradation: Die App validiert Ownership weiterhin
serverseitig in den Routen; nur der DB-Level-Schutz gegen direkte
PostgREST-Writes fehlt bis zum Anwenden. Keine Fake-Daten, keine
stillen Fehler.
