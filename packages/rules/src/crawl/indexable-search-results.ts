// crawl/indexable-search-results: internal search result URLs that search engines may index.
// Reads only scalars from ctx.site.pages (url, status, headers, meta, h1, og, schemas.website,
// isSoft404), never the DOM, so it behaves the same in the resident and streaming engines.

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { isPageIndexable } from "@squirrelscan/utils";

const CHECK_NAME = "indexable-search-results";
const SEARCH_PARAMS = ["s", "q", "query", "search", "keyword"];
const MAX_TEMPLATES = 10;
const MAX_LISTED = 5;
const PLACEHOLDER = "__sq_placeholder__";

const SKIP_CHECK: CheckResult = {
  name: CHECK_NAME,
  status: "skipped",
  message: "No internal search result URLs in the crawl",
};

interface QueryTemplate {
  kind: "query";
  host: string;
  path: string;
  param: string;
}
interface PathTemplate {
  kind: "path";
  host: string;
  prefix: string;
}
type SearchTemplate = QueryTemplate | PathTemplate;

function templateKey(t: SearchTemplate): string {
  return t.kind === "query" ? `q|${t.host}|${t.path}|${t.param}` : `p|${t.host}|${t.prefix}`;
}

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function safeUrl(raw: string, base?: string): URL | null {
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

function hasNonEmptyParam(u: URL, names: string[]): boolean {
  for (const [k, v] of u.searchParams) {
    if (v.trim() === "") continue;
    if (names.includes(k.toLowerCase())) return true;
  }
  return false;
}

/** Query parameter names declared by SearchAction templates on this URL's host. */
function templateParams(u: URL, templates: SearchTemplate[]): string[] {
  const host = u.hostname.toLowerCase();
  const out: string[] = [];
  for (const t of templates) {
    if (t.kind === "query" && t.host === host) out.push(t.param.toLowerCase());
  }
  return out;
}

/**
 * Pattern A: final path segment is `search` and a search parameter (SEARCH_PARAMS or one named in
 * a declared SearchAction) has a non-empty value. utm_*, page, sort, ref, fbclid never count.
 */
function isPatternA(u: URL, templates: SearchTemplate[]): boolean {
  const segments = u.pathname.split("/").filter((s) => s !== "");
  const last = segments[segments.length - 1];
  return (
    last !== undefined &&
    last.toLowerCase() === "search" &&
    hasNonEmptyParam(u, [...SEARCH_PARAMS, ...templateParams(u, templates)])
  );
}

/** Pattern C: matches a SearchAction template declared by the site. */
function matchesTemplate(u: URL, templates: SearchTemplate[]): boolean {
  const host = u.hostname.toLowerCase();
  for (const t of templates) {
    if (t.host !== host) continue;
    if (t.kind === "query") {
      if (trimSlash(u.pathname) !== t.path) continue;
      if ((u.searchParams.get(t.param) ?? "").trim() !== "") return true;
    } else if (u.pathname.startsWith(t.prefix) && u.pathname.length > t.prefix.length) {
      return true;
    }
  }
  return false;
}

function isPatternUrl(u: URL, templates: SearchTemplate[]): boolean {
  return isPatternA(u, templates) || matchesTemplate(u, templates);
}

function normalizeText(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

function paramValues(u: URL): string[] {
  const out: string[] = [];
  for (const [k, v] of u.searchParams) {
    if (SEARCH_PARAMS.includes(k.toLowerCase())) {
      const n = normalizeText(v);
      if (n !== "") out.push(n);
    }
  }
  return out;
}

function hasParamB(u: URL): boolean {
  return paramValues(u).length > 0;
}

interface PageLike {
  url: string;
  statusCode: number;
  headers: Record<string, string>;
  parsed: {
    meta?: { canonical?: string | null; title?: string | null };
    h1?: { texts?: string[] };
    og?: { title?: string | null };
    schemas?: unknown;
    isSoft404?: boolean;
  };
}

const MIN_EVIDENCE_LEN = 3;

function containsWord(haystack: string, needle: string): boolean {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "iu").test(haystack);
}

/**
 * Evidence the page renders results for the query: the value (3+ chars, whole word) appears in the
 * h1 or og:title, or the page declares SearchResultsPage. A <title> match alone is weak evidence.
 */
function hasResultsEvidence(page: PageLike, u: URL): boolean {
  const strong: string[] = [];
  for (const t of page.parsed.h1?.texts ?? []) {
    if (typeof t === "string") strong.push(normalizeText(t));
  }
  const ogTitle = page.parsed.og?.title;
  if (typeof ogTitle === "string") strong.push(normalizeText(ogTitle));
  const values = paramValues(u).filter((v) => v.length >= MIN_EVIDENCE_LEN);
  if (values.some((v) => strong.some((h) => containsWord(h, v)))) return true;
  const schemas = page.parsed.schemas as { hasType?: (t: string) => boolean } | undefined;
  try {
    return typeof schemas?.hasType === "function" && schemas.hasType("SearchResultsPage") === true;
  } catch {
    return false;
  }
}

/** Robots `none` means noindex,nofollow; shared isPageIndexable only checks "noindex". */
function hasRobotsNone(page: PageLike): boolean {
  const tokens = (v: string | undefined | null) =>
    (v ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  const meta = (page.parsed.meta as { robots?: string | null } | undefined)?.robots;
  if (tokens(meta).includes("none")) return true;
  const xr = page.headers?.["x-robots-tag"];
  return tokens(xr).includes("none");
}

function targetStrings(target: unknown): string[] {
  if (typeof target === "string") return [target];
  if (Array.isArray(target)) return target.flatMap(targetStrings);
  if (target && typeof target === "object") {
    const tpl = (target as { urlTemplate?: unknown }).urlTemplate;
    if (typeof tpl === "string") return [tpl];
  }
  return [];
}

function templatesFromPage(page: PageLike): SearchTemplate[] {
  let website: { potentialAction?: unknown } | null | undefined;
  try {
    website = (page.parsed.schemas as { website?: { potentialAction?: unknown } } | undefined)
      ?.website;
  } catch {
    return [];
  }
  if (!website) return [];
  const actions = Array.isArray(website.potentialAction)
    ? website.potentialAction
    : website.potentialAction
      ? [website.potentialAction]
      : [];
  const out: SearchTemplate[] = [];
  for (const action of actions) {
    if (!action || typeof action !== "object") continue;
    for (const raw of targetStrings((action as { target?: unknown }).target)) {
      const replaced = raw.replace(/\{[^}]*\}/, PLACEHOLDER);
      if (replaced === raw) continue;
      const u = safeUrl(replaced, page.url);
      if (!u) continue;
      const host = u.hostname.toLowerCase();
      let param: string | null = null;
      for (const [k, v] of u.searchParams) {
        if (v === PLACEHOLDER) {
          param = k;
          break;
        }
      }
      if (param !== null) {
        out.push({ kind: "query", host, path: trimSlash(u.pathname), param });
      } else if (u.pathname.includes(PLACEHOLDER)) {
        const prefix = u.pathname.slice(0, u.pathname.indexOf(PLACEHOLDER));
        if (prefix.length > 1) out.push({ kind: "path", host, prefix });
      }
    }
  }
  return out;
}

function collectTemplates(pages: PageLike[]): SearchTemplate[] {
  const byKey = new Map<string, SearchTemplate>();
  for (const page of pages) {
    for (const t of templatesFromPage(page)) byKey.set(templateKey(t), t);
  }
  return [...byKey.values()]
    .sort((a, b) => {
      const ka = templateKey(a);
      const kb = templateKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    })
    .slice(0, MAX_TEMPLATES);
}

function display(u: URL): string {
  return `${u.pathname}${u.search}`;
}

export const indexableSearchResults: Rule = {
  meta: {
    id: "crawl/indexable-search-results",
    name: "Indexable Internal Search Results",
    description:
      "Finds internal search result URLs that search engines can index: thin, endless in number, and a spam route",
    solution:
      "Keep internal search results out of the index. Add noindex (a robots meta tag or an X-Robots-Tag header) to the search results template, or add a Disallow rule for the search path in robots.txt. Anyone can link to a search URL with their own text, so indexable results waste crawl budget and invite spam.",
    category: "crawl",
    scope: "site",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const robotsTxt = ctx.site?.robotsTxt;
    const allPages = (ctx.site?.pages ?? []) as unknown as Array<
      PageLike & { parsed: PageLike["parsed"] | null | undefined }
    >;
    const pages = allPages.filter(
      (p): p is PageLike =>
        !!p.parsed && p.statusCode >= 200 && p.statusCode < 300 && p.parsed.isSoft404 !== true,
    );
    if (pages.length === 0) return { checks: [SKIP_CHECK] };

    const templates = collectTemplates(pages);
    const sorted = [...pages].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

    let found = 0;
    let unconfirmed = 0;
    let excluded = 0;
    const listed: string[] = [];

    for (const page of sorted) {
      const u = safeUrl(page.url);
      if (!u) continue;
      let isSearch = isPatternUrl(u, templates);
      if (!isSearch && hasParamB(u)) {
        if (hasResultsEvidence(page, u)) isSearch = true;
        else unconfirmed++;
      }
      if (!isSearch) continue;
      found++;

      const indexable = isPageIndexable(
        page.parsed as Parameters<typeof isPageIndexable>[0],
        page.headers,
        page.url,
        robotsTxt,
      ).isIndexable && !hasRobotsNone(page);
      if (!indexable) {
        excluded++;
        continue;
      }
      const canonical = page.parsed.meta?.canonical;
      if (typeof canonical === "string" && canonical.trim() !== "") {
        const c = safeUrl(canonical.trim(), page.url);
        // A canonical that still carries a search parameter is not proof of a non-search target: keep listing.
        if (c && c.href !== u.href && !isPatternUrl(c, templates) && !hasParamB(c)) {
          excluded++;
          continue;
        }
      }
      listed.push(display(u));
    }

    if (found === 0) {
      const check: CheckResult = { ...SKIP_CHECK };
      if (unconfirmed > 0) {
        check.value = `${unconfirmed} URL(s) with a search-like parameter showed no sign of rendering results`;
      }
      return { checks: [check] };
    }

    if (listed.length === 0) {
      return {
        checks: [
          {
            name: CHECK_NAME,
            status: "pass",
            message: `${found} internal search result URL(s) found, none indexable`,
            ...(unconfirmed > 0
              ? { value: `${unconfirmed} unconfirmed search-like URL(s) not counted` }
              : {}),
          },
        ],
      };
    }

    const lines = listed.slice(0, MAX_LISTED);
    if (listed.length > MAX_LISTED) lines.push(`+${listed.length - MAX_LISTED} more`);
    if (excluded > 0) {
      lines.push(`${excluded} search URL(s) excluded by noindex, robots.txt or canonical`);
    }
    if (unconfirmed > 0) {
      lines.push(`${unconfirmed} unconfirmed search-like URL(s) not counted`);
    }
    return {
      checks: [
        {
          name: CHECK_NAME,
          status: "warn",
          message: `${found} internal search result URL(s) found, ${listed.length} indexable`,
          value: lines.join("\n"),
        },
      ],
    };
  },
};
