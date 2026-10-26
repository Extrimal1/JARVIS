/**
 * Stable unique ids for client-created records.
 * New code uses this helper; older modules (documents, quiz) keep
 * their equivalent local twins untouched.
 */
export function createId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
