"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  Loader2,
  Mic,
  Send,
  Square,
  Undo2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useConversation } from "@/src/hooks/useConversation";
import {
  useSpeechRecognition,
  type RecognitionLang,
} from "@/src/hooks/useSpeechRecognition";
import { useSpeechSynthesis } from "@/src/hooks/useSpeechSynthesis";
import { turnHref } from "@/src/lib/assistant/transcript";
import type { AssistantLocale } from "@/src/lib/assistant/actions";
import type { ConversationModule } from "@/src/lib/conversation";
import type { Task } from "@/src/lib/tasks";
import type { StudyData } from "@/src/lib/study";
import { ThreadPicker } from "./ThreadPicker";
import { TurnView } from "./TurnView";

/**
 * Shared conversation panel: the SAME component on the Dashboard and
 * on /assistant. Threads, history, tools, confirmations, voice —
 * everything runs through the shared conversation engine, so both
 * places always show the same state.
 *
 * Variants: "compact" (dashboard hero: no toggles, capped height),
 * "full" (/assistant: language + speech toggles, taller list).
 */

function recognitionToLocale(lang: RecognitionLang): AssistantLocale {
  return lang === "ru-RU" ? "ru" : "de";
}

export type ConversationPanelProps = {
  module: ConversationModule;
  variant: "compact" | "full";
  initialText?: string;
  suggestions?: string[];
  initialTasks?: Task[];
  initialStudy?: StudyData;
};

