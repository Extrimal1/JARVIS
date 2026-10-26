import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import { crudHandlers, outcomeStatus } from "@/src/lib/api/crud";
import {
  isStudySection,
  studyConfig,
  type StudyRow,
} from "@/src/lib/api/modules/study";
import { dbFromAuth } from "@/src/lib/supabase/db";
import type { Entry, StudyData } from "@/src/lib/study";

const handlers = crudHandlers(studyConfig);

function toDoc(rows: StudyRow[]): StudyData {
  const doc: StudyData = { subjects: [], exams: [], topics: [], materials: [] };

  for (const row of rows) {
    const { section, ...entry } = row;
    doc[section].push(entry as Entry);
  }

  return doc;
}

/** GET /api/study → StudyData assembled from rows. */
export const GET = authed(async (_request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const outcome = await handlers.list(db);

    if (!outcome.ok) {
      return fail("bad-request", "Ungültige Anfrage.", 400);
    }

    return ok(toDoc(outcome.data as StudyRow[]));
  } catch (error) {
    return failFromUnknown("study", error);
  }
});

/** POST /api/study { section, ...entry } → created entry. */
export const POST = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const body = await readJson(request);

    if (
      typeof body !== "object" ||
      body === null ||
      !isStudySection((body as Record<string, unknown>).section)
    ) {
      return fail("bad-request", "Unbekannter Studienbereich.", 400);
    }

    const outcome = await handlers.create(db, body);
    const mapped = outcomeStatus(outcome);

    if (mapped.status === "ok" && outcome.ok) {
      return ok(outcome.data, 201);
    }

    return fail("bad-request", mapped.message, 400);
  } catch (error) {
    return failFromUnknown("study", error);
  }
});
