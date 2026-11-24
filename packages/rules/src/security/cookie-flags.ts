// security/cookie-flags - Secure/HttpOnly/SameSite on Set-Cookie response headers

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { platformCookie } from "./platform-cookies";
import {
  formatScriptHosts,
  scriptHostDetails,
  thirdPartyScriptHosts,
} from "./third-party-script-hosts";
import { isTokenKey } from "./token-storage";

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
    const attrName = (eq === -1 ? attr : attr.slice(0, eq))
      .trim()
      .toLowerCase();
    const attrValue = eq === -1 ? "" : attr.slice(eq + 1).trim();
    if (attrName === "secure") secure = true;
    else if (attrName === "httponly") httpOnly = true;
    else if (attrName === "samesite") sameSite = attrValue || null;
  }

  return { name, secure, httpOnly, sameSite };
}

// Session cookie names that frameworks and servers use by default.
const SESSION_COOKIE_NAMES = new Set([
  "phpsessid",
  "jsessionid",
  "asp.net_sessionid",
  "aspsessionid",
  "cfid",
  "cftoken",
  "connect.sid",
  "sid",
  "ssid",
  "sessid",
  "sessionid",
  "session",
  "_session",
  "session_id",
]);

/** `laravel_session`, `_myapp_session`, `app.sid`, `__Host-session`. */
const SESSION_SUFFIX = /(?:^|[._-])(?:session|sess|sid|sessid|sessionid)$/;

/**
 * Does the cookie name look like it holds a session or an auth token? Used only
 * to decide which cookies without HttpOnly rate higher when third-party scripts
 * run on the page (#2089). A default session name (`PHPSESSID`, `connect.sid`,
 * `laravel_session`) or a credential name `security/token-storage` recognises
 * (`auth_token`, `jwt`, `session_id`) counts. Names are compared lowercased, with
 * a `__Host-` or `__Secure-` prefix removed.
 */
export function isSessionLikeCookie(name: string): boolean {
  const lower = name.toLowerCase().replace(/^__(?:host|secure)-/, "");
  if (!lower) return false;
  if (SESSION_COOKIE_NAMES.has(lower)) return true;
  if (/^aspsessionid/.test(lower)) return true;
  if (SESSION_SUFFIX.test(lower)) return true;
  return isTokenKey(name.replace(/^__(?:Host|Secure)-/i, ""));
}

