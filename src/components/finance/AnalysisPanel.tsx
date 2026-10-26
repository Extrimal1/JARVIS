"use client";

import { useMemo } from "react";
import {
  AlertTriangle,
  ListOrdered,
  Repeat,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  formatCents,
  monthLabel,
  type FinanceData,
  type YearMonth,
} from "@/src/lib/finance";
import { analyzeMonth, formatPercent } from "@/src/lib/finance/analysis";

type AnalysisPanelProps = {
  data: FinanceData;
  month: YearMonth;
};

const DAY_FORMAT = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
});

function formatDay(dateISO: string): string {
  const date = new Date(`${dateISO}T12:00:00Z`);

  if (Number.isNaN(date.getTime())) return dateISO;

  return DAY_FORMAT.format(date);
}

export function AnalysisPanel({ data, month }: AnalysisPanelProps) {
  const analysis = useMemo(() => analyzeMonth(data, month), [data, month]);
  const label = monthLabel(month);

  return (
    <div>
      <h2 className="font-semibold">Monatsanalyse</h2>
      <p className="mt-1 text-xs text-slate-500">
        {label} · {analysis.txCount}{" "}
        {analysis.txCount === 1 ? "Buchung" : "Buchungen"} · nur bestätigte
        Euro-Buchungen
      </p>

      {analysis.txCount === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
          Noch keine Buchungen in diesem Monat. Lege oben eine Buchung an oder
          importiere einen Kontoauszug.
        </div>
      ) : (
        <div className="mt-4 space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <TrendingUp size={15} className="text-emerald-300" />
                Einnahmen ggü. Vormonat
              </div>
              <p className="mt-2 text-xl font-semibold tabular-nums text-emerald-200">
                {formatPercent(analysis.comparison.incomePct)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {analysis.comparison.hasPrev
                  ? `Vormonat: ${formatCents(analysis.comparison.prevIncome)}`
                  : "Kein Vormonat zum Vergleichen"}
              </p>
            </div>

            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <TrendingDown size={15} className="text-rose-300" />
                Ausgaben ggü. Vormonat
              </div>
              <p className="mt-2 text-xl font-semibold tabular-nums text-rose-200">
                {formatPercent(analysis.comparison.expensePct)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {analysis.comparison.hasPrev
                  ? `Vormonat: ${formatCents(analysis.comparison.prevExpense)}`
                  : "Kein Vormonat zum Vergleichen"}
              </p>
            </div>
          </div>

          {analysis.byCategory.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold">Ausgaben nach Kategorie</h3>
              <ul className="mt-3 space-y-2.5">
                {analysis.byCategory.slice(0, 6).map((entry) => (
                  <li key={entry.category}>
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="text-slate-200">{entry.category}</span>
                      <span className="tabular-nums text-slate-400">
                        {formatCents(entry.spent)}
                      </span>
                    </div>
                    <div
                      role="img"
                      aria-label={`${entry.category}: ${formatCents(entry.spent)}`}
                      className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/[0.06]"
                    >
                      <div
                        className="h-full rounded-full bg-cyan-300/70"
                        style={{
                          width: `${Math.max(2, Math.round(entry.sharePct * 100))}%`,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {analysis.largest.length > 0 && (
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <ListOrdered size={15} className="text-cyan-300" />
                Größte Buchungen
              </h3>
              <ul className="mt-3 space-y-1.5">
                {analysis.largest.map((transaction) => (
                  <li
                    key={transaction.id}
                    className="flex items-baseline justify-between gap-2 text-xs"
                  >
                    <span className="min-w-0 truncate text-slate-300">
                      {transaction.title}
                      <span className="text-slate-500">
                        {" "}
                        · {formatDay(transaction.date)}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 tabular-nums ${
                        transaction.type === "income"
                          ? "text-emerald-300"
                          : "text-rose-300"
                      }`}
                    >
                      {transaction.type === "income" ? "+" : "−"}
                      {formatCents(transaction.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Repeat size={15} className="text-cyan-300" />
              Wiederkehrende Buchungen
            </h3>
            {analysis.recurring.length === 0 ? (
              <p className="mt-2 text-xs leading-5 text-slate-500">
                Keine Muster erkannt. Wiederkehrend ist eine Buchung erst, wenn
                sie mindestens dreimal in zwei verschiedenen Monaten vorkommt.
              </p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {analysis.recurring.map((group) => (
                  <li
                    key={`${group.type}-${group.label}-${group.amountCents}`}
                    className="flex items-baseline justify-between gap-2 text-xs"
                  >
                    <span className="min-w-0 truncate text-slate-300">
                      {group.label}
                      <span className="text-slate-500">
                        {" "}
                        · {group.occurrences}× in {group.months.length} Monaten
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums text-slate-200">
                      {formatCents(group.amountCents)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <AlertTriangle size={15} className="text-amber-200" />
              Auffälligkeiten
            </h3>
            {analysis.anomalies.length === 0 ? (
              <p className="mt-2 text-xs leading-5 text-slate-500">
                Keine Auffälligkeiten in diesem Monat.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {analysis.anomalies.map((anomaly, index) => (
                  <li
                    key={`${index}-${anomaly.kind}`}
                    className="rounded-xl border border-amber-300/20 bg-amber-300/5 p-3 text-xs leading-5 text-amber-100"
                  >
                    {anomaly.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
