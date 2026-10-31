"use client";

import { useEffect, type ReactNode } from "react";
import { useLockBodyScroll } from "@/src/hooks/useLockBodyScroll";

/**
 * Shared Study modal shell: fixed viewport-centered overlay with
 * backdrop, Escape handling, and background scroll lock.
 *
 * Centering uses `m-auto` inside a scrolling flex wrapper, so the
 * panel stays centered at every viewport size (including mobile
 * and resizes) and can never clip at the top when content is
 * tall: the panel is capped at 90vh and dialogs scroll their own
 * body area instead.
 */
export function Modal({
  titleId,
  onClose,
  maxWidth = "max-w-2xl",
  children,
}: {
  /** Id of the dialog's heading element (must exist in children). */
  titleId: string;
  onClose: () => void;
  maxWidth?: string;
  children: ReactNode;
}) {
  useLockBodyScroll(true);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 overflow-y-auto"
    >
      <button
        aria-label="Schließen"
        onClick={onClose}
        className="jarvis-fade absolute inset-0 h-full w-full cursor-default bg-black/70"
      />

      <div className="relative flex min-h-full p-4">
        <div
          className={`jarvis-pop relative m-auto flex max-h-[90vh] min-h-0 w-full ${maxWidth} flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#0d111b] p-6`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
