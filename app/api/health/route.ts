import { NextResponse } from "next/server";
import { supabaseEnv } from "@/src/lib/supabase/supabase";
import { ok } from "@/src/lib/api/respond";

/** GET /api/health → backend + worker availability (no auth required). */

export async function GET(): Promise<NextResponse> {
  const cloud = supabaseEnv() !== null;
  const workerUrl = process.env.LECTURE_WORKER_URL ?? "";
  let worker: "unconfigured" | "reachable" | "unreachable" =
    workerUrl === "" ? "unconfigured" : "unreachable";

  if (workerUrl !== "") {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      try {
        const res = await fetch(`${workerUrl.replace(/\/+$/, "")}/health`, {
          signal: controller.signal,
        });
        worker = res.ok ? "reachable" : "unreachable";
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      worker = "unreachable";
    }
  }

  return ok({
    cloud,
    worker,
    time: new Date().toISOString(),
  });
}
