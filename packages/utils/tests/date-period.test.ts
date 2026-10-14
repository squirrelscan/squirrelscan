// #758, #772: a date as the period it names, read the same way on every
// machine. `new Date` reads a value with no zone at the host's local time, so
// these tests switch the process time zone and expect the same answer.

import { describe, expect, test } from "bun:test";

import { datePeriod, periodGapMs, w3cDatePeriod } from "../src/date-period";

const ZONES = ["UTC", "America/New_York", "Asia/Tokyo", "Pacific/Kiritimati"];
/** Offset of 1 January 2024 in each zone, as `getTimezoneOffset` gives it. */
const JANUARY_OFFSETS = [0, 300, -540, -840];

// The zone to put back. Bun keeps the last zone set when `TZ` is deleted, and
// then ignores later assignments, so it is always assigned, never deleted.
const ORIGINAL_ZONE = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

/** `read` under each time zone in turn; the process zone is restored after. */
function inEveryZone<T>(read: () => T): T[] {
  try {
    return ZONES.map((zone) => {
      process.env.TZ = zone;
      return read();
    });
  } finally {
    process.env.TZ = ORIGINAL_ZONE;
  }
}

test("the zone switch takes effect for every zone", () => {
  expect(inEveryZone(() => new Date(2024, 0, 1).getTimezoneOffset())).toEqual(JANUARY_OFFSETS);
  expect(inEveryZone(() => new Date(2024, 0, 1).getTimezoneOffset())).toEqual(JANUARY_OFFSETS);
});

describe("w3cDatePeriod", () => {
  test("a date with no time is the whole day, in UTC", () => {
    expect(w3cDatePeriod("2024-09-10")).toEqual({
      start: Date.UTC(2024, 8, 10),
      end: Date.UTC(2024, 8, 11) - 1,
      precision: "day",
      day: "2024-09-10",
    });
    expect(w3cDatePeriod("2024-02-30")).toBeNull();
    expect(w3cDatePeriod("2023-02-29")).toBeNull();
    expect(w3cDatePeriod("2024-02-29")?.day).toBe("2024-02-29");
  });

  test("a datetime is an instant, and keeps the day it was written on", () => {
    expect(w3cDatePeriod("2024-09-10T23:30:00-05:00")).toEqual({
      start: Date.UTC(2024, 8, 11, 4, 30),
      end: Date.UTC(2024, 8, 11, 4, 30),
      precision: "instant",
      day: "2024-09-10",
    });
    expect(w3cDatePeriod("2024-09-10T08:00+0530")?.start).toBe(Date.UTC(2024, 8, 10, 2, 30));
    expect(w3cDatePeriod("2024-09-10T08:00:00.25Z")?.start).toBe(Date.UTC(2024, 8, 10, 8, 0, 0, 250));
  });

  test("a datetime with no zone, or a space for the T, is read in UTC on every machine", () => {
    const expected = Date.UTC(2024, 8, 10, 12);
    for (const value of ["2024-09-10T12:00:00", "2024-09-10 12:00:00", "2024-09-10T12:00"]) {
      expect(inEveryZone(() => w3cDatePeriod(value)?.start)).toEqual(ZONES.map(() => expected));
    }
  });

  test("anything outside the W3C forms is null", () => {
    for (const value of ["2024/09/10", "Tue, 10 Sep 2024 12:00:00 GMT", "2024-9", "September 2024"]) {
      expect(w3cDatePeriod(value)).toBeNull();
    }
  });
});

