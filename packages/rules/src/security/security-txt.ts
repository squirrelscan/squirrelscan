// security/security-txt - RFC 9116 vulnerability-disclosure contact file

import type { WellKnownPath, WellKnownProbe } from "@squirrelscan/core-contracts";

import { NOT_CHECKED, answeredWellKnown, notCheckedCheck } from "../ax/discovery-probe-state";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

const CANONICAL_PATH: WellKnownPath = "/.well-known/security.txt";
// The pre-RFC location. Still read by some scanners, so it is reported, not failed.
const LEGACY_PATH: WellKnownPath = "/security.txt";
const PGP_SIGNED = "-----BEGIN PGP SIGNED MESSAGE-----";
const HTML_MARKUP = /<\s*(!doctype\s+html|html[\s>]|head[\s>]|body[\s>])/i;

/** Statuses that say the file does not exist. Anything else proves nothing. */
const MISSING_STATUSES = new Set([404, 410]);

/** Longest Expires value quoted in a message: the site wrote it. */
const MAX_QUOTED_EXPIRES = 64;

/** RFC 3339 date-time (RFC 9116 section 2.5.5), the only Expires format it allows. */
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Milliseconds since the epoch for a strict RFC 3339 date-time, else null.
 * `Date.parse` alone takes `2027`, `Oct 1 2027` and `2027-02-30T...` (rolled
 * over to March), none of which RFC 9116 allows.
 */
function parseRfc3339(value: string): number | null {
  const match = RFC3339.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  const when = Date.parse(value);
  return Number.isNaN(when) ? null : when;
}

function quoteExpires(value: string): string {
  return value.length > MAX_QUOTED_EXPIRES ? `${value.slice(0, MAX_QUOTED_EXPIRES)}...` : value;
}

// A body the server answered with HTML is the site's catch-all page, never the file.
function isHtml(p: WellKnownProbe): boolean {
  return (
    p.looksHtml ||
    (p.contentType ?? "").toLowerCase().includes("text/html") ||
    HTML_MARKUP.test(p.excerpt)
  );
}

function isFile(p: WellKnownProbe): boolean {
  return p.status === 200 && !isHtml(p);
}

// RFC 9116 fields are `Name: value` lines; names are case-insensitive, `#` lines are comments.
function parseFields(text: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    fields.set(name, [...(fields.get(name) ?? []), value]);
  }
  return fields;
}

function excerptBytes(p: WellKnownProbe): number {
  return new TextEncoder().encode(p.excerpt).length;
}

// Validate a file that answered 200 with a non-HTML body.
function checkFile(p: WellKnownProbe, now: number, legacy: boolean): CheckResult[] {
  const checks: CheckResult[] = [];
  const fields = parseFields(p.excerpt);
  // A body longer than the excerpt is only partly seen: a missing field then
  // cannot be called missing, only not seen.
  const truncated = p.bodySize > excerptBytes(p);
  const absent = (name: string, what: string): CheckResult => ({
    name: `security-txt-${name}`,
    status: truncated ? "info" : "warn",
    message: truncated
      ? `security.txt has no ${what} in the first 2 KB (file is longer; not confirmed)`
      : `security.txt has no ${what} field (required by RFC 9116)`,
    value: `missing ${what}`,
  });

  const contacts = fields.get("contact") ?? [];
  if (contacts.length === 0) checks.push(absent("contact", "Contact"));

  const allExpires = fields.get("expires") ?? [];
  const expires = allExpires[0];
  if (expires === undefined) {
    checks.push(absent("expires", "Expires"));
  } else {
    const when = parseRfc3339(expires);
    if (when === null) {
      checks.push({
        name: "security-txt-expires",
        status: "warn",
        message: "security.txt Expires is not an RFC 3339 date-time (e.g. 2027-01-31T23:59:59Z)",
        value: expires,
      });
    } else if (when <= now) {
      checks.push({
        name: "security-txt-expires",
        status: "warn",
        message: `security.txt expired on ${quoteExpires(expires)}`,
        value: expires,
      });
    }
  }
  if (allExpires.length > 1) {
    checks.push({
      name: "security-txt-expires-duplicate",
      status: "warn",
      message: `security.txt has ${allExpires.length} Expires fields; RFC 9116 allows one`,
      value: allExpires.length,
    });
  }

  if (checks.length === 0) {
    checks.push({
      name: "security-txt",
      status: "pass",
      message: `Valid security.txt at ${p.path}: Contact and a future Expires`,
      value: expires,
    });
  }

  // Signing is optional under RFC 9116, so an unsigned file is only noted.
  if (!p.excerpt.includes(PGP_SIGNED)) {
    checks.push({
      name: "security-txt-signed",
      status: "info",
      message: "security.txt is not signed (optional under RFC 9116)",
      value: "unsigned",
    });
  }
  if (legacy) {
    checks.unshift({
      name: "security-txt-location",
      status: "info",
      message: `security.txt is served only at the legacy location ${p.path}; RFC 9116 location is ${CANONICAL_PATH}`,
      value: "legacy-only",
    });
  }
  return checks;
}

