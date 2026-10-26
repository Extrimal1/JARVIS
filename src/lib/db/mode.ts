/**
 * Backend mode switch (build-time constant). "1" → cloud backend via
 * API routes (requires Supabase env + login). Anything else → local
 * browser storage, exactly as before. Never half-and-half at runtime.
 */
export const CLOUD_ENABLED =
  process.env.NEXT_PUBLIC_CLOUD_ENABLED === "1";