describe("datePeriod", () => {
  test("reads the W3C forms as w3cDatePeriod does", () => {
    for (const value of ["2024", "2024-09", "2024-09-10", "2024-09-10T23:30:00-05:00"]) {
      expect(datePeriod(value)).toEqual(w3cDatePeriod(value));
    }
  });

  test("a value that names its zone is read in that zone, with the day as written", () => {
    const cases: Array<[string, number, string]> = [
      ["Tue, 10 Sep 2024 23:30:00 -0500", Date.UTC(2024, 8, 11, 4, 30), "2024-09-10"],
      ["Tue, 10 Sep 2024 12:00:00 GMT", Date.UTC(2024, 8, 10, 12), "2024-09-10"],
      ["Tue, 10 Sep 2024 22:00:00 EST", Date.UTC(2024, 8, 11, 3), "2024-09-10"],
      ["Sep 10 2024 11:00 PM GMT-0500", Date.UTC(2024, 8, 11, 4), "2024-09-10"],
      ["Sep 10 2024 23:00 +2", Date.UTC(2024, 8, 10, 21), "2024-09-10"],
      ["Sep 10 2024 12:00:00Z", Date.UTC(2024, 8, 10, 12), "2024-09-10"],
      // A comment in parentheses is ignored, zone name or not.
      ["Tue Sep 10 2024 12:00:00 GMT+0200 (Central European Summer Time)", Date.UTC(2024, 8, 10, 10), "2024-09-10"],
      ["Sep 10 2024 12:00 (EST)", Date.UTC(2024, 8, 10, 12), "2024-09-10"],
    ];
    for (const [value, start, day] of cases) {
      expect(inEveryZone(() => [datePeriod(value)?.start, datePeriod(value)?.day])).toEqual(
        ZONES.map(() => [start, day]),
      );
    }
    // A coarse value with a zone is still its whole period.
    expect(datePeriod("2024 GMT")?.precision).toBe("year");
    expect(datePeriod("2024-09-10Z")).toMatchObject({ precision: "day", day: "2024-09-10" });
    expect(datePeriod("2024-09-10 GMT")?.precision).toBe("day");
  });

  test("a value with no zone in another format is read as written, in UTC", () => {
    const cases: Array<[string, Partial<ReturnType<typeof datePeriod>>]> = [
      ["September 10, 2024", { start: Date.UTC(2024, 8, 10), precision: "day", day: "2024-09-10" }],
      ["2024/09/10", { start: Date.UTC(2024, 8, 10), precision: "day", day: "2024-09-10" }],
      ["2024/09/10 08:00", { start: Date.UTC(2024, 8, 10, 8), precision: "instant", day: "2024-09-10" }],
      ["Tue, 10 Sep 2024", { start: Date.UTC(2024, 8, 10), precision: "day" }],
      ["September 2024", { start: Date.UTC(2024, 8, 1), end: Date.UTC(2024, 9, 1) - 1, precision: "month" }],
      ["2024/09", { start: Date.UTC(2024, 8, 1), end: Date.UTC(2024, 9, 1) - 1, precision: "month" }],
    ];
    for (const [value, expected] of cases) {
      for (const period of inEveryZone(() => datePeriod(value))) expect(period).toMatchObject(expected);
    }
  });

  test("an ISO-shaped value the W3C forms reject, or no date at all, is null on every machine", () => {
    for (const value of [
      "2024-9",
      "2024-09-1",
      "2024-9-10",
      "2024-09-31",
      "2024-02-30T12:00:00Z",
      "2024-09-10T24:00:00Z",
      "+002024-09-10",
      "last tuesday",
      "Tuesday 2024",
    ]) {
      expect(inEveryZone(() => datePeriod(value))).toEqual(ZONES.map(() => null));
    }
  });
});

describe("periodGapMs", () => {
  test("0 when the periods overlap, else between their nearer ends", () => {
    const year = datePeriod("2024")!;
    const day = datePeriod("2024-09-10")!;
    expect(periodGapMs(year, day)).toBe(0);
    const later = datePeriod("2024-09-13T00:00:00Z")!;
    expect(periodGapMs(day, later)).toBe(2 * 86_400_000 + 1);
    expect(periodGapMs(later, day)).toBe(2 * 86_400_000 + 1);
  });
});
