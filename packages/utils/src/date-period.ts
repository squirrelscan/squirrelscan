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
const NUMERIC_ZONE = /\d:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[AP]\.?M\.?)?\s*((?:(?:GMT|UTC|UT)\s*)?([+-])(\d{1,2})(?::?(\d{2}))?)$/i;
/** Zone names `Date` understands, at the end, with their offsets in minutes. */
const NAMED_ZONE = /(?:^|[^a-z])(z|ut|utc|gmt|[ecmp][sd]t)$/i;
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
/** An English month name or its usual abbreviation, nothing longer (`Junk` is not June). */
const MONTH_WORD =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
/** A month and year written out (`September 2024`, `Sep. 2024`). */
const MONTH_YEAR = new RegExp(`^${MONTH_WORD}\\.?,?\\s+(\\d{4})$`, "i");
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** A month named anywhere in a value. */
const MONTH_NAME = new RegExp(`\\b${MONTH_WORD}\\b`, "i");
/** A time of day (`12:00`, `08:30:15.5`): its numbers are not part of the date. */
const TIME_OF_DAY = /\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?/g;
/**
 * A zone anywhere in a value: a zone name or a numeric offset with no letter
 * or digit against it (`EST;`, `"GMT"`, `,+0200`), or an offset glued to a
 * time (`12:00+0200`). `Date` applies one wherever it sits, whatever
 * punctuation wraps it, so a value with a zone that is not at its end
 * (`Sep 10 2024 EST 12:00`) cannot be read the same on every machine and is
 * not read at all. No lookbehind here or in the zone patterns above: JSC runs
 * those in its slow interpreter, quadratic even under the length cap.
 */
const ZONE_TOKEN =
  /(?:^|[^a-z])(?:z|ut|utc|gmt|[ecmp][sd]t)(?![a-z])|(?:^|[^\da-z])(?:gmt|utc|ut)?[+-]\d{1,2}(?::?\d{2})?(?!\d)|\d:\d{2}(?::\d{2}(?:[.,]\d+)?)?\s?(?:[ap]\.?m\.?\s?)?[+-]\d/i;
/**
 * Longer than any written date. A page or sitemap can put any text here, and
 * no pattern below should ever run over a megabyte of it.
 */
const MAX_DATE_CHARS = 200;
/**
 * Two times joined by a dash (`12:00-14:00`, `9:00 - 12:30`): a range, not a
 * time and a zone. Read as one, `Sep 10 2024 12:00-14:00` would be 12:00 at
 * offset -14:00 (#793). Which end of it a value means cannot be known, so a
 * value with one is not read.
 */
