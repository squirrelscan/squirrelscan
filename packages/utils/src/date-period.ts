// A date as the period it names (#758, #772), read the same way on every
// machine. The W3C Datetime format the sitemap protocol uses allows `YYYY`,
// `YYYY-MM` and `YYYY-MM-DD`: a bare year, month or day names that whole
// period, not its first instant. Read as an instant (`new Date("2024")` is
// 2024-01-01T00:00Z), a year-stamped lastmod looks months behind every page
// dated later that year. And `new Date` reads a value with no zone
// (`2024/09/10`, `2024-09-10T12:00:00`) at the host's local time, so the same
// sitemap measured differently on a laptop and on a server.

export interface DatePeriod {
  /** First millisecond of the period, UTC. */
  start: number;
  /** Last millisecond of the period, UTC. Equal to `start` for an instant. */
  end: number;
  /** `year`, `month` and `day` for the date-only forms, `instant` for a time. */
  precision: "year" | "month" | "day" | "instant";
  /**
   * The calendar day the value names, as written: `2024-09-10` for
   * `2024-09-10T23:30:00-05:00`, which is the 11th in UTC. Absent for a year
   * or a month, which name no day.
   */
  day?: string;
}

const DAY_MS = 86_400_000;

const YEAR = /^(\d{4})$/;
const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/**
 * A W3C datetime. Two common slips are read too, in UTC as nothing else would
 * be the same everywhere: a space for the `T`, and no zone.
 */
const DATE_TIME =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:[.,](\d+))?)?\s*(Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/i;
/**
 * Starts like an ISO date (`2024-9`, `2024-09-31`, `+002024-09-10`). `Date`
 * reads some such values in UTC and others at local time, so one the W3C
 * forms above reject is not read at all.
 */
const ISO_SHAPED = /^[+-]?\d{4,6}-\d/;

/**
 * A numeric zone after a time, at the end (`12:00:00 -0500`, `11:00 PM
 * GMT-05:00`, `23:00 +2`). After a time only: in `10-09-2024` the `-2024` is
 * not a zone.
 */
const NUMERIC_ZONE = /(?<=\d:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[AP]\.?M\.?)?\s*)(?:(?:GMT|UTC|UT)\s*)?([+-])(\d{1,2})(?::?(\d{2}))?$/i;
/** Zone names `Date` understands, at the end, with their offsets in minutes. */
const NAMED_ZONE = /(?:(?<=\d)|\b)(z|ut|utc|gmt|[ecmp][sd]t)$/i;
const NAMED_ZONES: Record<string, number> = {
  z: 0,
  ut: 0,
  utc: 0,
  gmt: 0,
  est: -300,
  edt: -240,
  cst: -360,
  cdt: -300,
  mst: -420,
  mdt: -360,
  pst: -480,
  pdt: -420,
};
/** A month and year written out (`September 2024`, `Sep. 2024`). */
const MONTH_YEAR = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})$/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** A month named anywhere in a value. */
const MONTH_NAME = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
/** A year and month with a slash or a dot (`2024/09`, `2024.9`), which `Date` reads as the 1st. */
const YEAR_SLASH_MONTH = /^(\d{4})[/.](0?[1-9]|1[0-2])$/;

/**
 * Milliseconds since the epoch of the given UTC fields, or null when they name
 * no real date (`2024-02-30`). Not `Date.UTC`, which maps years 0 to 99 onto
 * 1900 to 1999.
 */
function utcTime(
  year: number,
  month: number,
  day: number,
  hours = 0,
  minutes = 0,
  seconds = 0,
  ms = 0,
): number | null {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  date.setUTCHours(hours, minutes, seconds, ms);
  return date.getTime();
}

/** The first millisecond of month `month` (0-based, may overflow into the next year), UTC. */
function utcMonthStart(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 1);
  return date.getTime();
}

/** `YYYY-MM-DD` of a UTC instant. */
function isoDay(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function wholeDay(start: number, day: string): DatePeriod {
  return { start, end: start + DAY_MS - 1, precision: "day", day };
}

function wholeMonth(year: number, month: number): DatePeriod {
  return { start: utcMonthStart(year, month), end: utcMonthStart(year, month + 1) - 1, precision: "month" };
}

/** The W3C forms, or null when `value` is not one. */
function w3cForm(value: string): DatePeriod | null {
  const year = YEAR.exec(value);
  if (year) {
    const y = Number(year[1]);
    return { start: utcMonthStart(y, 0), end: utcMonthStart(y + 1, 0) - 1, precision: "year" };
  }
  const month = YEAR_MONTH.exec(value);
  if (month) return wholeMonth(Number(month[1]), Number(month[2]) - 1);
  const date = DATE.exec(value);
  if (date) {
    const start = utcTime(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    return start === null ? null : wholeDay(start, value);
  }
  const dateTime = DATE_TIME.exec(value);
  if (dateTime) {
    const [, y, mo, d, h, mi, s, fraction, zone] = dateTime;
    const ms = fraction ? Number(fraction.slice(0, 3).padEnd(3, "0")) : 0;
    const wall = utcTime(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0), ms);
    if (wall === null) return null;
    let offsetMinutes = 0;
    if (zone && zone.toUpperCase() !== "Z") {
      const digits = zone.replace(":", "");
      offsetMinutes = (zone[0] === "-" ? -1 : 1) * (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5)));
    }
    const instant = wall - offsetMinutes * 60_000;
    return { start: instant, end: instant, precision: "instant", day: `${y}-${mo}-${d}` };
  }
  return null;
}

