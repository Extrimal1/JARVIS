"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalStorage } from "@/src/hooks/useLocalStorage";
import {
  DEFAULT_CITY,
  WEATHER_CITY_KEY,
  isWeatherCity,
  isWeatherReport,
  type WeatherCity,
  type WeatherReport,
} from "@/src/lib/weather";

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export type WeatherStore = {
  city: WeatherCity;
  report: WeatherReport | null;
  /** First load without data yet. */
  loading: boolean;
  /** Background refresh while stale data stays visible. */
  refreshing: boolean;
  error: string | null;
  setCity: (city: WeatherCity) => void;
  resetCity: () => void;
  retry: () => void;
};

/**
 * Device-local weather state. The city persists in localStorage (no
 * schema change, works in local mode); reports refresh every 15 minutes
 * and keep the last good data visible when a refresh fails.
 */
export function useWeather(): WeatherStore {
  const [city, setCityState, cityLoaded] = useLocalStorage<WeatherCity>(
    WEATHER_CITY_KEY,
    DEFAULT_CITY,
    isWeatherCity,
  );
  const [report, setReport] = useState<WeatherReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const requestId = useRef(0);

  const load = useCallback(
    async (target: WeatherCity, hasReport: boolean, signal: AbortSignal) => {
      const id = requestId.current + 1;
      requestId.current = id;

      if (hasReport) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);

      try {
        const params = new URLSearchParams({
          latitude: String(target.latitude),
          longitude: String(target.longitude),
          name: target.name,
          detail: target.detail,
        });
        const res = await fetch(`/api/weather/forecast?${params}`, {
          signal,
        });
        const parsed: unknown = await res.json().catch(() => null);

        if (requestId.current !== id) return;

        if (
          !res.ok ||
          typeof parsed !== "object" ||
          parsed === null ||
          (parsed as { ok?: unknown }).ok !== true ||
          !isWeatherReport((parsed as { data?: unknown }).data)
        ) {
          const message =
            typeof parsed === "object" &&
            parsed !== null &&
            "error" in parsed &&
            typeof (parsed as { error: { message?: unknown } }).error
              ?.message === "string"
              ? (parsed as { error: { message: string } }).error.message
              : "Wetterdaten konnten nicht geladen werden.";
          setError(message);
          return;
        }

        setReport((parsed as { data: WeatherReport }).data);
      } catch (unknown) {
        if (
          requestId.current === id &&
          !(unknown instanceof DOMException && unknown.name === "AbortError")
        ) {
          setError(
            typeof navigator !== "undefined" && !navigator.onLine
              ? "Du bist offline. Verbinde dich und versuche es erneut."
              : "Wetterdienst nicht erreichbar. Bitte versuche es später erneut.",
          );
        }
      } finally {
        if (requestId.current === id) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!cityLoaded) return;

    const controller = new AbortController();
    // Mount/city-gated fetch plus refresh interval (stale responses ignored).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(city, report !== null, controller.signal);

    const intervalId = window.setInterval(() => {
      const refreshController = new AbortController();
      void load(city, true, refreshController.signal);
    }, REFRESH_INTERVAL_MS);

    return () => {
      controller.abort();
      window.clearInterval(intervalId);
    };
    // `report !== null` intentionally read once per city/nonce change:
    // it only decides skeleton vs. background-refresh styling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city, cityLoaded, nonce, load]);

  const setCity = useCallback(
    (next: WeatherCity) => {
      setCityState(next);
    },
    [setCityState],
  );

  const resetCity = useCallback(() => {
    setCityState(DEFAULT_CITY);
  }, [setCityState]);

  const retry = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return {
    city,
    report,
    loading,
    refreshing,
    error,
    setCity,
    resetCity,
    retry,
  };
}
