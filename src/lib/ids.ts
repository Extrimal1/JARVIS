/**
 * Stable unique ids for client-created records.
 * New code uses this helper; older modules (documents, quiz) keep
 * their equivalent local twins untouched.
 *
 * Every database table uses `uuid` primary keys, so every generator
 * below MUST return a valid UUID — including the insecure-context
 * fallbacks (e.g. phone on http://LAN, where `crypto.randomUUID`
 * is unavailable). Non-UUID ids are rejected by Postgres with
 * "invalid input syntax for type uuid".
 */

/** True for any DB-compatible UUID (any version; matches Postgres `uuid`). */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function uuidV4FromBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}` +
    `-${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

export function createId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  // `getRandomValues` stays available in more contexts than `randomUUID`.
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    return uuidV4FromBytes(crypto.getRandomValues(new Uint8Array(16)));
  }

  // Last resort (ancient browsers): still a well-formed UUID v4.
  const bytes = new Uint8Array(16);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }

  return uuidV4FromBytes(bytes);
}

/**
 * Keep a valid id untouched; mint a fresh UUID for anything else
 * (legacy timestamp ids, insecure-context fallbacks). Used ONLY at
 * the cloud submit boundary — local mode keeps legacy ids working.
 */
export function ensureUuid(id: string): string {
  return isUuid(id) ? id : createId();
}
