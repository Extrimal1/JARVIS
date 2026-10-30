"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Browser speech recognition (Web Speech API) with explicit start/stop.
 *
 * - Recording starts ONLY via `start()` (user gesture) and stops via
 *   `stop()`, on final result, on error, or on unmount. Never runs in
 *   the background.
 * - Where supported this uses the browser's own recognition service
 *   (Chrome sends audio to Google servers) — the assistant page states
 *   this openly and always offers text input as an equal fallback.
 */

export type RecognitionLang = "de-DE" | "ru-RU";

export type RecognitionStatus =
  | "idle"
  | "listening"
  | "denied"
  | "unavailable"
  | "error";

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: { transcript: string };
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionErrorLike = {
  error: string;
};

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type RecognitionWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

function recognitionOf(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;

  const candidate = window as RecognitionWindow;

  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition ?? null;
}

export function isRecognitionSupported(): boolean {
  return recognitionOf() !== null;
}

function errorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Mikrofonzugriff verweigert. Erlaube das Mikrofon in den Browser-Einstellungen oder tippe deine Anfrage.";
    case "no-speech":
      return "Ich habe nichts gehört. Versuche es erneut oder tippe deine Anfrage.";
    case "network":
      return "Spracherkennung nicht erreichbar (Netzwerk). Tippe deine Anfrage oder versuche es später erneut.";
    case "audio-capture":
      return "Kein Mikrofon gefunden. Schließe ein Mikrofon an oder tippe deine Anfrage.";
    case "aborted":
      return "";
    default:
      return "Spracherkennung fehlgeschlagen. Tippe deine Anfrage oder versuche es erneut.";
  }
}

export function useSpeechRecognition(
  onFinal: (transcript: string) => void,
): {
  supported: boolean;
  status: RecognitionStatus;
  interim: string;
  error: string | null;
  lang: RecognitionLang;
  setLang: (lang: RecognitionLang) => void;
  start: () => void;
  stop: () => void;
  clearError: () => void;
} {
  // Capability detection runs after hydration: reading it during
  // render differs between server (no window) and client and would
  // cause a hydration mismatch, so both render "unsupported" first.
  const [supported, setSupported] = useState(false);
  const [status, setStatus] = useState<RecognitionStatus>("unavailable");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<RecognitionLang>("de-DE");

  useEffect(() => {
    if (!isRecognitionSupported()) return;

    // Post-mount capability detection is intentional (see above).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(true);
    setStatus((current) => (current === "unavailable" ? "idle" : current));
  }, []);

  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const callback = useRef(onFinal);
  const stopping = useRef(false);

  useEffect(() => {
    callback.current = onFinal;
  }, [onFinal]);

  useEffect(
    () => () => {
      stopping.current = true;

      try {
        recognition.current?.abort();
      } catch {
        // Teardown only; nothing to report.
      }
    },
    [],
  );

  const stop = useCallback(() => {
    stopping.current = true;
    setInterim("");

    try {
      recognition.current?.stop();
    } catch {
      // Already stopped; onend still fires and resets state.
    }
  }, []);

  const start = useCallback(() => {
    const factory = recognitionOf();

    if (factory === null) {
      setStatus("unavailable");
      setError(
        "Dieser Browser unterstützt keine Spracherkennung. Tippe deine Anfrage einfach als Text.",
      );

      return;
    }

    stopping.current = false;
    setError(null);
    setInterim("");

    const instance = new factory();
    instance.lang = lang;
    instance.interimResults = true;
    instance.continuous = false;
    instance.maxAlternatives = 1;

    instance.onresult = (event: SpeechRecognitionEventLike) => {
      let interimText = "";
      let finalText = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript ?? "";

        if (result.isFinal) {
          finalText += transcript;
        } else {
          interimText += transcript;
        }
      }

      setInterim(interimText);

      if (finalText.trim() !== "") {
        stopping.current = true;
        setInterim("");

        try {
          instance.stop();
        } catch {
          // Final result already captured; state resets via onend.
        }

        callback.current(finalText.trim());
      }
    };

    instance.onerror = (event: SpeechRecognitionErrorLike) => {
      stopping.current = true;

      if (event.error === "aborted") {
        setStatus("idle");

        return;
      }

      setInterim("");

      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setStatus("denied");
      } else {
        setStatus("error");
      }

      setError(errorMessage(event.error));
    };

    instance.onend = () => {
      recognition.current = null;
      setInterim("");

      if (!stopping.current) {
        // Ended without a final result (e.g. silence timeout).
        setStatus("idle");
        setError((current) => current ?? errorMessage("no-speech"));
      } else {
        setStatus((current) =>
          current === "listening" ? "idle" : current,
        );
      }
    };

    recognition.current = instance;

    try {
      instance.start();
      setStatus("listening");
    } catch {
      recognition.current = null;
      setStatus("error");
      setError(errorMessage("unknown"));
    }
  }, [lang]);

  const clearError = useCallback(() => setError(null), []);

  return {
    supported,
    status,
    interim,
    error,
    lang,
    setLang,
    start,
    stop,
    clearError,
  };
}
