/**
 * Safe post-login redirect target. Only single-leading-slash app
 * paths are allowed: protocol-relative (`//evil.com`), absolute
 * URLs, backslash tricks, and control characters fall back to `/`.
 */
export function safeNext(value: string | null | undefined): string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    return "/";
  }

  if (
    value.startsWith("//") ||
    value.startsWith("/\\") ||
    value.includes("\\") ||
    // Control characters must never reach the router.
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return "/";
  }

  return value;
}
