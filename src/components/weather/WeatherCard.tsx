"use client";

import { useEffect, useRef, useState } from "react";
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudOff,
  CloudRain,
  CloudSnow,
  CloudSun,
  Droplets,
  Loader2,
  MapPin,
  Moon,
  Navigation,
  RotateCcw,
  Settings2,
  Sun,
  Wind,
  X,
} from "lucide-react";
import { useWeather } from "@/src/hooks/useWeather";
import {
  compassLabel,
  dayLabel,
  describeCode,
  hourLabel,
  updatedLabel,
  type ConditionKind,
  type WeatherCity,
} from "@/src/lib/weather";

function ConditionIcon({
  code,
  isDay,
  size,
  className,
}: {
  code: number;
  isDay: boolean;
  size: number;
  className?: string;
}) {
  const { kind } = describeCode(code);

  if (kind === "clear") {
    const Clear = isDay ? Sun : Moon;
    return <Clear size={size} className={className} aria-hidden="true" />;
  }
  if (kind === "partly") {
    const Partly = isDay ? CloudSun : CloudMoon;
    return <Partly size={size} className={className} aria-hidden="true" />;
  }
  if (kind === "overcast") {
    return <Cloud size={size} className={className} aria-hidden="true" />;
  }
  if (kind === "fog") {
    return <CloudFog size={size} className={className} aria-hidden="true" />;
  }
  if (kind === "drizzle") {
    return <CloudDrizzle size={size} className={className} aria-hidden="true" />;
  }
  if (kind === "rain") {
    return <CloudRain size={size} className={className} aria-hidden="true" />;
  }
  if (kind === "snow") {
    return <CloudSnow size={size} className={className} aria-hidden="true" />;
  }
  return <CloudLightning size={size} className={className} aria-hidden="true" />;
}

function glowFor(kind: ConditionKind, isDay: boolean): string {
  if (kind === "clear") {
    return isDay ? "bg-amber-300/[0.10]" : "bg-slate-300/[0.07]";
  }
  if (kind === "rain" || kind === "drizzle" || kind === "storm") {
    return "bg-cyan-400/[0.10]";
  }
  if (kind === "snow") return "bg-slate-200/[0.08]";
  return "bg-cyan-300/[0.07]";
}

type SearchState = {
  results: WeatherCity[];
  searching: boolean;
  searchError: string | null;
};

