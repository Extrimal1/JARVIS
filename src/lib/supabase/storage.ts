import { supaFetch, supaFetchRaw } from "./supabase";
import type { DbClient } from "./db";

/**
 * Private Storage access (server-side only). Browser uploads go through
 * signed URLs minted here; the browser never holds a token. All paths
 * are owner-scoped (`{userId}/...`) and enforced again by Storage RLS.
 */

export function ownerPath(userId: string, rest: string): string {
  const clean = rest.replace(/^\/+/, "");

  return `${userId}/${clean}`;
}

/** Short-lived signed download URL (default 5 minutes). */
export async function createSignedDownloadUrl(
  db: DbClient,
  bucket: string,
  path: string,
  expiresIn = 300,
): Promise<string> {
  const body = await supaFetch<{ signedUrl?: string; signedURL?: string }>(
    db.env,
    `/storage/v1/object/sign/${bucket}/${path}`,
    { method: "POST", token: db.token, body: { expiresIn } },
  );
  const url = body.signedUrl ?? body.signedURL ?? "";

  if (url === "") {
    throw new Error("Storage: no signed URL returned.");
  }

  return url.startsWith("http") ? url : `${db.env.url}${url}`;
}

/**
 * Signed upload URL for direct browser PUT (large files bypass the API
 * route body). Returns the URL plus an optional token the browser must
 * send back; verify the exact shape against a live project (SETUP.md).
 */
export async function createSignedUploadUrl(
  db: DbClient,
  bucket: string,
  path: string,
): Promise<{ signedUrl: string; token: string }> {
  const body = await supaFetch<{
    signedUrl?: string;
    signedURL?: string;
    token?: string;
  }>(db.env, `/storage/v1/object/upload/sign/${bucket}/${path}`, {
    method: "POST",
    token: db.token,
  });
  const url = body.signedUrl ?? body.signedURL ?? "";

  if (url === "") {
    throw new Error("Storage: no signed upload URL returned.");
  }

  return {
    signedUrl: url.startsWith("http") ? url : `${db.env.url}${url}`,
    token: body.token ?? "",
  };
}

/** Small-file fallback: proxy bytes through the API route. */
export async function uploadBytes(
  db: DbClient,
  bucket: string,
  path: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<void> {
  await supaFetch(db.env, `/storage/v1/object/${bucket}/${path}`, {
    method: "POST",
    token: db.token,
    binary: bytes,
    contentType,
    headers: { "x-upsert": "true" },
  });
}

/** Download bytes server-side (transcription dispatch, text extraction). */
export async function downloadBytes(
  db: DbClient,
  bucket: string,
  path: string,
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const res = await supaFetchRaw(db.env, `/storage/v1/object/${bucket}/${path}`, {
    token: db.token,
  });

  return {
    bytes: await res.arrayBuffer(),
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}

export async function deleteObject(
  db: DbClient,
  bucket: string,
  path: string,
): Promise<void> {
  await supaFetch(db.env, `/storage/v1/object/${bucket}/${path}`, {
    method: "DELETE",
    token: db.token,
  });
}
