// schema/article - Article schema validation

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

const REQUIRED_PROPS = ["headline", "author", "datePublished"];
const RECOMMENDED_PROPS = ["dateModified", "image", "publisher"];
const DATE_PROPS = ["datePublished", "dateModified"] as const;

// schema.org Date/DateTime requires ISO 8601: date-only, or datetime with a T
// separator and an optional Z/±HH:MM offset (offset itself is optional per
// ISO 8601 local-time datetimes). Numeric ranges are constrained (month
// 01-12, day 01-31, hour 00-23, etc.) so out-of-range junk still fails.
// Catches the common real-world offenders: raw DB timestamps (space
// separator, truncated "+00" offset), epoch numbers, RFC 2822 strings,
// DD/MM/YYYY (#1099).
const ISO_8601_PATTERN =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:T(?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// Regex range-checks each field independently, so "2026-02-31" or
// "2026-04-31" (April has 30 days) pass the shape check — verify the day
// actually exists in that month/year.
function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function isValidIso8601Date(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = ISO_8601_PATTERN.exec(value.trim());
  if (!match) return false;
  return isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

export const articleSchemaRule: Rule = {
  meta: {
    id: "schema/article",
    name: "Article Schema",
    description: "Validates Article schema required properties",
    solution:
      "Article schema helps search engines understand news and blog content. Required: headline, author (Person with name), datePublished. Recommended: dateModified, image (ImageObject), publisher (Organization). Use Article for general content, NewsArticle for news, BlogPosting for blogs. Ensure author links to real author pages.",
    category: "schema",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    // ctx.parsed.schemas is built per-<script> (parseSchemas parses each
    // script's JSON individually and recursively flattens @graph), so it
    // finds Article/NewsArticle/BlogPosting wrapped in a Yoast-style @graph
    // without the whole-raw-then-blank-line-split fragility of re-parsing
    // ctx.parsed.schema.raw (multiple scripts joined with "\n\n" — a valid
    // pretty-printed script containing its own blank lines gets mis-split
    // and silently dropped) (#1099).
    const nodes = ctx.parsed.schemas.all;
    let articleSchema: Record<string, unknown> | null = null;

    // Multiple Article-type nodes on a page keep the LAST match (no early
    // break) to match the prior per-script loop's behavior, which only broke
    // out of the inner per-script scan and let later scripts overwrite it.
    for (const schema of nodes) {
      const type = schema["@type"];
      if (
        type === "Article" ||
        type === "NewsArticle" ||
        type === "BlogPosting" ||
        (Array.isArray(type) &&
          type.some((t: string) => ["Article", "NewsArticle", "BlogPosting"].includes(t)))
      ) {
        articleSchema = schema;
      }
    }

    if (!articleSchema) {
      checks.push({
        name: "article-schema",
        status: "info",
        message: "No Article schema found",
        value: "Consider adding for blog/news content",
      });
      return { checks };
    }

    // Check required properties
    const missing: string[] = [];
    for (const prop of REQUIRED_PROPS) {
      if (!articleSchema[prop]) {
        missing.push(prop);
      }
    }

    if (missing.length > 0) {
      checks.push({
        name: "article-required",
        status: "warn",
        message: `Article schema missing required properties`,
        items: missing.map((prop) => ({ id: prop })),
      });
    } else {
      checks.push({
        name: "article-required",
        status: "pass",
        message: "Article schema has required properties",
      });
    }

    // Check recommended properties
    const missingRecommended: string[] = [];
    for (const prop of RECOMMENDED_PROPS) {
      if (!articleSchema[prop]) {
        missingRecommended.push(prop);
      }
    }

    if (missingRecommended.length > 0) {
      checks.push({
        name: "article-recommended",
        status: "info",
        message: `Article schema could include recommended properties`,
        items: missingRecommended.map((prop) => ({ id: prop })),
      });
    }

    // Check date format — presence alone (above) doesn't catch malformed
    // values like raw DB timestamps, epoch numbers, or DD/MM/YYYY (#1099).
    // Falsy values (missing, "", 0) are already covered by the required/
    // recommended checks above — `Boolean(value)` (not `!= null`) keeps
    // datePublished: "" from double-reporting as both missing AND malformed.
    const invalidDates = DATE_PROPS.filter((prop) => {
      const value = articleSchema[prop];
      return Boolean(value) && !isValidIso8601Date(value);
    });

    if (invalidDates.length > 0) {
      checks.push({
        name: "article-date-format",
        status: "warn",
        message: "Article schema dates are not valid ISO 8601",
        items: invalidDates.map((prop) => ({
          id: prop,
          label: `${prop}: "${String(articleSchema[prop])}"`,
        })),
      });
    }

    return { checks };
  },
};
