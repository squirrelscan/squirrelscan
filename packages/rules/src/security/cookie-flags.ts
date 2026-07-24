// security/cookie-flags - Secure/HttpOnly/SameSite on Set-Cookie response headers

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

interface ParsedCookie {
  name: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
}

/**
 * Split a (possibly multi-cookie) Set-Cookie header value into individual
 * cookie directives. Cookies can't be safely comma-joined (Expires values
 * contain commas: "Expires=Wed, 09 Jun 2021..."), so this splits only on a
 * comma that's followed by what looks like the start of the next cookie
 * (name=), the same heuristic used by set-cookie-parser and similar tools.
 * Also splits on newlines first, for a future fix to the fetcher's header
 * capture that joins multiple real Set-Cookie
 * headers with \n instead of silently keeping only the last one.
 */
function splitSetCookieHeader(value: string): string[] {
  return value
    .split("\n")
    .flatMap((line) => line.split(/,(?=\s*[^;,=\s]+=)/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCookieDirective(directive: string): ParsedCookie {
  const parts = directive.split(";").map((p) => p.trim());
  const nameValue = parts[0] ?? "";
  const name = nameValue.split("=")[0]?.trim() || nameValue;

  let secure = false;
  let httpOnly = false;
  let sameSite: string | null = null;

  for (const attr of parts.slice(1)) {
    const eq = attr.indexOf("=");
    const attrName = (eq === -1 ? attr : attr.slice(0, eq)).trim().toLowerCase();
    const attrValue = eq === -1 ? "" : attr.slice(eq + 1).trim();
    if (attrName === "secure") secure = true;
    else if (attrName === "httponly") httpOnly = true;
    else if (attrName === "samesite") sameSite = attrValue || null;
  }

  return { name, secure, httpOnly, sameSite };
}

export const cookieFlagsRule: Rule = {
  meta: {
    id: "security/cookie-flags",
    name: "Cookie Flags",
    description: "Checks Set-Cookie response headers for Secure, HttpOnly, and SameSite attributes",
    solution:
      "Cookies set by your server should carry the flags appropriate to their purpose. Secure stops a cookie from ever being sent over plain HTTP, so it can't be intercepted on a downgraded connection. HttpOnly stops client-side JavaScript from reading it, closing off a common XSS cookie-theft path — omit it only for cookies your own frontend genuinely needs to read. SameSite=Lax or SameSite=Strict blocks the cookie from being sent on cross-site requests, mitigating CSRF; if you need SameSite=None for a legitimate cross-site use case (e.g. an embedded widget), it must be paired with Secure or browsers will reject the cookie outright.",
    category: "security",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const raw = ctx.page.headers["set-cookie"];

    if (!raw) {
      checks.push({
        name: "cookie-flags",
        status: "pass",
        message: "No cookies set on this page",
      });
      return { checks };
    }

    const isHttps = ctx.page.url.startsWith("https://");
    const cookies = splitSetCookieHeader(raw).map(parseCookieDirective);

    if (cookies.length === 0) {
      checks.push({
        name: "cookie-flags",
        status: "pass",
        message: "No cookies set on this page",
      });
      return { checks };
    }

    // SameSite=None without Secure is rejected outright by modern browsers —
    // a real functional break, not just hygiene, so it's a fail regardless of
    // the other flags.
    const brokenSameSiteNone = cookies.filter(
      (c) => c.sameSite?.toLowerCase() === "none" && !c.secure,
    );
    if (brokenSameSiteNone.length > 0) {
      checks.push({
        name: "cookie-samesite-none-insecure",
        status: "fail",
        message: `${brokenSameSiteNone.length} cookie(s) set SameSite=None without Secure — modern browsers reject this combination`,
        items: brokenSameSiteNone.map((c) => ({ id: c.name })),
      });
    }

    // Missing Secure only matters on an HTTPS page (there's no secure
    // connection to restrict the cookie to on a plain-HTTP page).
    if (isHttps) {
      const missingSecure = cookies.filter((c) => !c.secure);
      if (missingSecure.length > 0) {
        checks.push({
          name: "cookie-secure",
          status: "warn",
          message: `${missingSecure.length} cookie(s) missing the Secure flag`,
          items: missingSecure.map((c) => ({ id: c.name })),
        });
      }
    }

    const missingHttpOnly = cookies.filter((c) => !c.httpOnly);
    if (missingHttpOnly.length > 0) {
      checks.push({
        name: "cookie-httponly",
        status: "warn",
        message: `${missingHttpOnly.length} cookie(s) missing the HttpOnly flag`,
        items: missingHttpOnly.map((c) => ({ id: c.name })),
      });
    }

    // Missing SameSite is lower-severity: modern browsers default it to Lax,
    // so an absent attribute isn't the CSRF gap it used to be — informational.
    // (No need to also exclude brokenSameSiteNone here: those cookies have
    // sameSite === "none", which is truthy, so !c.sameSite already excludes
    // them — the extra check was unreachable. #981)
    const missingSameSite = cookies.filter((c) => !c.sameSite);
    if (missingSameSite.length > 0) {
      checks.push({
        name: "cookie-samesite",
        status: "info",
        message: `${missingSameSite.length} cookie(s) don't explicitly declare SameSite (browsers default to Lax)`,
        items: missingSameSite.map((c) => ({ id: c.name })),
      });
    }

    if (checks.length === 0) {
      checks.push({
        name: "cookie-flags",
        status: "pass",
        message: `${cookies.length} cookie(s) set with Secure, HttpOnly, and SameSite configured correctly`,
      });
    }

    return { checks };
  },
};
