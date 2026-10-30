"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Optional text-to-speech answers via the browser's speechSynthesis.
 * Off by default; the toggle lives on the assistant page. Never
 * blocks: failures (no voices, interrupted) just end the state.
 */

export function useSpeechSynthesis(): {
  supported: boolean;
  enabled: boolean;
  speaking: boolean;
  setEnabled: (enabled: boolean) => void;
  speak: (text: string, lang: string) => void;
  cancel: () => void;
} {
  // Capability detection runs after hydration (same reason as in
  // useSpeechRecognition): server and first client render agree.
  const [supported, setSupported] = useState(false);
  const [enabled, setEnabledState] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const enabledRef = useRef(false);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.speechSynthesis === "undefined" ||
      typeof window.SpeechSynthesisUtterance === "undefined"
    ) {
      return;
    }

    // Post-mount capability detection is intentional (see above).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(true);
  }, []);

  const cancel = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }

    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  useEffect(() => () => cancel(), [cancel]);

  const setEnabled = useCallback(
    (next: boolean) => {
      enabledRef.current = next;
      setEnabledState(next);

      if (!next) cancel();
    },
    [cancel],
  );

  const speak = useCallback(
    (text: string, lang: string) => {
      if (!enabledRef.current || !supported) return;

      const plain = text
        .replace(/^•\s*/gm, "")
        .replace(/[„“«»]/g, "")
        .trim()
        .slice(0, 600);

      if (plain === "") return;

      try {
        window.speechSynthesis.cancel();

        const utterance = new window.SpeechSynthesisUtterance(plain);
        utterance.lang = lang;
        utterance.rate = 1;

        const voices = window.speechSynthesis.getVoices();
        const prefix = lang.slice(0, 2).toLowerCase();
        const match = voices.find((voice) =>
          voice.lang.toLowerCase().startsWith(prefix),
        );

        if (match !== undefined) {
          utterance.voice = match;
        }

        utterance.onend = () => setSpeaking(false);
        utterance.onerror = () => setSpeaking(false);

        setSpeaking(true);
        window.speechSynthesis.speak(utterance);
      } catch {
        setSpeaking(false);
      }
    },
    [supported],
  );

  return { supported, enabled, speaking, setEnabled, speak, cancel };
}
