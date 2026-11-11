// url/session-ids - session IDs in crawlable URLs

import type { CheckItem } from "@squirrelscan/core-contracts";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

/**
 * Session parameter names, lowercased. `aspsessionid*` is matched by prefix, `cfid` needs `cftoken`.
 * `sid` and `sessionid` are also ordinary words in other systems, so they need the strict generated
 * form; the other names are unambiguous and take the looser one.
 */
const SESSION_NAMES = new Set(["phpsessid", "jsessionid", "sid", "sessionid", "session_id"]);
const WEAK_NAMES = new Set(["sid", "sessionid"]);

const MIN_SESSION_VALUE = 8;
const SAMPLE_LIMIT = 10;
const MASK = "…";

export interface SessionParam {
  /** The parameter name as written in the URL. */
  name: string;
  where: "query" | "path";
}

function isSessionName(name: string): boolean {
  const lower = name.toLowerCase();
  return SESSION_NAMES.has(lower) || lower.startsWith("aspsessionid");
}

/** Words joined by a separator (`summer-collection`, `my_cart_items`): a label a person wrote, not a generated ID. */
const WORD_SEPARATOR = /[A-Za-z]{3,}[-_][A-Za-z]{3,}/;

/**
 * A value that looks generated, as a session ID is, rather than written by a person or counted:
 *
 * - never all digits (a counter, a timestamp, a numeric id) and never words joined by `-` or `_`;
 * - the looser test, for names that only mean a session: 8 or more characters with a letter and a
 *   digit, or 16 or more with at least two of {a letter, a digit, mixed case};
 * - the strict test, for the weak names `sid` and `sessionid`: 8 or more characters with a letter and a
 *   digit, or 24 or more in mixed case.
 *
 * `sid=2`, `sid=main`, `sid=summer-collection-2024` and `sid=1234567890123456` are not sessions.
 */
export function looksLikeSessionValue(value: string, strict = false): boolean {
  if (value.length < MIN_SESSION_VALUE) return false;
  if (/^\d+$/.test(value) || WORD_SEPARATOR.test(value)) return false;
  const letter = /[a-z]/i.test(value);
  const digit = /\d/.test(value);
  const mixedCase = /[a-z]/.test(value) && /[A-Z]/.test(value);
  if (letter && digit) return true;
  if (strict) return value.length >= 24 && mixedCase;
  return value.length >= 16 && [letter, digit, mixedCase].filter(Boolean).length >= 2;
}

/** The value test for a parameter name: strict for `sid` and `sessionid`, looser for the rest. */
function valueFits(name: string, value: string): boolean {
  return looksLikeSessionValue(value, WEAK_NAMES.has(name.toLowerCase()));
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Every session identifier a URL carries, in the query and in `;name=value` path parameters. */
export function sessionParamsOf(rawUrl: string): SessionParam[] {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return [];
  }
  const found: SessionParam[] = [];
  const seen = new Set<string>();
  const add = (name: string, where: SessionParam["where"]) => {
    const key = `${where}:${name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ name, where });
  };

  const query = new Map<string, string>();
  for (const [name, value] of url.searchParams) {
    if (!query.has(name.toLowerCase())) query.set(name.toLowerCase(), value);
    if (isSessionName(name) && valueFits(name, value)) add(name, "query");
  }
  // ColdFusion sends the pair: CFID alone is a short counter.
  const cftoken = query.get("cftoken");
  if (query.has("cfid") && cftoken !== undefined && cftoken.length >= MIN_SESSION_VALUE) {
    add("CFID", "query");
    add("CFTOKEN", "query");
  }

  for (const match of url.pathname.matchAll(/;([A-Za-z0-9_]+)=([^;/?#]*)/g)) {
    const name = match[1]!;
    if (isSessionName(name) && valueFits(name, decodeSafe(match[2]!))) add(name, "path");
  }
  return found;
}

/** The URL with every session value replaced by `…`, and no fragment or userinfo. */
export function maskSessionValues(rawUrl: string, params: SessionParam[]): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return MASK;
  }
  const names = new Set(params.map((p) => p.name.toLowerCase()));
  const path = url.pathname.replace(/;([A-Za-z0-9_]+)=([^;/?#]*)/g, (whole, name: string) =>
    names.has(name.toLowerCase()) ? `;${name}=${MASK}` : whole,
  );
  const query = url.search
    .replace(/^\?/, "")
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => {
      const eq = pair.indexOf("=");
      const name = eq === -1 ? pair : pair.slice(0, eq);
      return names.has(decodeSafe(name).toLowerCase()) ? `${name}=${MASK}` : pair;
    })
    .join("&");
  return `${url.protocol}//${url.host}${path}${query ? `?${query}` : ""}`;
}

const nameList = (params: SessionParam[]) => [...new Set(params.map((p) => p.name))].join(", ");

export const sessionIdsRule: Rule = {
  meta: {
    id: "url/session-ids",
    name: "Session IDs in URLs",
    description: "Checks that crawlable URLs do not carry a session ID",
    solution:
      "A session ID in the URL gives every visitor, and every crawler visit, a different URL for the same page, so search engines see unlimited duplicates, and a shared link can hand one visitor's session to another. Keep the session in a cookie. For PHP set session.use_only_cookies=1 and session.use_trans_sid=0; for Java servlet containers disable URL rewriting (tracking-mode COOKIE); for ASP.NET use cookieless=\"false\". Redirect the old URLs to the clean ones and add a canonical tag.",
    category: "url",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    const own = sessionParamsOf(ctx.page.url);
    if (own.length > 0) {
      checks.push({
        name: "session-id-in-url",
        status: "warn",
        message: `Page URL carries a session ID (${nameList(own)})`,
        items: [{ id: maskSessionValues(ctx.page.url, own), label: `${own[0]!.where} parameter ${own[0]!.name}` }],
        details: { parameters: own.map((p) => p.name), where: own.map((p) => p.where) },
      });
    }

    const carriers = new Map<string, CheckItem>();
    const names: SessionParam[] = [];
    for (const link of ctx.parsed.links) {
      if (!link.isInternal || carriers.size > 100_000) continue;
      const params = sessionParamsOf(link.url);
      if (params.length === 0) continue;
      const masked = maskSessionValues(link.url, params);
      if (carriers.has(masked)) continue;
      names.push(...params);
      carriers.set(masked, { id: masked, label: `${nameList(params)} in the ${params[0]!.where}` });
    }
    if (carriers.size > 0) {
      const items = [...carriers.values()];
      checks.push({
        name: "session-id-links",
        status: "warn",
        message: `${items.length} internal link(s) carry a session ID (${nameList(names)})`,
        items: items.slice(0, SAMPLE_LIMIT),
        details: {
          count: items.length,
          ...(items.length > SAMPLE_LIMIT ? { additional: items.length - SAMPLE_LIMIT } : {}),
        },
      });
    }

    if (checks.length === 0) {
      checks.push({ name: "session-ids", status: "pass", message: "No session IDs in URLs" });
    }
    return { checks };
  },
};
