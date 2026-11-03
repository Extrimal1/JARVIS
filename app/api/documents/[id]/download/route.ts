import { NextResponse } from "next/server";
import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown } from "@/src/lib/api/respond";
import {
  buildDownloadHeaders,
  downloadStudyDocBytes,
} from "@/src/lib/api/modules/documents";
import { dbFromAuth } from "@/src/lib/supabase/db";

/**
 * GET the document's bytes (default) or its extracted plain text
 * (`?variant=text`). Private Storage is read server-side with the
 * caller's user JWT, so RLS applies and no token or signed URL ever
 * reaches the browser. Responses are `inline`: previews render
 * in-app, while downloads force "save" via the anchor attribute.
 */

export const GET = authed(async (request, auth, route) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const params = await route.params;
    const id = params.id ?? "";

    if (id === "") {
      return fail("bad-request", "Ungültige Anfrage.", 400);
    }

    const variant =
      new URL(request.url).searchParams.get("variant") === "text"
        ? "text"
        : "file";

    try {
      const result = await downloadStudyDocBytes(db, id, variant);

      if (result.status === "not-found") {
        return fail("not-found", "Dokument nicht gefunden.", 404);
      }

      if (result.status === "no-text") {
        return fail(
          "not-found",
          "Für dieses Dokument liegt noch kein extrahierter Text vor. Verarbeite es zuerst.",
          404,
        );
      }

      return new NextResponse(result.bytes, {
        status: 200,
        headers: buildDownloadHeaders({
          contentType: result.contentType,
          fileName: result.fileName,
          byteLength: result.bytes.byteLength,
        }),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "OBJECT_NOT_FOUND") {
        return fail(
          "not-found",
          "Die Datei fehlt im Speicher. Bitte lade das Dokument erneut hoch.",
          404,
        );
      }

      throw error;
    }
  } catch (error) {
    return failFromUnknown("documents/download", error);
  }
});
