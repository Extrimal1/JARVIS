import {
  SupabaseHttpError,
  supaFetch,
  type SupabaseEnv,
} from "./supabase";

/**
 * Supabase Auth (GoTrue) calls, server-side only. Sessions live in
 * httpOnly cookies (see ./cookies); tokens never reach browser JS.
 */

export const ACCESS_COOKIE = "jarvis-at";
export const REFRESH_COOKIE = "jarvis-rt";
export const ACCESS_MAX_AGE = 60 * 60;
export const REFRESH_MAX_AGE = 60 * 60 * 24 * 30;

export type SessionTokens = {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  userId: string;
  email: string;
};

export type AuthUser = {
  id: string;
  email: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: string; email?: string };
};

function toSession(body: TokenResponse): SessionTokens {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    userId: body.user.id,
    email: body.user.email ?? "",
  };
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** Email+password sign-in (v1 auth method). Throws on failure. */
export async function signInWithPassword(
  env: SupabaseEnv,
  email: string,
  password: string,
): Promise<SessionTokens> {
  if (!validEmail(email) || password === "") {
    throw new SupabaseHttpError(400, "Invalid credentials.");
  }

  const body = await supaFetch<TokenResponse>(
    env,
    "/auth/v1/token?grant_type=password",
    { method: "POST", body: { email: email.trim(), password } },
  );

  return toSession(body);
}

/** Exchange a refresh token for a new session. Throws on failure. */
export async function refreshTokens(
  env: SupabaseEnv,
  refreshToken: string,
): Promise<SessionTokens> {
  const body = await supaFetch<TokenResponse>(
    env,
    "/auth/v1/token?grant_type=refresh_token",
    { method: "POST", body: { refresh_token: refreshToken } },
  );

  return toSession(body);
}

/** Validate an access token. Returns null when invalid/expired. */
export async function fetchUser(
  env: SupabaseEnv,
  accessToken: string,
): Promise<AuthUser | null> {
  try {
    const body = await supaFetch<{ id: string; email?: string }>(
      env,
      "/auth/v1/user",
      { token: accessToken },
    );

    if (typeof body.id !== "string" || body.id === "") return null;

    return {
      id: body.id,
      email: typeof body.email === "string" ? body.email : "",
    };
  } catch (error) {
    if (
      error instanceof SupabaseHttpError &&
      (error.status === 401 || error.status === 403)
    ) {
      return null;
    }

    throw error;
  }
}

/** Best-effort server-side sign-out; cookie clearing happens regardless. */
export async function signOutEverywhere(
  env: SupabaseEnv,
  accessToken: string,
): Promise<void> {
  try {
    await supaFetch(env, "/auth/v1/logout", {
      method: "POST",
      token: accessToken,
    });
  } catch {
    // Session is dead client-side anyway once cookies are cleared.
  }
}
