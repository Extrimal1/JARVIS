import { formatCents } from "@/src/lib/finance";

export type MonthPoint = {
  key: string;
  label: string;
  income: number;
  expense: number;
};

/** Income vs. expenses for the last six months (pure CSS bars, no library). */
export function FinanceChart({ series }: { series: MonthPoint[] }) {
  const max = Math.max(1, ...series.flatMap((point) => [point.income, point.expense]));
  const hasData = series.some(
    (point) => point.income > 0 || point.expense > 0,
  );

  if (!hasData) {
    return (
      <p className="py-6 text-center text-sm text-slate-500">
        Noch keine Daten für eine Übersicht vorhanden.
      </p>
    );
  }

  return (
    <div>
      <div
        role="img"
        aria-label="Einnahmen und Ausgaben der letzten sechs Monate"
        className="flex items-end gap-3 sm:gap-4"
      >
        {series.map((point) => (
          <div
            key={point.key}
            className="flex min-w-0 flex-1 flex-col items-center gap-2"
          >
            <div className="flex h-36 w-full items-end justify-center gap-1.5">
              <div
                title={`Einnahmen im ${point.label}: ${formatCents(point.income)}`}
                style={{
                  height: `${Math.max(point.income > 0 ? 3 : 0, (point.income / max) * 100)}%`,
                }}
                className="w-full max-w-8 rounded-t-md bg-emerald-400/70"
              />
              <div
                title={`Ausgaben im ${point.label}: ${formatCents(point.expense)}`}
                style={{
                  height: `${Math.max(point.expense > 0 ? 3 : 0, (point.expense / max) * 100)}%`,
                }}
                className="w-full max-w-8 rounded-t-md bg-rose-400/70"
              />
            </div>

            <span className="truncate text-[11px] text-slate-500">
              {point.label}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-4 text-xs text-slate-400">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-emerald-400" />
          Einnahmen
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-rose-400" />
          Ausgaben
        </span>
      </div>
    </div>
  );
}