export const securityTxtRule: Rule = {
  meta: {
    id: "security/security-txt",
    name: "security.txt",
    description:
      "Checks for a valid RFC 9116 security.txt so security researchers know how to report a vulnerability",
    solution:
      "Publish a security.txt at /.well-known/security.txt with at least a Contact and an Expires field, served as plain text. Keep Expires in the future (renew it yearly). Sign the file with PGP if you can, and do not serve an HTML page at that path.",
    category: "security",
    scope: "site",
    severity: "warning",
    weight: 3,
    discoveryProbes: [CANONICAL_PATH, LEGACY_PATH],
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const wk = ctx.site?.wellKnown;

    if (!wk) {
      checks.push(notCheckedCheck("security-txt", "security.txt"));
      return { checks };
    }

    const canonical = wk.probes.find((p) => p.path === CANONICAL_PATH);
    const legacy = wk.probes.find((p) => p.path === LEGACY_PATH);
    const { unchecked, reason } = answeredWellKnown(wk, [CANONICAL_PATH, LEGACY_PATH]);
    const now = Date.now();

    // The catch-all trap: a 200 HTML page at the canonical path is never a pass.
    if (canonical && canonical.status === 200 && isHtml(canonical)) {
      checks.push({
        name: "security-txt",
        status: "warn",
        message: `${CANONICAL_PATH} is served as HTML, not a security.txt file (catch-all page)`,
        value: "html",
      });
      return { checks };
    }

    if (canonical && isFile(canonical)) {
      checks.push(...checkFile(canonical, now, false));
      return { checks };
    }

    if (legacy && isFile(legacy)) {
      checks.push(...checkFile(legacy, now, true));
      return { checks };
    }

    // Only 404 and 410 say the file is not there. A 401/403 (often a WAF or a
    // bot rule), a 429 or a 5xx says nothing about the file.
    if (canonical && MISSING_STATUSES.has(canonical.status)) {
      checks.push({
        name: "security-txt",
        status: "warn",
        message: `No security.txt at ${CANONICAL_PATH} (RFC 9116 vulnerability-disclosure contact)`,
        value: "missing",
        ...(unchecked.length > 0 ? { details: { notChecked: unchecked } } : {}),
      });
      return { checks };
    }

    if (canonical && canonical.status > 0) {
      checks.push({
        name: "security-txt",
        status: "info",
        message: `security.txt not checked: ${CANONICAL_PATH} answered HTTP ${canonical.status}, which does not say whether the file exists`,
        value: NOT_CHECKED,
        details: { status: canonical.status },
      });
      return { checks };
    }

    checks.push(notCheckedCheck("security-txt", "security.txt", { notChecked: unchecked }, reason));
    return { checks };
  },
};
