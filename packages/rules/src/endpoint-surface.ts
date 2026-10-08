// Shared endpoint discovery: the candidate API surface a data-exposure rule
// (GraphQL introspection, exposed actuator, open API docs) can look at, so each
// rule does not re-extract URLs from the same pages and scripts.
//
// The pass is PASSIVE. It reads content the crawl already fetched (page DOMs and
// the served JS in `site.scripts`) and the technology ids the engine detected, and
// it sends no request. A rule that wants to probe a candidate does so itself, and
// only when `probeEligible` is true.
//
// Shape of the work, mirroring collected-signals.ts:
//   - `extractEndpointRefsFromDocument` runs once per page while the DOM is live and
//     returns a small bounded `PageEndpointRefs` record (cacheable, DOM-free).
//   - `buildEndpointSurface` folds the per-page records, the served scripts and the
//     convention paths for the detected stack into one deduped, capped list.
//
// The scanned content is controlled by the audited site, so every regex here is
// linear or bounded polynomial: the options-object bodies allow one nested brace
// level inside a 300-repeat cap, character classes are bounded, and every input is
// length-capped before it is scanned.

/** Where a candidate came from. */
export type EndpointSource = "static-js" | "static-html" | "convention" | "render";

/** One audited-site endpoint the pass found. */
export interface EndpointCandidate {
  /** Absolute URL, fragment removed. */
  url: string;
  /** Upper-case HTTP method when the call site or form states one. */
  method?: string;
  source: EndpointSource;
  /**
   * The concrete mechanism: `fetch`, `axios.get`, `xhr.open`, `$.ajax`,
   * `string-literal`, `form-action`, `link-href`, `script-src`, or
   * `convention:<tech id>`.
   */
  discoveredVia: string;
  /** True when the URL has the same origin as the audited website. */
  sameOrigin: boolean;
  /**
   * True only for a same-origin candidate. A cross-origin endpoint is recorded so
   * a rule can report it, but it is not the audited website's to probe.
   */
  probeEligible: boolean;
}

/** The pass output, read by rules as `ctx.endpointSurface`. */
export interface EndpointSurface {
  /** Deduped and capped, in a stable order (convention, then js, then html). */
  candidates: EndpointCandidate[];
  /** Distinct candidates before the cap. `total > candidates.length` means truncated. */
  total: number;
  /**
   * True when the fold dropped candidates: the final cap was hit, or the script
   * scan budget skipped scripts (see `scriptsSkipped`). Refs dropped earlier, by
   * the per-page, per-script and retained caps, are not reported here.
   */
  truncated: boolean;
  /** Same-origin scripts with content that the scan budget did not read. */
  scriptsSkipped: number;
}

/** A page-time reference, already resolved to an absolute URL. DOM-free. */
export interface PageEndpointRef {
  url: string;
  method?: string;
  discoveredVia: string;
}

/** What the per-page collector contributes (and the rule cache stores). */
export interface PageEndpointRefs {
  pageUrl: string;
  refs: PageEndpointRef[];
  /** Technology ids detected on this page. Set on the first page only. */
  techIds?: string[];
}

/** Candidates kept overall. A shared probe budget can consume the list as is. */
export const MAX_ENDPOINT_CANDIDATES = 200;
/** Of those, at most this many may be cross-origin (recorded, not probeable). */
export const MAX_CROSS_ORIGIN_CANDIDATES = 50;
/** Refs one page may contribute. */
export const MAX_REFS_PER_PAGE = 100;
/** Refs one served script may contribute. */
export const MAX_REFS_PER_SCRIPT = 200;
/** Bytes of one script (or inline script) that are scanned. */
const MAX_SCAN_CHARS = 512 * 1024;
/** Bytes of inline script scanned across one page. */
const MAX_PAGE_INLINE_CHARS = 1024 * 1024;
/** Same-origin scripts scanned per surface build. */
export const MAX_SCRIPTS_SCANNED = 100;
/** Total script characters scanned per surface build, across all scripts. */
export const MAX_SCRIPT_SCAN_CHARS = 4 * 1024 * 1024;
/** Longest URL kept. */
const MAX_URL_CHARS = 512;

