// #758, #772: a date as the period it names, read the same way on every
// machine. `new Date` reads a value with no zone at the host's local time, so
// these tests switch the process time zone and expect the same answer.

import { describe, expect, test } from "bun:test";

import { looseDatePeriod, periodGapMs, w3cDatePeriod } from "../src/date-period";

const ZONES = ["UTC", "America/New_York", "Asia/Tokyo", "Pacific/Kiritimati"];

/** `read` under each time zone in turn; the process zone is restored after. */
function inEveryZone<T>(read: () => T): T[] {
  const prior = process.env.TZ;
  try {
    return ZONES.map((zone) => {
      process.env.TZ = zone;
      return read();
    });
  } finally {
    if (prior === undefined) delete process.env.TZ;
    else process.env.TZ = prior;
  }
}

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

  test("another format is read only when it names its zone", () => {
    expect(
      inEveryZone(() => {
        const period = w3cDatePeriod("Tue, 10 Sep 2024 23:30:00 -0500");
        return [period?.start, period?.day];
      }),
    ).toEqual(ZONES.map(() => [Date.UTC(2024, 8, 11, 4, 30), "2024-09-10"]));
    expect(w3cDatePeriod("Tue, 10 Sep 2024 12:00:00 GMT")?.start).toBe(Date.UTC(2024, 8, 10, 12));
    expect(w3cDatePeriod("Tue, 10 Sep 2024 22:00:00 EST")?.day).toBe("2024-09-10");
    for (const value of ["2024-9", "2024-09-1", "2024/09", "2024/09/10", "10-09-2024", "Sep 10, 2024"]) {
      expect(inEveryZone(() => w3cDatePeriod(value))).toEqual(ZONES.map(() => null));
    }
  });
});

describe("looseDatePeriod", () => {
  test("a page's own date in another format is read as written, in UTC", () => {
    expect(inEveryZone(() => looseDatePeriod("September 10, 2024"))).toEqual(
      ZONES.map(() => ({
        start: Date.UTC(2024, 8, 10),
        end: Date.UTC(2024, 8, 11) - 1,
        precision: "day",
        day: "2024-09-10",
      })),
    );
    expect(inEveryZone(() => looseDatePeriod("2024/09/10 08:00")?.start)).toEqual(
      ZONES.map(() => Date.UTC(2024, 8, 10, 8)),
    );
    expect(looseDatePeriod("2024")?.precision).toBe("year");
    expect(looseDatePeriod("last tuesday")).toBeNull();
  });
});

describe("periodGapMs", () => {
  test("0 when the periods overlap, else between their nearer ends", () => {
    const year = w3cDatePeriod("2024")!;
    const day = w3cDatePeriod("2024-09-10")!;
    expect(periodGapMs(year, day)).toBe(0);
    const later = w3cDatePeriod("2024-09-13T00:00:00Z")!;
    expect(periodGapMs(day, later)).toBe(2 * 86_400_000 + 1);
    expect(periodGapMs(later, day)).toBe(2 * 86_400_000 + 1);
  });
});
