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
 * A numeric zone after a time (`12:00:00 -0500`, `12:00 GMT+0200 (CEST)`) on
 * a value outside the W3C format. After a time only: in `10-09-2024` the
 * `-2024` is not a zone.
 */
const NUMERIC_ZONE =
  /\d:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:GMT|UTC)?\s*([+-])(\d{2}):?(\d{2})\s*(?:\([^)]*\))?\s*$/i;
/** Zone names `Date` understands, with their offsets in minutes. */
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
const NAMED_ZONE = /\b(z|ut|utc|gmt|[ecmp][sd]t)\b/i;

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

/** The W3C forms, or null when `value` is not one. */
function w3cForm(value: string): DatePeriod | null {
  const year = YEAR.exec(value);
  if (year) {
    const y = Number(year[1]);
    return { start: utcMonthStart(y, 0), end: utcMonthStart(y + 1, 0) - 1, precision: "year" };
  }
  const month = YEAR_MONTH.exec(value);
  if (month) {
    const y = Number(month[1]);
    const m = Number(month[2]);
    return { start: utcMonthStart(y, m - 1), end: utcMonthStart(y, m) - 1, precision: "month" };
  }
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
 * A value outside the W3C format that names its zone (`Tue, 10 Sep 2024
 * 12:00:00 GMT`, `… -0500`): the instant `Date` reads, which does not depend
 * on the machine, and the day as written. Null without a zone.
 */
function zonedForm(value: string): DatePeriod | null {
  const numeric = NUMERIC_ZONE.exec(value);
  const named = numeric ? null : NAMED_ZONE.exec(value);
  if (!numeric && !named) return null;
  const instant = new Date(value).getTime();
  if (Number.isNaN(instant)) return null;
  const offsetMinutes = numeric
    ? (numeric[1] === "-" ? -1 : 1) * (Number(numeric[2]) * 60 + Number(numeric[3]))
    : (NAMED_ZONES[named![1]!.toLowerCase()] ?? 0);
  return { start: instant, end: instant, precision: "instant", day: isoDay(instant + offsetMinutes * 60_000) };
}

/**
 * The period a sitemap `lastmod` names, or null when it is not a usable date.
 * A W3C Datetime is read exactly (a datetime with no zone, in UTC). A value in
 * another format is read only when it names its zone; one that does not
 * (`2024/09/10`, `2024-9`) is null rather than read at the machine's local
 * time.
 */
export function w3cDatePeriod(value: string | null | undefined): DatePeriod | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return w3cForm(trimmed) ?? zonedForm(trimmed);
}

/**
 * The period a page's own date names (a schema `dateModified`, a visible
 * date), which need not follow the W3C format: as {@link w3cDatePeriod}, and a
 * value with no zone in another format (`September 10, 2024`, `2024/09/10
 * 08:00`) read as written, in UTC. A day when no time is written.
 */
export function looseDatePeriod(value: string | null | undefined): DatePeriod | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const exact = w3cDatePeriod(trimmed);
  if (exact) return exact;
  // `Date` reads a value with no zone at local time, so its local fields are
  // what was written; read them again as UTC.
  const local = new Date(trimmed);
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
  return /\d:\d/.test(trimmed)
    ? { start: wall, end: wall, precision: "instant", day }
    : wholeDay(wall, day);
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