/**
 * Convention paths per detected stack. Curated and small on purpose: each entry
 * is a path a rule in this family would probe anyway. A site with no detected
 * stack gets none, so an unknown stack is never guessed at.
 */
export const CONVENTION_PATHS: Readonly<Record<string, readonly string[]>> = {
  nextjs: ["/api/health", "/api/graphql"],
  nuxt: ["/api/health"],
  remix: ["/api/health"],
  gatsby: ["/api/health"],
  express: ["/api/health", "/metrics", "/graphql"],
  strapi: ["/graphql", "/api/health"],
  directus: ["/graphql", "/server/health", "/server/specs/oas"],
  wordpress: ["/wp-json/", "/graphql"],
  drupal: ["/jsonapi", "/graphql"],
  "aspnet-kestrel": ["/health", "/swagger/v1/swagger.json", "/openapi.json", "/metrics"],
};

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

// ── classification ─────────────────────────────────────────────────

// A path that reads as an API route. Anchored at the start of the literal.
const API_PATH_RE =
  /^\/(?:api(?:[/?]|$)|graphql(?:[/?]|$)|rest\/v1\/|_next\/data\/|trpc\/|wp-json(?:[/?]|$)|actuator(?:[/?]|$)|openapi\.json)/i;
const API_HOST_RE = /^(?:api|graphql|gql|gateway)\./i;
const STATIC_ASSET_RE = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|pdf)(?:[?#]|$)/i;
// Characters that mean the literal is a template, a pattern or prose, not a URL.
const NOT_A_URL_RE = /[{}<>()*^$|\\]/;

/** Resolve `raw` to an absolute http(s) URL without a fragment, or null. */
function resolveUrl(raw: string, base: string): string | null {
  if (raw.length === 0 || raw.length > MAX_URL_CHARS) return null;
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

/** True when `href` (absolute) is an API-looking URL: an API host or an API path. */
function looksLikeApiUrl(u: URL): boolean {
  if (API_HOST_RE.test(u.hostname)) return true;
  return API_PATH_RE.test(u.pathname) && !STATIC_ASSET_RE.test(u.pathname);
}

/**
 * Resolve a string literal from script text to an endpoint URL when it looks like
 * one. Returns null for anything else.
 */
function classifyLiteral(literal: string, base: string): string | null {
  if (literal.length < 2 || NOT_A_URL_RE.test(literal)) return null;
  const isAbsolute = /^https?:\/\//i.test(literal);
  const isRootRelative = literal.charCodeAt(0) === 47 /* / */ && literal.charCodeAt(1) !== 47;
  if (!isAbsolute && !isRootRelative) return null;
  const href = resolveUrl(literal, base);
  if (!href) return null;
  return looksLikeApiUrl(new URL(href)) ? href : null;
}

/**
 * A call site names its URL outright, so the "looks like an API" test is looser:
 * any same-site or absolute http(s) URL that is not a static asset. A relative
 * URL without a leading slash (`fetch("api/users")`) is skipped on purpose: its
 * base depends on the page path, which a script scan cannot know.
 */
function classifyCallSiteUrl(raw: string, base: string): string | null {
  if (NOT_A_URL_RE.test(raw) || raw.includes("${")) return null;
  if (!/^(?:https?:)?\/\//i.test(raw) && raw.charCodeAt(0) !== 47) return null;
  const href = resolveUrl(raw.startsWith("//") ? `https:${raw}` : raw, base);
  if (!href) return null;
  return STATIC_ASSET_RE.test(new URL(href).pathname) ? null : href;
}

// ── script text extraction ─────────────────────────────────────────

// Each pattern captures the URL literal. `[^"'`\\\n]{1,512}` cannot cross a quote,
// so a scan from any quote ends at the next one: linear in the text length.
const URL_LIT = "([^\"'`\\\\\\n]{1,512})";
const Q = "[\"'`]";
// An options object body: any run of non-brace characters, allowing one nested
// `{...}` level. The two alternatives start on disjoint characters, so it is linear.
const OBJ_BODY = "(?:[^{}]|\\{[^{}]{0,100}\\}){0,300}?";

const FETCH_RE = new RegExp(
  `\\bfetch\\s*\\(\\s*${Q}${URL_LIT}${Q}(?:\\s*,\\s*\\{${OBJ_BODY}\\bmethod\\s*:\\s*${Q}([A-Za-z]{3,7})${Q})?`,
  "g"
);
const AXIOS_RE = new RegExp(
  `\\baxios\\s*\\.\\s*(get|post|put|patch|delete|head|options|request)\\s*\\(\\s*${Q}${URL_LIT}${Q}`,
  "g"
);
const XHR_RE = new RegExp(
  `\\.open\\s*\\(\\s*${Q}([A-Za-z]{3,7})${Q}\\s*,\\s*${Q}${URL_LIT}${Q}`,
  "g"
);
const JQUERY_SHORT_RE = new RegExp(
  `(?:\\$|\\bjQuery)\\s*\\.\\s*(get|post|getJSON)\\s*\\(\\s*${Q}${URL_LIT}${Q}`,
  "g"
);
const JQUERY_AJAX_RE = new RegExp(
  `(?:\\$|\\bjQuery)\\s*\\.\\s*ajax\\s*\\(\\s*\\{${OBJ_BODY}\\burl\\s*:\\s*${Q}${URL_LIT}${Q}(?:${OBJ_BODY}\\b(?:type|method)\\s*:\\s*${Q}([A-Za-z]{3,7})${Q})?`,
  "g"
);
const LITERAL_RE = /(["'`])([^"'`\\\s]{2,512})\1/g;

const SCAN_GATE_RE = /fetch|axios|\.open|\$|jQuery|api|graphql|gql|gateway|_next\/data|trpc|wp-json|actuator|openapi/i;

type Push = (url: string, via: string, method?: string) => void;

function normalizeMethod(m: string | undefined): string | undefined {
  if (!m) return undefined;
  const up = m.toUpperCase();
  return HTTP_METHODS.has(up) ? up : undefined;
}

/**
 * Scan one script's text. Call sites first (they carry a method and a stronger
 * signal), then any remaining endpoint-looking string literal.
 */
function scanScriptText(text: string, base: string, push: Push): void {
  const src = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  // Cheap gate: skip text that names no call site and no API-looking token.
  if (!SCAN_GATE_RE.test(src)) return;

  for (const m of src.matchAll(FETCH_RE)) {
    const url = classifyCallSiteUrl(m[1], base);
    if (url) push(url, "fetch", normalizeMethod(m[2]) ?? "GET");
  }
  for (const m of src.matchAll(AXIOS_RE)) {
    const url = classifyCallSiteUrl(m[2], base);
    if (!url) continue;
    const verb = m[1].toLowerCase();
    push(url, `axios.${verb}`, verb === "request" ? undefined : normalizeMethod(verb));
  }
  for (const m of src.matchAll(XHR_RE)) {
    const method = normalizeMethod(m[1]);
    if (!method) continue;
    const url = classifyCallSiteUrl(m[2], base);
    if (url) push(url, "xhr.open", method);
  }
  for (const m of src.matchAll(JQUERY_SHORT_RE)) {
    const url = classifyCallSiteUrl(m[2], base);
    if (!url) continue;
    const verb = m[1].toLowerCase();
    push(url, `$.${m[1]}`, verb === "post" ? "POST" : "GET");
  }
  for (const m of src.matchAll(JQUERY_AJAX_RE)) {
    const url = classifyCallSiteUrl(m[1], base);
    if (url) push(url, "$.ajax", normalizeMethod(m[2]) ?? "GET");
  }
  for (const m of src.matchAll(LITERAL_RE)) {
    const url = classifyLiteral(m[2], base);
    if (url) push(url, "string-literal");
  }
}

/**
 * Endpoint refs in one served JS file. `base` is the script's own URL, so a
 * root-relative literal resolves against the origin that served it.
 */
export function extractEndpointRefsFromScript(content: string, scriptUrl: string): PageEndpointRef[] {
  const refs: PageEndpointRef[] = [];
  scanScriptText(content, scriptUrl, (url, discoveredVia, method) => {
    if (refs.length < MAX_REFS_PER_SCRIPT) refs.push({ url, method, discoveredVia });
  });
  return refs;
}

// ── page DOM extraction ────────────────────────────────────────────

// Script types that are code. JSON data blocks (JSON-LD, __NEXT_DATA__) are not.
const JS_TYPE_RE = /^(?:|module|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript)$/i;

/**
 * Collect endpoint refs from a live page DOM: inline scripts, form actions, and
 * link or script URLs that point at an API host or path. Bounded, DOM-free output.
 */
export function extractEndpointRefsFromDocument(
  doc: Document,
  pageUrl: string
): PageEndpointRef[] {
  const refs: PageEndpointRef[] = [];
  const push: Push = (url, discoveredVia, method) => {
    if (refs.length < MAX_REFS_PER_PAGE) refs.push({ url, method, discoveredVia });
  };

  for (const form of doc.querySelectorAll("form[action]")) {
    const action = form.getAttribute("action")?.trim();
    if (!action || action.startsWith("#")) continue;
    const href = resolveUrl(action, pageUrl);
    if (!href || !looksLikeApiUrl(new URL(href))) continue;
    push(href, "form-action", normalizeMethod(form.getAttribute("method") ?? undefined) ?? "GET");
  }

  for (const [selector, attr, via] of [
    ["link[href]", "href", "link-href"],
    ["script[src]", "src", "script-src"],
  ] as const) {
    for (const el of doc.querySelectorAll(selector)) {
      const raw = el.getAttribute(attr)?.trim();
      if (!raw) continue;
      const href = resolveUrl(raw, pageUrl);
      if (href && looksLikeApiUrl(new URL(href))) push(href, via);
    }
  }

  let budget = MAX_PAGE_INLINE_CHARS;
  for (const script of doc.querySelectorAll("script:not([src])")) {
    if (budget <= 0) break;
    if (!JS_TYPE_RE.test((script.getAttribute("type") ?? "").trim())) continue;
    const text = script.textContent ?? "";
    if (text.length === 0) continue;
    budget -= Math.min(text.length, MAX_SCAN_CHARS);
    scanScriptText(text, pageUrl, push);
  }
  return refs;
}

// ── fold ───────────────────────────────────────────────────────────

const SOURCE_RANK: Record<EndpointSource, number> = {
  convention: 0,
  "static-js": 1,
  "static-html": 2,
  render: 3,
};

export interface EndpointSurfaceInput {
  /** The audited website's base URL; its origin decides same-origin. */
  baseUrl: string;
  /** Per-page records, in crawl order. */
  pages: readonly PageEndpointRefs[];
  /** Served scripts (`site.scripts`). Only same-origin ones are scanned. */
  scripts?: ReadonlyArray<{ url: string; finalUrl?: string; content: string | null }>;
  /** Technology ids detected on the website; drives the convention paths. */
  techIds?: readonly string[];
  /**
   * Request URLs a browser render issued, when the render phase exposes them.
   * The render pipeline does not carry them today, so engine callers omit this.
   */
  renderedRequests?: ReadonlyArray<{ url: string; method?: string }>;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Fold the sources into the deduped, capped list. Pure and synchronous: no I/O.
 *
 * Dedup key is method plus URL. A method-less record (a string literal, a link)
 * is dropped when the same URL also has a record with a method.
 */
export function buildEndpointSurface(input: EndpointSurfaceInput): EndpointSurface {
  const siteOrigin = originOf(input.baseUrl);
  const byKey = new Map<string, EndpointCandidate>();

  const add = (
    rawUrl: string,
    source: EndpointSource,
    discoveredVia: string,
    method?: string
  ): void => {
    const href = resolveUrl(rawUrl, input.baseUrl);
    if (!href) return;
    const sameOrigin = siteOrigin !== null && originOf(href) === siteOrigin;
    const key = `${method ?? ""} ${href}`;
    if (byKey.has(key)) return;
    byKey.set(key, {
      url: href,
      ...(method ? { method } : {}),
      source,
      discoveredVia,
      sameOrigin,
      probeEligible: sameOrigin,
    });
  };

  // Convention paths for the detected stack. Always same-origin by construction.
  const seenTech = new Set<string>();
  for (const id of input.techIds ?? []) {
    if (seenTech.has(id)) continue;
    seenTech.add(id);
    for (const path of CONVENTION_PATHS[id] ?? []) {
      add(path, "convention", `convention:${id}`, "GET");
    }
  }

  // Served JS. Third-party scripts are skipped: a root-relative literal in a
  // vendor bundle names the vendor's API, not this website's. The scan is bounded
  // so a site with many large bundles cannot hold the site pass: scripts are read
  // in URL order (so the choice does not depend on fetch order) until either
  // MAX_SCRIPTS_SCANNED scripts or MAX_SCRIPT_SCAN_CHARS characters are spent; the
  // rest are counted in `scriptsSkipped`.
  const sameOriginScripts: { url: string; content: string }[] = [];
  for (const script of input.scripts ?? []) {
    if (!script.content) continue;
    const url = script.finalUrl ?? script.url;
    if (siteOrigin === null || originOf(url) !== siteOrigin) continue;
    sameOriginScripts.push({ url, content: script.content });
  }
  sameOriginScripts.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  let scanned = 0;
  let charsLeft = MAX_SCRIPT_SCAN_CHARS;
  for (const script of sameOriginScripts) {
    if (scanned >= MAX_SCRIPTS_SCANNED || charsLeft <= 0) break;
    const text = script.content.slice(0, Math.min(MAX_SCAN_CHARS, charsLeft));
    charsLeft -= text.length;
    scanned++;
    for (const ref of extractEndpointRefsFromScript(text, script.url)) {
      add(ref.url, "static-js", ref.discoveredVia, ref.method);
    }
  }
  const scriptsSkipped = sameOriginScripts.length - scanned;

  for (const page of input.pages) {
    for (const ref of page.refs) add(ref.url, "static-html", ref.discoveredVia, ref.method);
  }

  for (const req of input.renderedRequests ?? []) {
    add(req.url, "render", "render-request", normalizeMethod(req.method));
  }

  // Drop a method-less record when the same URL has a method-carrying one.
  const withMethod = new Set<string>();
  for (const c of byKey.values()) if (c.method) withMethod.add(c.url);
  const deduped = [...byKey.values()].filter((c) => c.method || !withMethod.has(c.url));

  // Stable order: source rank, then URL, then method. Input order must not leak
  // into the cap, or two runs over the same site could keep different endpoints.
  deduped.sort(
    (a, b) =>
      SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
      (a.url < b.url ? -1 : a.url > b.url ? 1 : 0) ||
      (a.method ?? "").localeCompare(b.method ?? "")
  );

  const candidates: EndpointCandidate[] = [];
  let crossOrigin = 0;
  for (const c of deduped) {
    if (candidates.length >= MAX_ENDPOINT_CANDIDATES) break;
    if (!c.sameOrigin) {
      if (crossOrigin >= MAX_CROSS_ORIGIN_CANDIDATES) continue;
      crossOrigin++;
    }
    candidates.push(c);
  }
  return {
    candidates,
    total: deduped.length,
    truncated: candidates.length < deduped.length || scriptsSkipped > 0,
    scriptsSkipped,
  };
}