const TIME_RANGE = /\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?\s*)?[-\u2013\u2014]\s*\d{1,2}:\d{2}/i;
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
 * `value`, which writes no zone, as `Date` reads it in UTC, or null. Read with
 * no zone, `Date` uses the host's local time and shifts a time that local time
 * skips (`2024/03/10 02:30` in America/New_York is 03:30), so the fields would
 * come out an hour off on that machine only (#793). Falls back to the local
 * reading, whose fields are what was written, for a form `Date` reads only
 * without a zone.
 */
function writtenFields(value: string): {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
  ms: number;
} | null {
  const utc = new Date(`${value} UTC`);
  if (!Number.isNaN(utc.getTime())) {
    return {
      year: utc.getUTCFullYear(),
      month: utc.getUTCMonth(),
      day: utc.getUTCDate(),
      hours: utc.getUTCHours(),
      minutes: utc.getUTCMinutes(),
      seconds: utc.getUTCSeconds(),
      ms: utc.getUTCMilliseconds(),
    };
  }
  const local = new Date(value);
  if (Number.isNaN(local.getTime())) return null;
  return {
    year: local.getFullYear(),
    month: local.getMonth(),
    day: local.getDate(),
    hours: local.getHours(),
    minutes: local.getMinutes(),
    seconds: local.getSeconds(),
    ms: local.getMilliseconds(),
  };
}

/**
 * A value outside the W3C format, read as written: the fields `Date` reads
 * from it with no zone (see {@link writtenFields}), as UTC. A day when no time is written, a month for a month
 * and year written out. Null for a value `Date` cannot read, one shaped like
 * an ISO date (which `Date` may read in UTC instead), and one that does not
 * write a whole date (`Tuesday 2024`), whose missing fields `Date` makes up.
 */
function writtenForm(value: string): DatePeriod | null {
  if (ISO_SHAPED.test(value)) return null;
  const monthYear = MONTH_YEAR.exec(value);
  if (monthYear) return wholeMonth(Number(monthYear[2]), monthIndex(monthYear[1]!));
  const yearMonth = YEAR_SLASH_MONTH.exec(value);
  if (yearMonth) return wholeMonth(Number(yearMonth[1]), Number(yearMonth[2]) - 1);
  // A whole date: a four-digit year, and a month and a day, as three numbers
  // or a month name and two. A time's numbers do not count (`Sep 10 12:00`
  // has no year, and `Date` would make one up).
  const numbers = (value.replace(TIME_OF_DAY, " ").match(/\d+/g) ?? []).map(Number);
  const named = MONTH_NAME.exec(value);
  if (!numbers.some((n) => n >= 1000 && n <= 9999)) return null;
  if (numbers.length < 3 && !(numbers.length === 2 && named)) return null;
  const fields = writtenFields(value);
  if (!fields) return null;
  // `Date` rolls an impossible date over (`2024/09/31` to 1 October): the
  // month and day it settled on must be ones the value wrote.
  const monthWritten = named ? monthIndex(named[1]!) === fields.month : numbers.includes(fields.month + 1);
  if (!monthWritten || !numbers.includes(fields.day)) return null;
  const wall = utcTime(
    fields.year,
    fields.month,
    fields.day,
    fields.hours,
    fields.minutes,
    fields.seconds,
    fields.ms,
  );
  if (wall === null) return null;
  const day = isoDay(wall);
  return /\d:\d/.test(value) ? { start: wall, end: wall, precision: "instant", day } : wholeDay(wall, day);
}

/** The 0-based month a month word names. */
function monthIndex(word: string): number {
  return MONTHS.indexOf(word.slice(0, 3).toLowerCase());
}

/**
 * `text` with every parenthesised comment replaced by a space, as `Date`
 * ignores them, nested ones included. One pass: a pattern for this rescans
 * the rest of the text from every unclosed `(`.
 */
function withoutComments(text: string): string {
  let out = "";
  let depth = 0;
  for (const char of text) {
    if (char === "(") {
      if (depth === 0) out += " ";
      depth++;
    } else if (char === ")" && depth > 0) {
      depth--;
    } else if (depth === 0) {
      out += char;
    }
  }
  return out;
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
  if (!trimmed || trimmed.length > MAX_DATE_CHARS) return null;
  const exact = w3cForm(trimmed);
  if (exact) return exact;
  const bare = withoutComments(trimmed).replace(/\s+/g, " ").trim();
  // A W3C value with a comment (`2024-09-10T12:00-05:00 (updated)`) is read as
  // one before the range check, which would take its `12:00-05:00` for a range.
  const exactBare = w3cForm(bare);
  if (exactBare) return exactBare;
  if (TIME_RANGE.test(bare)) return null;
  const numeric = NUMERIC_ZONE.exec(bare);
  const named = numeric ? null : NAMED_ZONE.exec(bare);
  const zone = numeric ?? named;
  if (!zone) return ZONE_TOKEN.test(bare) ? null : (w3cForm(bare) ?? writtenForm(bare));
  let offsetMinutes = NAMED_ZONES[named?.[1]?.toLowerCase() ?? ""] ?? 0;
  if (numeric) {
    const hours = Number(numeric[3]);
    const minutes = Number(numeric[4] ?? 0);
    // A real offset: at most 14 hours, in quarter hours.
    if (hours > 14 || minutes % 15 !== 0 || minutes > 45) return null;
    offsetMinutes = (numeric[2] === "-" ? -1 : 1) * (hours * 60 + minutes);
  }
  const zoneless = bare.slice(0, zone.index + zone[0].length - zone[1]!.length).trim();
  // A second zone left in the value: `Date` would apply that one.
  if (ZONE_TOKEN.test(zoneless)) return null;
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
