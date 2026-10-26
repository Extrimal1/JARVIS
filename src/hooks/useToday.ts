"use client";

import { useEffect, useState } from "react";
import { toISODateLocal } from "@/src/lib/calendar";

/**
 * Today's local date (YYYY-MM-DD), available only after mount.
 * Returns null during SSR/prerender so markup never depends on the
 * server's date (avoids hydration mismatches).
 */
export function useToday(): string | null {
  const [today, setToday] = useState<string | null>(null);

  useEffect(() => {
    // Mount-gated on purpose (see docs above).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToday(toISODateLocal(new Date()));
  }, []);

  return today;
}
