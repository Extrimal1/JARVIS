"use client";

import { useEffect } from "react";

/** Prevents background scrolling while a modal/drawer is open. */
export function useLockBodyScroll(locked: boolean) {
  useEffect(() => {
    if (!locked) return;

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previous;
    };
  }, [locked]);
}