function CityPicker({
  onSelect,
  onReset,
  onClose,
}: {
  onSelect: (city: WeatherCity) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({
    results: [],
    searching: false,
    searchError: null,
  });
  const [geoStatus, setGeoStatus] = useState<
    "idle" | "requesting" | "denied" | "failed"
  >("idle");
  const requestId = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();

    if (trimmed.length < 2) return;

    const id = requestId.current + 1;
    requestId.current = id;
    // Debounced search status for this query (reset happens in onChange).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((current) => ({ ...current, searching: true, searchError: null }));

    const timer = window.setTimeout(() => {
      const controller = new AbortController();

      fetch(`/api/weather/search?name=${encodeURIComponent(trimmed)}`, {
        signal: controller.signal,
      })
        .then((res) => res.json().catch(() => null) as Promise<unknown>)
        .then((parsed: unknown) => {
          if (requestId.current !== id) return;

          if (
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as { ok?: unknown }).ok === true &&
            Array.isArray((parsed as { data?: unknown }).data)
          ) {
            setState({
              results: (parsed as { data: WeatherCity[] }).data,
              searching: false,
              searchError: null,
            });
          } else {
            setState({
              results: [],
              searching: false,
              searchError: "Stadtsuche fehlgeschlagen.",
            });
          }
        })
        .catch((error: unknown) => {
          if (
            requestId.current === id &&
            !(error instanceof DOMException && error.name === "AbortError")
          ) {
            setState({
              results: [],
              searching: false,
              searchError: "Stadtsuche fehlgeschlagen.",
            });
          }
        });

      return () => controller.abort();
    }, 400);

    return () => window.clearTimeout(timer);
  }, [query]);

  function useGeolocation() {
    if (
      typeof navigator === "undefined" ||
      !navigator.geolocation ||
      geoStatus === "requesting"
    ) {
      return;
    }

    setGeoStatus("requesting");

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGeoStatus("idle");
        onSelect({
          name: "Aktueller Standort",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          detail: "",
        });
      },
      (error) => {
        setGeoStatus(
          error.code === error.PERMISSION_DENIED ? "denied" : "failed",
        );
      },
      { timeout: 8000, maximumAge: 600_000 },
    );
  }

  return (
    <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-300">Stadt wählen</p>
        <button
          onClick={onClose}
          aria-label="Stadtauswahl schließen"
          className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
        >
          <X size={15} />
        </button>
      </div>

      <div className="relative mt-3">
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);

            if (event.target.value.trim().length < 2) {
              setState({ results: [], searching: false, searchError: null });
            }
          }}
          placeholder="z. B. Berlin, München, Hamburg …"
          aria-label="Stadt suchen"
          maxLength={100}
          className="w-full rounded-xl border border-white/10 bg-black/30 py-2.5 pl-3 pr-9 text-sm text-white outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
        />
        {state.searching && (
          <Loader2
            size={16}
            aria-hidden="true"
            className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-cyan-300"
          />
        )}
      </div>

      {state.searchError !== null && (
        <p role="alert" className="mt-2 text-xs text-rose-300">
          {state.searchError}
        </p>
      )}

      {state.results.length > 0 && (
        <ul className="mt-2 max-h-44 space-y-1 overflow-y-auto">
          {state.results.map((city) => (
            <li key={`${city.latitude},${city.longitude},${city.name}`}>
              <button
                onClick={() => onSelect(city)}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-white/5"
              >
                <MapPin
                  size={14}
                  className="shrink-0 text-cyan-300"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">
                  {city.name}
                  {city.detail !== "" && (
                    <span className="block truncate text-xs text-slate-500">
                      {city.detail}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {typeof navigator !== "undefined" && !!navigator.geolocation && (
          <button
            onClick={useGeolocation}
            disabled={geoStatus === "requesting"}
            className="flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200 disabled:opacity-50"
          >
            <Navigation size={14} aria-hidden="true" />
            {geoStatus === "requesting"
              ? "Standort wird ermittelt …"
              : "Standort verwenden"}
          </button>
        )}
        <button
          onClick={onReset}
          className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-400 transition hover:text-slate-200"
        >
          Zurück zu Stuttgart
        </button>
      </div>

      {geoStatus === "denied" && (
        <p role="alert" className="mt-2 text-xs text-amber-200">
          Standortzugriff verweigert. Wähle stattdessen eine Stadt aus der
          Suche.
        </p>
      )}
      {geoStatus === "failed" && (
        <p role="alert" className="mt-2 text-xs text-amber-200">
          Standort konnte nicht ermittelt werden.
        </p>
      )}
    </div>
  );
}

export function WeatherCard() {
  const { city, report, loading, refreshing, error, setCity, resetCity, retry } =
    useWeather();
  const [pickerOpen, setPickerOpen] = useState(false);

  const condition =
    report === null ? null : describeCode(report.now.code);

  return (
    <section
      aria-label="Wetter"
      className="jarvis-enter relative overflow-hidden rounded-3xl border border-cyan-300/15 bg-gradient-to-br from-[#0e2233] via-[#0d1420] to-[#0d111b] p-5 sm:p-6"
      style={{ "--enter-delay": "120ms" } as React.CSSProperties}
    >
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full blur-3xl transition-colors duration-700 ${
          condition === null ? "bg-cyan-400/[0.07]" : (
            glowFor(
              describeCode(report?.now.code ?? 3).kind,
              report?.now.isDay ?? true,
            )
          )
        }`}
      />

      <div className="relative">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-slate-200">
            <MapPin size={16} className="shrink-0 text-cyan-300" aria-hidden="true" />
            <span className="truncate">
              {report?.city.name ?? city.name}
            </span>
            {(report?.city.detail ?? city.detail) !== "" && (
              <span className="hidden truncate text-xs font-normal text-slate-500 sm:inline">
                · {report?.city.detail ?? city.detail}
              </span>
            )}
          </h2>

          {report !== null && (
            <span className="text-xs tabular-nums text-slate-500">
              Stand {updatedLabel(report.fetchedAt) || "–"}
              {refreshing ? " · lädt …" : ""}
            </span>
          )}

          <button
            onClick={() => setPickerOpen((open) => !open)}
            aria-expanded={pickerOpen}
            aria-label="Stadt ändern"
            title="Stadt ändern"
            className="rounded-lg p-2 text-slate-400 transition hover:bg-white/5 hover:text-cyan-200"
          >
            <Settings2 size={16} />
          </button>
        </div>

        {pickerOpen && (
          <CityPicker
            onSelect={(next) => {
              setCity(next);
              setPickerOpen(false);
            }}
            onReset={() => {
              resetCity();
              setPickerOpen(false);
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}

        <div aria-live="polite" className="mt-4">
          {loading && report === null ? (
            <div className="grid gap-5 lg:grid-cols-[1fr_1.4fr]">
              <div className="flex items-center gap-4">
                <div className="jarvis-skeleton h-20 w-20 shrink-0 rounded-2xl" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="jarvis-skeleton h-9 w-32 rounded-lg" />
                  <div className="jarvis-skeleton h-4 w-24 rounded" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {[0, 1, 2, 3, 4, 5].map((index) => (
                  <div
                    key={index}
                    className="jarvis-skeleton h-[72px] rounded-xl"
                  />
                ))}
              </div>
            </div>
          ) : error !== null && report === null ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center">
              <CloudOff size={28} className="text-slate-500" aria-hidden="true" />
              <p className="max-w-sm text-sm text-slate-400">{error}</p>
              <p className="text-xs text-slate-600">
                Quelle: Open-Meteo · keine Daten verfügbar
              </p>
              <button
                onClick={retry}
                className="flex items-center gap-2 rounded-xl border border-cyan-300/25 px-4 py-2 text-sm text-cyan-200 transition hover:bg-cyan-300/10"
              >
                <RotateCcw size={15} aria-hidden="true" />
                Erneut versuchen
              </button>
            </div>
          ) : report !== null && condition !== null ? (
            <div className="grid items-center gap-5 lg:grid-cols-[1fr_1.4fr]">
              <div className="flex items-center gap-4">
                <div
                  className={`wx-icon wx-anim-${condition.kind} flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-black/20 text-cyan-200`}
                >
                  <ConditionIcon
                    code={report.now.code}
                    isDay={report.now.isDay}
                    size={40}
                  />
                </div>

                <div className="min-w-0">
                  <p className="text-4xl font-semibold tabular-nums tracking-tight sm:text-5xl">
                    {report.now.temperature}°
                  </p>
                  <p className="mt-1 truncate text-sm text-slate-300">
                    {condition.label}
                  </p>
                  <p className="mt-0.5 text-xs tabular-nums text-slate-500">
                    Gefühlt {report.now.feelsLike}° · H {report.now.high}° /
                    T {report.now.low}°
                  </p>
                </div>
              </div>

              <div className="min-w-0 space-y-3">
                <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
                  <div className="flex items-center gap-1.5">
                    <Droplets
                      size={14}
                      className="text-cyan-300"
                      aria-hidden="true"
                    />
                    <dt className="sr-only">Luftfeuchtigkeit</dt>
                    <dd className="tabular-nums">
                      {report.now.humidity} % Feuchte
                    </dd>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Wind size={14} className="text-cyan-300" aria-hidden="true" />
                    <dt className="sr-only">Wind</dt>
                    <dd className="tabular-nums">
                      {report.now.windSpeed} km/h{" "}
                      {compassLabel(report.now.windDirection)}
                    </dd>
                  </div>
                </dl>

                {report.hourly.length > 0 && (
                  <ol
                    aria-label="Stündliche Vorhersage"
                    className="grid grid-cols-3 gap-2 sm:grid-cols-6"
                  >
                    {report.hourly.map((hour) => (
                      <li
                        key={hour.time}
                        className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-2 py-2 text-center"
                      >
                        <p className="text-[11px] tabular-nums text-slate-500">
                          {hourLabel(hour.time)}
                        </p>
                        <div className="mt-1 flex justify-center text-cyan-200/80">
                          <ConditionIcon
                            code={hour.code}
                            isDay={true}
                            size={17}
                          />
                        </div>
                        <p className="mt-1 text-xs font-medium tabular-nums">
                          {hour.temperature}°
                        </p>
                      </li>
                    ))}
                  </ol>
                )}

                {report.daily.length > 0 && (
                  <ol
                    aria-label="Tagesvorhersage"
                    className="grid grid-cols-5 gap-2"
                  >
                    {report.daily.map((day, index) => (
                      <li
                        key={day.date}
                        className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-2 py-2 text-center"
                      >
                        <p className="text-[11px] text-slate-500">
                          {index === 0 ? "Heute" : dayLabel(day.date)}
                        </p>
                        <div className="mt-1 flex justify-center text-cyan-200/80">
                          <ConditionIcon
                            code={day.code}
                            isDay={true}
                            size={17}
                          />
                        </div>
                        <p className="mt-1 text-xs tabular-nums">
                          <span className="font-medium">{day.high}°</span>{" "}
                          <span className="text-slate-500">{day.low}°</span>
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          ) : null}

          {error !== null && report !== null && (
            <div
              role="alert"
              className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-300/25 bg-amber-300/5 px-3 py-2 text-xs text-amber-100"
            >
              <span className="min-w-0 flex-1">
                Aktualisierung fehlgeschlagen – letzte Daten vom{" "}
                {updatedLabel(report.fetchedAt) || "–"} Uhr werden angezeigt.
              </span>
              <button
                onClick={retry}
                className="rounded-lg border border-amber-300/30 px-2.5 py-1 transition hover:bg-amber-300/10"
              >
                Erneut versuchen
              </button>
            </div>
          )}
        </div>

        <p className="mt-4 text-[11px] text-slate-600">
          Quelle: Open-Meteo
        </p>
      </div>
    </section>
  );
}
