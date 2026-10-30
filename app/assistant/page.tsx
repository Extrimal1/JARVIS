"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import Sidebar from "@/src/components/Sidebar";
import { ConversationPanel } from "@/src/components/conversation/ConversationPanel";

/**
 * Dedicated conversation interface: the same shared engine and the
 * same threads as the Dashboard panel, with full voice controls.
 * History persists across reloads via conversation threads.
 */

const SUGGESTIONS = [
  "Plane morgen um 15:30 ein Treffen mit Max",
  "Was habe ich morgen?",
  "24,50 Euro bei Lidl für Lebensmittel ausgegeben",
  "Wie viel habe ich diesen Monat ausgegeben?",
  "Создай встречу завтра в 15:30",
  "Что у меня завтра?",
];

function AssistantBody({ initialText }: { initialText: string }) {
  return (
    <main className="min-h-screen bg-[#080d18] text-white">
      <div className="mx-auto flex max-w-[1400px] gap-6 px-6 py-8">
        <Sidebar />

        <section className="min-w-0 flex-1">
          <header className="flex flex-wrap items-center gap-3">
            <Link
              href="/"
              aria-label="Zurück zur Übersicht"
              className="rounded-xl border border-white/10 p-2.5 text-slate-300 transition hover:bg-white/5 hover:text-white"
            >
              <ArrowLeft size={18} />
            </Link>

            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-semibold">Assistent</h1>
              <p className="text-sm text-slate-400">
                Sprich oder tippe — J.A.R.V.I.S. führt aus.
              </p>
            </div>
          </header>

          <div className="mt-4 rounded-2xl border border-white/[0.08] bg-[#0d111b] p-4">
            <ConversationPanel
              module="assistant"
              variant="full"
              initialText={initialText}
              suggestions={SUGGESTIONS}
            />
          </div>

          <footer className="mt-4 space-y-1 text-xs text-slate-500">
            <p>
              Verlauf wird in Unterhaltungen gespeichert — auch nach einem
              Neuladen verfügbar. Unterhaltungen lassen sich über die Auswahl
              oben wechseln.
            </p>
            <p>
              Mikrofon und Sprachausgabe laufen im Browser; Audiodaten werden
              nicht gespeichert.
            </p>
          </footer>
        </section>
      </div>
    </main>
  );
}

function AssistantWithQuery() {
  const params = useSearchParams();
  const initialText = params.get("q") ?? "";

  return <AssistantBody initialText={initialText} />;
}

export default function AssistantRoute() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-[#080d18] text-white">
          <div className="mx-auto flex max-w-[1400px] gap-6 px-6 py-8">
            <Sidebar />
            <section className="min-w-0 flex-1">
              <p className="text-sm text-slate-400">Assistent wird geladen …</p>
            </section>
          </div>
        </main>
      }
    >
      <AssistantWithQuery />
    </Suspense>
  );
}