export const cookieFlagsRule: Rule = {
  meta: {
    id: "security/cookie-flags",
    name: "Cookie Flags",
    description:
      "Checks Set-Cookie response headers for Secure, HttpOnly, and SameSite attributes",
    solution:
      "Cookies set by your server should carry the flags appropriate to their purpose. Secure stops a cookie from ever being sent over plain HTTP, so it can't be intercepted on a downgraded connection. HttpOnly stops client-side JavaScript from reading it, closing off a common XSS cookie-theft path, omit it only for cookies your own frontend genuinely needs to read. SameSite=Lax or SameSite=Strict blocks the cookie from being sent on cross-site requests, mitigating CSRF; if you need SameSite=None for a legitimate cross-site use case (e.g. an embedded widget), it must be paired with Secure or browsers will reject the cookie outright.",
    category: "security",
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
    // Each check message starts with the number of cookies (#1262).
    messageCountsItems: true,
    // Check names by outcome class (#1741, #2218).
    checks: [
      { name: "cookie-samesite-none-insecure", outcome: "problem" },
      { name: "cookie-secure", outcome: "problem" },
      { name: "cookie-httponly-platform", outcome: "problem" },
      { name: "cookie-httponly-csrf", outcome: "problem" },
      { name: "cookie-httponly-third-party-scripts", outcome: "problem" },
      { name: "cookie-httponly", outcome: "problem" },
      { name: "cookie-samesite", outcome: "problem" },
      {
        name: "cookie-flags",
        outcome: "clean",
        clears: [
          "cookie-samesite-none-insecure",
          "cookie-secure",
          "cookie-httponly-platform",
          "cookie-httponly-csrf",
          "cookie-httponly-third-party-scripts",
          "cookie-httponly",
          "cookie-samesite",
        ],
      },
    ],
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
      (c) => c.sameSite?.toLowerCase() === "none" && !c.secure
    );
    if (brokenSameSiteNone.length > 0) {
      checks.push({
        name: "cookie-samesite-none-insecure",
        status: "fail",
        message: `${brokenSameSiteNone.length} cookie(s) set SameSite=None without Secure, modern browsers reject this combination`,
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

    // A cookie on a fixed list of exact names is exempt from the HttpOnly
    // warning and reported as info with the reason: a cookie a hosting platform's
    // sites commonly carry (the site owner doesn't set it, no session in it), or a
    // CSRF double-submit token a script is meant to read. Any other cookie, however
    // it is named, still warns. Secure and SameSite are checked as for any cookie.
    const noHttpOnly = cookies.filter((c) => !c.httpOnly);
    const exempt = noHttpOnly.filter((c) => platformCookie(c.name));
    const missingHttpOnly = noHttpOnly.filter((c) => !platformCookie(c.name));
    const platformOwned = exempt.filter(
      (c) => platformCookie(c.name)!.kind === "platform"
    );
    const csrfOwned = exempt.filter(
      (c) => platformCookie(c.name)!.kind === "csrf"
    );
    if (platformOwned.length > 0) {
      const entries = platformOwned.map((c) => platformCookie(c.name)!);
      const platforms = [...new Set(entries.map((e) => e.platform))];
      const undocumented = entries.every((e) => !e.documented);
      checks.push({
        name: "cookie-httponly-platform",
        status: "info",
        message: `${platformOwned.length} cookie(s) without HttpOnly that ${platforms.join(" and ")}-hosted sites commonly carry (${[...new Set(platformOwned.map((c) => c.name))].join(", ")}); ${undocumented ? "the platform does not document it, so " : ""}it is reported as info, not a warning`,
        items: platformOwned.map((c) => ({ id: c.name })),
      });
    }
    if (csrfOwned.length > 0) {
      const entries = [
        ...new Set(csrfOwned.map((c) => platformCookie(c.name)!)),
      ];
      checks.push({
        name: "cookie-httponly-csrf",
        status: "info",
        message: `${csrfOwned.length} CSRF token cookie(s) without HttpOnly (${entries.map((e) => `${e.name}: ${e.platform}`).join("; ")}). Frameworks that read the token from script (Angular, Axios) need it readable; if your frontend does not read it, you can set HttpOnly. Reported as info, not a warning. Docs: ${entries.flatMap((e) => e.docs).join(" ")}`,
        items: csrfOwned.map((c) => ({ id: c.name })),
      });
    }
    // Any script on the page can read a cookie without HttpOnly. When the page
    // loads scripts from other registrable domains, a session-like cookie among
    // them fails instead of warning, and the check names those hosts (#2089).
    // With no third-party script, or no parsed document, nothing changes.
    const scriptHosts =
      missingHttpOnly.length > 0
        ? thirdPartyScriptHosts(ctx.parsed?.document, ctx.page.url)
        : [];
    const exposed =
      scriptHosts.length > 0
        ? missingHttpOnly.filter((c) => isSessionLikeCookie(c.name))
        : [];
    const plainMissingHttpOnly = missingHttpOnly.filter(
      (c) => !exposed.includes(c)
    );
    if (exposed.length > 0) {
      checks.push({
        name: "cookie-httponly-third-party-scripts",
        status: "fail",
        message: `${exposed.length} session-like cookie(s) missing the HttpOnly flag on a page that loads scripts from ${scriptHosts.length} third-party host(s): ${formatScriptHosts(scriptHosts)}. Any script on the page can read these cookies`,
        items: exposed.map((c) => ({ id: c.name })),
        details: scriptHostDetails(scriptHosts),
      });
    }
    if (plainMissingHttpOnly.length > 0) {
      checks.push({
        name: "cookie-httponly",
        status: "warn",
        message: `${plainMissingHttpOnly.length} cookie(s) missing the HttpOnly flag`,
        items: plainMissingHttpOnly.map((c) => ({ id: c.name })),
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
