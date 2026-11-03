/**
 * Morning Briefing schedule tests:
 * - defaults are 07:30 Europe/Berlin, enabled;
 * - strict validation (time, timezone, city, interests);
 * - due-check honors the user's timezone (incl. DST) and fires at
 *   most once per local day; disabled or already-served → not due.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BRIEFING_SETTINGS_KEY,
  BRIEFING_TIME_DEFAULT,
  BRIEFING_TIMEZONE_DEFAULT,
  DEFAULT_BRIEFING_SETTINGS,
  describeSchedule,
  isBriefingSettings,
  isBriefingTime,
  isTimezone,
  isBriefingDue,
  localDateInTimezone,
} from "@/src/lib/briefing/schedule";

describe("briefing schedule defaults", () => {
  it("defaults to 07:30 Europe/Berlin, enabled", () => {
    assert.equal(BRIEFING_TIME_DEFAULT, "07:30");
    assert.equal(BRIEFING_TIMEZONE_DEFAULT, "Europe/Berlin");
    assert.deepEqual(DEFAULT_BRIEFING_SETTINGS, {
      enabled: true,
      time: "07:30",
      timezone: "Europe/Berlin",
      city: null,
      interests: "",
    });
    assert.equal(typeof BRIEFING_SETTINGS_KEY, "string");
  });

  it("validates times strictly", () => {
    assert.equal(isBriefingTime("07:30"), true);
    assert.equal(isBriefingTime("00:00"), true);
    assert.equal(isBriefingTime("23:59"), true);
    assert.equal(isBriefingTime("7:30"), false);
    assert.equal(isBriefingTime("24:00"), false);
    assert.equal(isBriefingTime("07:60"), false);
    assert.equal(isBriefingTime(""), false);
    assert.equal(isBriefingTime(null), false);
  });

  it("validates timezones via Intl", () => {
    assert.equal(isTimezone("Europe/Berlin"), true);
    assert.equal(isTimezone("UTC"), true);
    assert.equal(isTimezone("America/New_York"), true);
    assert.equal(isTimezone("Mars/Olympus"), false);
    assert.equal(isTimezone(""), false);
    assert.equal(isTimezone(null), false);
  });

  it("validates whole settings objects", () => {
    assert.equal(isBriefingSettings(DEFAULT_BRIEFING_SETTINGS), true);
    assert.equal(
      isBriefingSettings({ ...DEFAULT_BRIEFING_SETTINGS, time: "7:30" }),
      false,
    );
    assert.equal(
      isBriefingSettings({ ...DEFAULT_BRIEFING_SETTINGS, timezone: "xx" }),
      false,
    );
    assert.equal(
      isBriefingSettings({ ...DEFAULT_BRIEFING_SETTINGS, city: {} }),
      false,
    );
    assert.equal(
      isBriefingSettings({
        ...DEFAULT_BRIEFING_SETTINGS,
        city: {
          name: "München",
          latitude: 48.13,
          longitude: 11.57,
          detail: "",
        },
      }),
      true,
    );
  });
});

describe("localDateInTimezone", () => {
  it("resolves the Berlin calendar date across the UTC midnight boundary", () => {
    // 2026-07-01 00:30 CEST = 2026-06-30 22:30 UTC → Berlin date is 07-01.
    assert.equal(
      localDateInTimezone(new Date("2026-06-30T22:30:00Z"), "Europe/Berlin"),
      "2026-07-01",
    );
    assert.equal(
      localDateInTimezone(new Date("2026-06-30T21:30:00Z"), "Europe/Berlin"),
      "2026-06-30",
    );
  });

  it("falls back to UTC for invalid timezones without throwing", () => {
    assert.equal(
      localDateInTimezone(new Date("2026-06-30T22:30:00Z"), "Mars/Olympus"),
      "2026-06-30",
    );
  });
});

describe("isBriefingDue", () => {
  const settings = { ...DEFAULT_BRIEFING_SETTINGS };

  it("is not due before the scheduled Berlin time (winter, CET)", () => {
    // 06:29 UTC = 07:29 CET.
    assert.equal(
      isBriefingDue(settings, new Date("2026-11-03T06:29:00Z"), null),
      false,
    );
  });

  it("is due once the scheduled Berlin time is reached (winter, CET)", () => {
    assert.equal(
      isBriefingDue(settings, new Date("2026-11-03T06:30:00Z"), null),
      true,
    );
    // Late dispatch runs still serve the same day.
    assert.equal(
      isBriefingDue(settings, new Date("2026-11-03T18:00:00Z"), null),
      true,
    );
  });

  it("honors daylight saving time (summer, CEST)", () => {
    // 05:29 UTC = 07:29 CEST → not due; 05:30 UTC = 07:30 CEST → due.
    assert.equal(
      isBriefingDue(settings, new Date("2026-07-01T05:29:00Z"), null),
      false,
    );
    assert.equal(
      isBriefingDue(settings, new Date("2026-07-01T05:30:00Z"), null),
      true,
    );
  });

  it("fires at most once per local day", () => {
    assert.equal(
      isBriefingDue(settings, new Date("2026-11-03T06:30:00Z"), "2026-11-03"),
      false,
    );
    // Yesterday's send does not block today.
    assert.equal(
      isBriefingDue(settings, new Date("2026-11-03T06:30:00Z"), "2026-11-02"),
      true,
    );
  });

  it("respects the enabled flag and custom schedules", () => {
    assert.equal(
      isBriefingDue(
        { ...settings, enabled: false },
        new Date("2026-11-03T18:00:00Z"),
        null,
      ),
      false,
    );
    assert.equal(
      isBriefingDue(
        { enabled: true, time: "06:00", timezone: "UTC" },
        new Date("2026-11-03T05:59:00Z"),
        null,
      ),
      false,
    );
    assert.equal(
      isBriefingDue(
        { enabled: true, time: "06:00", timezone: "UTC" },
        new Date("2026-11-03T06:00:00Z"),
        null,
      ),
      true,
    );
  });

  it("never throws on invalid timezones (fails closed)", () => {
    assert.equal(
      isBriefingDue(
        { enabled: true, time: "07:30", timezone: "Mars/Olympus" },
        new Date("2026-11-03T18:00:00Z"),
        null,
      ),
      false,
    );
  });
});

describe("describeSchedule", () => {
  it("describes enabled and disabled schedules", () => {
    assert.equal(
      describeSchedule(DEFAULT_BRIEFING_SETTINGS),
      "Täglich um 07:30 (Europe/Berlin)",
    );
    assert.equal(
      describeSchedule({ ...DEFAULT_BRIEFING_SETTINGS, enabled: false }),
      "Morgen-Briefing ist deaktiviert.",
    );
  });
});
