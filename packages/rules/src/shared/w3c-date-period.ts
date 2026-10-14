// A sitemap `lastmod` as the period it names (#758). The W3C Datetime format
// the sitemap protocol uses allows `YYYY` and `YYYY-MM`: a bare year or
// year-month names that whole year or month, not its first day. Read as an
// instant (`new Date("2024")` is 2024-01-01T00:00Z), a year-stamped lastmod
// looks months behind every page dated later that year.

export interface DatePeriod {
  /** First millisecond of the period, UTC. */
  start: number;
  /** Last millisecond of the period, UTC. Equal to `start` for an instant. */
  end: number;
  /** `year` and `month` for the coarse forms, `instant` for anything finer. */
  precision: "year" | "month" | "instant";
}

const YEAR = /^\s*(\d{4})\s*$/;
const YEAR_MONTH = /^\s*(\d{4})-(0[1-9]|1[0-2])\s*$/;

/**
 * The first millisecond of month `month` (0-based, may overflow into the next
 * year) of `year`, UTC. Not `Date.UTC`, which maps years 0 to 99 onto 1900 to
 * 1999.
 */
function utcMonthStart(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 1);
  return date.getTime();
}

/** The period `value` names, or null when it is not a usable date. */
export function w3cDatePeriod(value: string | null | undefined): DatePeriod | null {
  if (!value) return null;
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
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : { start: ms, end: ms, precision: "instant" };
}