export function ConversationPanel({
  module,
  variant,
  initialText = "",
  suggestions = [],
  initialTasks,
  initialStudy,
}: ConversationPanelProps) {
  const [input, setInput] = useState(initialText);
  const doSendRef = useRef<(text: string) => void>(() => {});
  const recognition = useSpeechRecognition((transcript) => {
    doSendRef.current(transcript);
  });
  const synthesis = useSpeechSynthesis();
  const locale = recognitionToLocale(recognition.lang);
  const conv = useConversation({ module, locale, initialTasks, initialStudy });
  const listRef = useRef<HTMLDivElement | null>(null);
  const answerKeyRef = useRef<string | null>(null);

  const doSend = (raw: string): void => {
    const text = raw.trim();

    if (text === "") return;

    if (recognition.status === "listening") {
      recognition.stop();
    }

    setInput("");
    void conv.send(text);
  };

  // Keep the voice callback on the latest submit (ref write in an
  // effect — never during render).
  useEffect(() => {
    doSendRef.current = doSend;
  });

  // Speak genuinely new answers only: mount and thread switches
  // never speak (keyed by thread + answer count, no animation).
  useEffect(() => {
    const count = conv.turns.filter(
      (turn) => turn.kind === "assistant" && turn.answer !== "",
    ).length;
    const key = conv.effectiveId === null ? null : `${conv.effectiveId}:${count}`;
    const previous = answerKeyRef.current;
    answerKeyRef.current = key;

    if (previous === null || key === null || key === previous) return;
    if (previous.split(":")[0] !== key.split(":")[0]) return;
    if (!synthesis.enabled) return;

    const last = [...conv.turns]
      .reverse()
      .find((turn) => turn.kind === "assistant" && turn.answer !== "");

    if (last !== undefined && last.kind === "assistant") {
      synthesis.speak(last.answer, recognition.lang);
    }
  });

  // Keep the latest turn visible (instant scroll, no animation).
  useEffect(() => {
    const element = listRef.current;

    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [conv.turns.length, conv.busy, conv.liveCard, conv.error, conv.notice]);

  const providerTag =
    conv.engine === null
      ? "…"
      : conv.engine.provider === "ollama"
        ? "KI-Modell"
        : "Regelwerk";

  const lastAssistant = [...conv.turns]
    .reverse()
    .find((turn) => turn.kind === "assistant");
  const href =
    lastAssistant !== undefined && lastAssistant.kind === "assistant"
      ? turnHref(lastAssistant.steps)
      : undefined;

  const listHeight =
    variant === "compact" ? "max-h-72" : "h-[52vh] min-h-72";

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <ThreadPicker
            threads={conv.sortedThreads}
            selectedId={conv.effectiveId}
            onSelect={conv.selectThread}
            onNew={conv.newThread}
            disabled={conv.busy}
          />
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-1 text-[11px] ${
            conv.engine?.provider === "ollama"
              ? "bg-cyan-400/10 text-cyan-300"
              : "bg-slate-700/60 text-slate-300"
          }`}
        >
          {providerTag}
        </span>
      </div>

      {conv.engineError !== null && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">
          <AlertTriangle size={16} className="shrink-0" />
          <span className="min-w-0 flex-1">{conv.engineError}</span>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="shrink-0 rounded-lg border border-rose-400/40 px-2 py-1 text-xs transition-colors hover:bg-rose-400/20"
          >
            Neu laden
          </button>
        </div>
      )}

      {conv.engine?.provider === "ollama" &&
        !conv.engine.configured &&
        conv.engineError === null && (
          <p className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
            KI-Modell angefordert, aber nicht konfiguriert. Setze OLLAMA_MODEL
            auf dem Server oder wechsle zu ASSISTANT_PROVIDER=heuristic.
          </p>
        )}

      <div
        ref={listRef}
        aria-live="polite"
        className={`min-h-0 space-y-3 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/40 p-3 ${listHeight}`}
      >
        {conv.turns.length === 0 && !conv.busy && (
          <p className="py-6 text-center text-sm text-slate-500">
            Stelle eine Frage — zum Beispiel zu Terminen, Aufgaben oder
            Finanzen.
          </p>
        )}
        {conv.turns.map((turn) => (
          <TurnView
            key={turn.id}
            turn={turn}
            disabled={conv.busy}
            onClarify={(text) => doSend(text)}
          />
        ))}
        {conv.busy && (
          <p className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 size={16} className="animate-spin" />
            J.A.R.V.I.S. denkt nach …
          </p>
        )}
      </div>

      {conv.liveCard?.kind === "confirm" && (
        <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-3">
          <p className="text-sm text-amber-100">{conv.liveCard.summary}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void conv.confirmTurn(true)}
              className="flex items-center gap-1 rounded-lg bg-amber-400 px-3 py-1.5 text-sm font-medium text-slate-900 transition-colors hover:bg-amber-300"
            >
              <Check size={16} /> Bestätigen
            </button>
            <button
              type="button"
              onClick={() => void conv.confirmTurn(false)}
              className="flex items-center gap-1 rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 transition-colors hover:border-slate-400"
            >
              <X size={16} /> Abbrechen
            </button>
          </div>
        </div>
      )}

      {conv.liveCard?.kind === "pick" && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-3">
          <p className="text-sm text-slate-200">{conv.liveCard.question}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {conv.liveCard.options.map((option) => (
              <button
                key={option.eventId}
                type="button"
                onClick={() => void conv.pickTurn(option.eventId)}
                className="rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-3 py-1.5 text-sm text-cyan-200 transition-colors hover:bg-cyan-400/20"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {conv.undos.length > 0 && (
        <div className="space-y-1">
          {conv.undos.map((entry, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              {!entry.undone ? (
                <button
                  type="button"
                  onClick={() => void conv.undoTurn(index)}
                  className="flex items-center gap-1 rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-200 transition-colors hover:border-slate-400"
                >
                  <Undo2 size={14} /> Rückgängig
                </button>
              ) : (
                <span className="flex items-center gap-1 text-xs text-emerald-300">
                  <Check size={14} /> Rückgängig gemacht
                </span>
              )}
              {entry.result !== null && (
                <span className="text-xs text-slate-400">{entry.result}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {href !== undefined && (
        <Link
          href={href}
          className="text-sm text-cyan-300 underline-offset-4 hover:underline"
        >
          {href === "/calendar"
            ? "Im Kalender ansehen →"
            : href === "/study"
              ? "In den Unterlagen ansehen →"
              : "In den Finanzen ansehen →"}
        </Link>
      )}

      {conv.notice !== null && (
        <p className="text-sm text-slate-300">{conv.notice}</p>
      )}

      {conv.error !== null && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">
          <AlertTriangle size={16} className="shrink-0" />
          <span className="min-w-0 flex-1">{conv.error}</span>
          {conv.canRetry && (
            <button
              type="button"
              onClick={conv.retry}
              className="shrink-0 rounded-lg border border-rose-400/40 px-2 py-1 text-xs transition-colors hover:bg-rose-400/20"
            >
              Erneut versuchen
            </button>
          )}
        </div>
      )}

      {conv.storesError !== null && (
        <p className="text-xs text-amber-300/90">
          Hinweis: {conv.storesError}
        </p>
      )}

      {suggestions.length > 0 && conv.turns.length === 0 && !conv.busy && (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              disabled={!conv.ready}
              onClick={() => doSend(suggestion)}
              className="rounded-full border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-cyan-400 hover:text-cyan-200 disabled:opacity-50"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          doSend(input);
        }}
        className="flex items-center gap-2"
      >
        {recognition.supported && (
          <button
            type="button"
            onClick={() => {
              if (recognition.status === "listening") {
                recognition.stop();
              } else {
                recognition.clearError();
                recognition.start();
              }
            }}
            disabled={!conv.ready}
            title={
              recognition.status === "listening" ? "Stoppen" : "Sprechen"
            }
            aria-label={
              recognition.status === "listening" ? "Stoppen" : "Sprechen"
            }
            className={`flex shrink-0 items-center justify-center rounded-xl border p-2.5 transition-colors disabled:opacity-50 ${
              recognition.status === "listening"
                ? "border-rose-400 bg-rose-400/20 text-rose-200"
                : "border-slate-700 bg-slate-800 text-slate-300 hover:border-cyan-400 hover:text-cyan-200"
            }`}
          >
            <Mic size={18} />
          </button>
        )}
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={
            conv.ready ? "Nachricht an J.A.R.V.I.S. …" : "Wird geladen …"
          }
          disabled={!conv.ready || conv.busy}
          aria-label="Nachricht an J.A.R.V.I.S."
          className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-400 disabled:opacity-50"
        />
        {conv.busy ? (
          <button
            type="button"
            onClick={conv.cancel}
            title="Abbrechen"
            aria-label="Abbrechen"
            className="flex shrink-0 items-center justify-center rounded-xl bg-rose-500 p-2.5 text-white transition-colors hover:bg-rose-400"
          >
            <Square size={18} />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!conv.ready || input.trim() === ""}
            title="Senden"
            aria-label="Senden"
            className="flex shrink-0 items-center justify-center rounded-xl bg-cyan-400 p-2.5 text-slate-900 transition-colors hover:bg-cyan-300 disabled:opacity-50"
          >
            <Send size={18} />
          </button>
        )}
      </form>

      {recognition.status === "listening" && (
        <p className="text-xs text-slate-400">
          Hört zu{recognition.interim !== "" ? ` … „${recognition.interim}“` : " …"}
        </p>
      )}
      {recognition.error !== null && (
        <p className="text-xs text-rose-300">{recognition.error}</p>
      )}

      {variant === "full" && (
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Sprache"
            className="flex overflow-hidden rounded-lg border border-slate-700"
          >
            {(
              [
                { lang: "de-DE", label: "DE" },
                { lang: "ru-RU", label: "RU" },
              ] as const
            ).map((option) => {
              const active = recognition.lang === option.lang;

              return (
                <button
                  key={option.lang}
                  type="button"
                  onClick={() => recognition.setLang(option.lang)}
                  aria-pressed={active}
                  className={`px-3 py-1.5 text-xs transition-colors ${
                    active
                      ? "bg-cyan-400 text-slate-900"
                      : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {synthesis.supported && (
            <button
              type="button"
              onClick={() => synthesis.setEnabled(!synthesis.enabled)}
              aria-pressed={synthesis.enabled}
              title={
                synthesis.enabled
                  ? "Sprachausgabe ausschalten"
                  : "Sprachausgabe einschalten"
              }
              className={`flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                synthesis.enabled
                  ? "border-cyan-400 bg-cyan-400/10 text-cyan-200"
                  : "border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {synthesis.enabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
              {synthesis.enabled ? "Stimme an" : "Stimme aus"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
