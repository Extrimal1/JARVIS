import { NextResponse } from "next/server";
import { fail, failFromUnknown, ok } from "@/src/lib/api/respond";
import {
  getWeatherReport,
  WeatherProviderError,
} from "@/src/lib/weatherProvider";

/**
 * GET /api/weather/forecast?latitude=&longitude=&name=&detail=
 * Public (no login): Open-Meteo data needs no key and carries no user
 * data. Responses are cached in-memory for 10 minutes per ~1km cell so
 * reloads and the 15-minute client refresh never hammer the provider.
 * Never fabricates readings: provider failures surface as errors.
 */

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const latitude = Number(url.searchParams.get("latitude"));
    const longitude = Number(url.searchParams.get("longitude"));
    const name = (url.searchParams.get("name") ?? "").slice(0, 120);
    const detail = (url.searchParams.get("detail") ?? "").slice(0, 160);

    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      return fail("bad-request", "Ungültige Koordinaten.", 400);
    }

    try {
      const report = await getWeatherReport({
        latitude,
        longitude,
        name,
        detail,
      });

      return ok(report);
    } catch (error) {
      if (error instanceof WeatherProviderError) {
        return fail("upstream-error", error.message, 502);
      }

      throw error;
    }
  } catch (error) {
    return failFromUnknown("weather/forecast", error);
  }
}