/**
 * A value outside the W3C format, read as written: `Date` reads one with no
 * zone at local time, so its local fields are what was written, and they are
 * read again here as UTC. A day when no time is written, a month for a month
 * and year written out. Null for a value `Date` cannot read, one shaped like
 * an ISO date (which `Date` may read in UTC instead), and one that does not
 * write a whole date (`Tuesday 2024`), whose missing fields `Date` makes up.
 */
function writtenForm(value: string): DatePeriod | null {
  if (ISO_SHAPED.test(value)) return null;
  const monthYear = MONTH_YEAR.exec(value);
  if (monthYear) return wholeMonth(Number(monthYear[2]), MONTHS.indexOf(monthYear[1]!.toLowerCase()));
  const yearMonth = YEAR_SLASH_MONTH.exec(value);
  if (yearMonth) return wholeMonth(Number(yearMonth[1]), Number(yearMonth[2]) - 1);
  // A year, a month and a day: three numbers, or a month name and two.
  const numbers = value.match(/\d+/g)?.length ?? 0;
  if (numbers < 3 && !(numbers === 2 && MONTH_NAME.test(value))) return null;
  const local = new Date(value);
  if (Number.isNaN(local.getTime())) return null;
  const wall = utcTime(
    local.getFullYear(),
    local.getMonth(),
    local.getDate(),
    local.getHours(),
    local.getMinutes(),
    local.getSeconds(),
    local.getMilliseconds(),
  );
  if (wall === null) return null;
  const day = isoDay(wall);
  return /\d:\d/.test(value) ? { start: wall, end: wall, precision: "instant", day } : wholeDay(wall, day);
}

/** `period` moved back by a zone's offset: a time written in that zone, in UTC. */
function inZone(period: DatePeriod, offsetMinutes: number): DatePeriod {
  if (period.precision !== "instant") return period;
  const instant = period.start - offsetMinutes * 60_000;
  return { ...period, start: instant, end: instant };
}

/**
 * The W3C form only, or null. For a value that must follow the sitemap
 * protocol, where anything else is worth reporting.
 */
export function w3cDatePeriod(value: string | null | undefined): DatePeriod | null {
  const trimmed = value?.trim();
  return trimmed ? w3cForm(trimmed) : null;
}

/**
 * The period a date names, or null when it is not a usable date: a sitemap
 * `lastmod`, a schema `dateModified`, a visible date. A W3C Datetime is read
 * exactly (a datetime with no zone, in UTC). Another format is read as
 * written, in the zone it names (`Tue, 10 Sep 2024 23:30:00 -0500`, `… GMT`,
 * `… EST`) or else in UTC (`September 10, 2024`, `2024/09/10 08:00`), so it
 * reads the same on every machine. A comment in parentheses is ignored.
 */
export function datePeriod(value: string | null | undefined): DatePeriod | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const exact = w3cForm(trimmed);
  if (exact) return exact;
  const bare = trimmed.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const numeric = NUMERIC_ZONE.exec(bare);
  const named = numeric ? null : NAMED_ZONE.exec(bare);
  const zone = numeric ?? named;
  if (!zone) return w3cForm(bare) ?? writtenForm(bare);
  const offsetMinutes = numeric
    ? (numeric[1] === "-" ? -1 : 1) * (Number(numeric[2]) * 60 + Number(numeric[3] ?? 0))
    : (NAMED_ZONES[named![1]!.toLowerCase()] ?? 0);
  const zoneless = bare.slice(0, zone.index).trim();
  const written = w3cForm(zoneless) ?? writtenForm(zoneless);
  return written ? inZone(written, offsetMinutes) : null;
}

/**
 * How far apart two periods are: 0 when they overlap, else the time from the
 * end of the earlier one to the start of the later one.
 */
export function periodGapMs(a: DatePeriod, b: DatePeriod): number {
  if (a.start > b.end) return a.start - b.end;
  if (b.start > a.end) return b.start - a.end;
  return 0;
}
