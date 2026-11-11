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

/** All-lowercase words joined by `-` or `_` (`summer-collection`, `my_cart_items`): a phrase a person wrote. */
const HUMAN_PHRASE = /^[a-z]+(?:[-_][a-z]+)+$/;

/** Two words of three or more letters joined by `-` or `_` anywhere in the value. */
const WORD_PAIR = /[A-Za-z]{3,}[-_][A-Za-z]{3,}/;

/**
 * Whether a value looks like a generated session ID, by name class.
 *
 * - Unambiguous names (`PHPSESSID`, `jsessionid`, `session_id`, `ASPSESSIONID*`): 8 or more characters,
 *   not all digits, and not a human phrase (all-lowercase words joined by `-` or `_`). Real ids pass:
 *   16 to 24 uppercase letters (ASP), 26 to 32 character alphanumerics, base64url tokens that happen to
 *   hold `abc-def`, `ABCDEF0123456789.node1`, `...!12345`.
 * - Weak names (`sid`, `sessionid`; `strict` is true): 16 or more characters, a letter and a digit, no pair of
 *   words of three or more letters joined by `-` or `_`. So `category-12345`, `item20241105`,
 *   `summer2024`, `summer-collection-2024` and `1234567890123456` are not sessions; a 32-hex and a
 *   26-character alphanumeric are.
 */
export function looksLikeSessionValue(value: string, strict = false): boolean {
  if (/^\d+$/.test(value)) return false;
  if (strict) {
    return value.length >= 16 && /[a-z]/i.test(value) && /\d/.test(value) && !WORD_PAIR.test(value);
  }
  return value.length >= MIN_SESSION_VALUE && !HUMAN_PHRASE.test(value);
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
