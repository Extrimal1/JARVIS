import { NextResponse, type NextRequest } from "next/server";
import { signOutEverywhere } from "@/src/lib/supabase/auth";
import {
  clearSessionCookies,
  readSessionCookies,
} from "@/src/lib/supabase/cookies";
import { supabaseEnv } from "@/src/lib/supabase/supabase";
import { failFromUnknown, ok } from "@/src/lib/api/respond";

/** POST /api/auth/logout → revokes server-side (best effort), clears cookies. */

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const env = supabaseEnv();
    const cookies = readSessionCookies(request);

    if (env !== null && cookies !== null) {
      await signOutEverywhere(env, cookies.access);
    }

    const response = ok({ loggedOut: true });
    clearSessionCookies(response);

    return response;
  } catch (error) {
    return failFromUnknown("auth/logout", error);
  }
}
