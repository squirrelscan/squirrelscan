// security/csp - Content Security Policy header

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { headerPages, judgeHeaderPages } from "./header-pages";

type SitePage = NonNullable<RuleContext["site"]>["pages"][number];

// Key CSP directives that should be present for XSS protection
const _CRITICAL_DIRECTIVES = ["default-src", "script-src"];
const _RECOMMENDED_DIRECTIVES = [
  "style-src",
  "img-src",
  "frame-ancestors",
  "object-src",
];

// Overly permissive source expressions that weaken CSP. Matched against whole
// source tokens, never substrings (#427). `*` stands for every source whose
// host is a bare `*` (see isAnyHostSource); `https://*.example.com` scopes a
// host to one domain's subdomains and is not one of them.
const WEAK_VALUES = ["*", "data:", "blob:", "'unsafe-inline'", "'unsafe-eval'"];

/**
 * Same-origin path prefixes that sites commonly rewrite to a third-party
 * analytics host (#1604). A policy that allows only 'self' lets such a path
 * load third-party code, and the header alone cannot show it. Matched on whole
 * path segments: `/ingest` and `/ingest/x.js` match, `/ingestor.js` does not.
 * Keep this list small and documented in docs/rules/security/csp.mdx.
 */
export const CSP_PROXY_PATHS: readonly string[] = [
  "/_vercel/insights",
  "/_vercel/speed-insights",
  "/ingest",
  "/stats",
  "/plausible",
  "/umami",
];
/** Most crawled script URLs inspected for a proxy path. */
const MAX_PROXY_SCAN = 2000;

export const cspRule: Rule = {
  meta: {
    id: "security/csp",
    name: "Content Security Policy",
    description:
      "Checks for Content-Security-Policy header and validates directives",
    solution:
      "CSP prevents XSS attacks by restricting which resources can load. Start with a report-only policy to identify issues. Key directives: default-src 'self', script-src (avoid 'unsafe-inline'), img-src, style-src, frame-ancestors. Use nonces or hashes instead of 'unsafe-inline' for scripts. On pages that load third-party scripts, set connect-src to the hosts the page needs so a compromised vendor script cannot send data elsewhere, and add report-to or report-uri so violations are collected. Test thoroughly as strict CSP can break functionality.",
    category: "security",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    weight: 6,
    // Check names by outcome class (#1741).
    checks: [
      { name: "csp-missing", outcome: "problem" },
      { name: "csp-report-only", outcome: "problem" },
      { name: "csp-no-script-control", outcome: "problem" },
      { name: "csp-unsafe-scripts", outcome: "problem" },
      { name: "csp-wildcard", outcome: "problem" },
      { name: "csp-self-proxy-script", outcome: "problem" },
      { name: "csp-no-frame-ancestors", outcome: "problem" },
      { name: "csp-no-object-src", outcome: "problem" },
      { name: "csp-connect-unrestricted", outcome: "problem" },
      { name: "csp-strict-dynamic-third-party", outcome: "problem" },
      { name: "csp-no-reporting", outcome: "problem" },
      {
        name: "csp-present",
        outcome: "clean",
        clears: ["csp-missing", "csp-report-only"],
      },
      { name: "csp", outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const pages = headerPages(ctx);

    if (pages.length === 0) {
      return {
        checks: [
          {
            name: "csp",
            status: "skipped",
            message: "No pages to check",
            skipReason: "No pages crawled",
          },
        ],
      };
    }

    return {
      checks: judgeHeaderPages(ctx, pages, (page) => judgeCsp(ctx, page)),
    };
  },
};

/** The CSP checks of one page's response headers. */
function judgeCsp(ctx: RuleContext, page: SitePage): CheckResult[] {
  const checks: CheckResult[] = [];
  const headers = page.headers ?? {};
  const csp = headers["content-security-policy"];
  const cspReportOnly = headers["content-security-policy-report-only"];
  // #1735: every check names the page the header was read from and the header it read, as
  // structured evidence (`pages` is what affectedPages() counts; the header is what it says).
  const headerName =
    csp || !cspReportOnly
      ? "content-security-policy"
      : "content-security-policy-report-only";
  const evidence = (extra: Record<string, unknown> = {}) => ({
    pages: [page.url],
    details: { pageUrl: page.url, header: headerName, ...extra },
  });

  // No CSP at all - this is a warning now, not just info
  if (!csp && !cspReportOnly) {
    checks.push({
      name: "csp-missing",
      status: "warn",
      message: "No Content-Security-Policy header",
      value: "Site vulnerable to XSS without CSP",
      expected: "Content-Security-Policy header with script-src directive",
      ...evidence(),
    });
    return checks;
  }

  const policy = csp || cspReportOnly || "";
  const isReportOnly = !csp && !!cspReportOnly;

  // Parse directives
  const directives = parseCSP(policy);

  // #2087: the third-party script hosts this page loads. The containment
  // checks below only speak for a page that loads at least one.
  const thirdPartyHosts = thirdPartyScriptHosts(ctx, page);

  // Report-only mode
  if (isReportOnly) {
    checks.push({
      name: "csp-report-only",
      status: "warn",
      message: "CSP in report-only mode (not enforced)",
      value: "Policy violations are logged but not blocked",
      expected: "Use Content-Security-Policy to enforce",
      ...evidence(),
    });
  } else {
    checks.push({
      name: "csp-present",
      status: "pass",
      message: "CSP header present and enforced",
      value: policy.substring(0, 100) + (policy.length > 100 ? "..." : ""),
      ...evidence(),
    });
  }

  // Check for critical directives
  const hasDefaultSrc = directives.has("default-src");
  // `script-src-elem` and `script-src-attr` each cover one surface (script
  // elements, inline handlers) and leave eval() and the other surface
  // unrestricted, so neither alone is script control (#1600).
  const hasScriptSrc = directives.has("script-src");

  if (!hasDefaultSrc && !hasScriptSrc) {
    checks.push({
      name: "csp-no-script-control",
      status: "warn",
      message: "CSP has no script-src or default-src directive",
      value: directives.has("script-src-elem")
        ? "Inline event handlers and eval() are not restricted by script-src-elem"
        : "Scripts from any source are allowed",
      expected: "Add script-src or default-src directive",
      ...evidence(),
    });
  }

  // `script-src-elem` overrides `script-src` (and `default-src`) for <script>
  // elements, so inline, wildcard, data: and blob: sources are judged on it
  // when present (#1600). Inline event handlers (onerror=) are a separate
  // surface: `script-src-attr` governs them and falls back to `script-src`,
  // then `default-src`, never to `script-src-elem`, so 'unsafe-inline' there
  // is still judged from that chain. 'unsafe-eval' governs eval(), which no
  // element or attribute directive controls, so it stays on script-src /
  // default-src.
  const scriptSrc =
    directives.get("script-src") || directives.get("default-src") || "";
  const elemSrc = directives.get("script-src-elem") ?? scriptSrc;
  const attrSrc = directives.get("script-src-attr") ?? scriptSrc;
  const weakValues = [
    ...new Set([
      ...weakScriptSources(elemSrc).filter((v) => v !== "'unsafe-eval'"),
      ...weakScriptSources(attrSrc).filter((v) => v === "'unsafe-inline'"),
      ...weakScriptSources(scriptSrc).filter((v) => v === "'unsafe-eval'"),
    ]),
  ];

  // #1735: which directive carries each weak source, with its value, as structured details.
  const carriers = weakCarriers(directives, elemSrc, attrSrc, scriptSrc);
  const carrier = (source: string) =>
    carriers.find((c) => c.sources.includes(source));

  if (weakValues.length > 0) {
    // unsafe-inline and unsafe-eval are critical weaknesses
    const hasUnsafeInline = weakValues.includes("'unsafe-inline'");
    const hasUnsafeEval = weakValues.includes("'unsafe-eval'");

    if (hasUnsafeInline || hasUnsafeEval) {
      // #2087: on a page that loads third-party scripts, 'unsafe-eval' also lets
      // a compromised vendor script run a payload it builds from a string.
      const evalContext = hasUnsafeEval && thirdPartyHosts.length > 0;
      checks.push({
        name: "csp-unsafe-scripts",
        status: "warn",
        message: `CSP allows ${[hasUnsafeInline && "'unsafe-inline'", hasUnsafeEval && "'unsafe-eval'"].filter(Boolean).join(" and ")}`,
        value: evalContext
          ? `Weakens XSS protection significantly, and 'unsafe-eval' lets a compromised third-party script (${hostSummary(thirdPartyHosts)}) run code it builds from a string`
          : "Weakens XSS protection significantly",
        expected: evalContext
          ? "Use nonces or hashes instead of unsafe-inline, and remove 'unsafe-eval'"
          : "Use nonces or hashes instead of unsafe-inline",
        ...evidence({
          ...(evalContext ? { thirdPartyHosts } : {}),
          // The directive carrying 'unsafe-inline' (else 'unsafe-eval') and its value.
          ...((carrier("'unsafe-inline'") ?? carrier("'unsafe-eval'"))
            ? {
                directive: (carrier("'unsafe-inline'") ??
                  carrier("'unsafe-eval'"))!.directive,
                value: (carrier("'unsafe-inline'") ?? carrier("'unsafe-eval'"))!
                  .value,
              }
            : {}),
          directives: carriers,
        }),
      });
    }

    // Wildcard is also problematic
    if (weakValues.includes("*")) {
      checks.push({
        name: "csp-wildcard",
        status: "warn",
        message: "CSP script-src allows wildcard (*)",
        value: "Scripts can load from any domain",
        expected: "Restrict to specific trusted domains",
        ...evidence({
          ...(carrier("*")
            ? { directive: carrier("*")!.directive, value: carrier("*")!.value }
            : {}),
          directives: carriers,
        }),
      });
    }
  }

  // A 'self' script list also trusts any same-origin path that proxies
  // third-party code (#1604). Needs the crawled script URLs, no network.
  // Skipped when 'strict-dynamic' makes browsers ignore 'self', and when
  // several comma-joined policies are in play (they intersect, so 'self'
  // may be blocked by another one).
  const elemTokens = sourceTokens(elemSrc);
  if (
    !isReportOnly &&
    elemTokens.has("'self'") &&
    !elemTokens.has("'strict-dynamic'") &&
    !elemSrc.includes(",")
  ) {
    const paths = proxyPathsLoaded(ctx, page.url);
    if (paths.length > 0) {
      checks.push({
        name: "csp-self-proxy-script",
        status: "info",
        message: `CSP 'self' allows a possible first-party proxy path ${paths.join(", ")}`,
        value:
          "A same-origin path of this kind may proxy third-party code that runs under 'self'",
        expected:
          "Confirm the proxied script is trusted, or pin it with a nonce or hash",
        ...evidence({ paths }),
      });
    }
  }

  if (!isReportOnly && thirdPartyHosts.length > 0) {
    checks.push(...containmentChecks(policy, thirdPartyHosts, evidence));
  }

  // Check for frame-ancestors (clickjacking protection)
  if (!directives.has("frame-ancestors")) {
    const xfo = headers["x-frame-options"];
    if (!xfo) {
      checks.push({
        name: "csp-no-frame-ancestors",
        status: "info",
        message: "CSP missing frame-ancestors directive",
        value: "Consider adding for clickjacking protection",
        ...evidence(),
      });
    }
  }

  // Check for object-src (plugin-based attacks)
  if (!directives.has("object-src") && !hasDefaultSrc) {
    checks.push({
      name: "csp-no-object-src",
      status: "info",
      message: "CSP missing object-src directive",
      value: "Consider blocking plugins with object-src 'none'",
      ...evidence(),
    });
  }

  return checks;
}

/** Most third-party script hosts named in evidence. */
const MAX_THIRD_PARTY_HOSTS = 20;
/** Most hosts named in a message or value. */
const MAX_HOSTS_IN_TEXT = 3;

/** Network schemes a scheme-only connect source opens to every host. */
const NETWORK_SCHEME_SOURCES = new Set(["http:", "https:", "ws:", "wss:"]);

/**
 * #2087: whether an enforced policy would contain a hijacked third-party
 * script, judged from the header alone. A header that carries several
 * comma-joined policies is read per policy: the browser enforces all of them,
 * so one that restricts connections restricts them, and 'strict-dynamic'
 * trusts inserted scripts only when every policy that controls scripts says so.
 */
function containmentChecks(
  header: string,
  thirdPartyHosts: string[],
  evidence: (extra?: Record<string, unknown>) => {
    pages: string[];
    details: Record<string, unknown>;
  }
): CheckResult[] {
  const checks: CheckResult[] = [];
  const policies = header
    .split(",")
    .map(parseCSP)
    .filter((p) => p.size > 0);
  if (policies.length === 0) return checks;
  const hosts = hostSummary(thirdPartyHosts);

  const connect = policies.map(connectSource);
  if (connect.every((c) => c.open)) {
    const open = connect.find((c) => c.directive !== null) ?? connect[0]!;
    checks.push({
      name: "csp-connect-unrestricted",
      status: "warn",
      message: "Script on the page can send data to any host",
      value: open.directive
        ? `${open.directive} allows ${open.sources.join(" ")}, so a compromised third-party script (${hosts}) can send what it reads anywhere`
        : `No connect-src or default-src restricts connections, so a compromised third-party script (${hosts}) can send what it reads anywhere`,
      expected:
        "Set connect-src to the hosts the page needs to reach, such as connect-src 'self' https://api.example.com",
      ...evidence({
        ...(open.directive
          ? { directive: open.directive, value: open.value }
          : {}),
        thirdPartyHosts,
      }),
    });
  }

  const scriptLists = policies
    .map(scriptElementSource)
    .filter((v): v is string => v !== null);
  if (
    scriptLists.length > 0 &&
    scriptLists.every((v) => sourceTokens(v).has("'strict-dynamic'"))
  ) {
    checks.push({
      name: "csp-strict-dynamic-third-party",
      status: "info",
      message:
        "CSP 'strict-dynamic' also trusts every script a third-party script inserts",
      value: `A script that ${hosts} adds to the page runs without matching the policy, so a compromised vendor can load any code`,
      expected:
        "Keep 'strict-dynamic' only if you trust everything these vendors load, and restrict connect-src so inserted code cannot send data out",
      ...evidence({ thirdPartyHosts }),
    });
  }

  if (!policies.some((p) => p.has("report-uri") || p.has("report-to"))) {
    checks.push({
      name: "csp-no-reporting",
      status: "info",
      message: "CSP violations are not being collected",
      value: `The policy has no report-to or report-uri, so a blocked request from a compromised third-party script (${hosts}) goes unnoticed`,
      expected:
        "Add report-to (with a Reporting-Endpoints header) or report-uri",
      ...evidence({ thirdPartyHosts }),
    });
  }

  return checks;
}

/**
 * The connect directive browsers read for one policy (connect-src, else
 * default-src) and whether it lets script reach any host: absent, or carrying
 * an any-host source (`*`, `https://*`) or a network scheme-only source
 * (`https:`, `wss:`). `data:` and `blob:` are not network destinations.
 */
function connectSource(directives: Map<string, string>): {
  open: boolean;
  directive: string | null;
  value: string;
  sources: string[];
} {
  const directive = directives.has("connect-src")
    ? "connect-src"
    : directives.has("default-src")
      ? "default-src"
      : null;
  if (directive === null)
    return { open: true, directive: null, value: "", sources: [] };
  const value = directives.get(directive) ?? "";
  const sources = [...sourceTokens(value)].filter(
    (t) => isAnyHostSource(t) || NETWORK_SCHEME_SOURCES.has(t)
  );
  return {
    open: sources.length > 0,
    directive,
    value: value.slice(0, MAX_DIRECTIVE_VALUE),
    sources,
  };
}

/** One policy's source list for script elements, or null when it has none. */
function scriptElementSource(directives: Map<string, string>): string | null {
  return (
    directives.get("script-src-elem") ??
    directives.get("script-src") ??
    directives.get("default-src") ??
    null
  );
}

/** The first few hosts, then how many more. */
function hostSummary(hosts: string[]): string {
  const shown = hosts.slice(0, MAX_HOSTS_IN_TEXT).join(", ");
  const more = hosts.length - MAX_HOSTS_IN_TEXT;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/**
 * Hosts of the `<script src>` elements on one page that are served from
 * outside the page's own domain (#2087). Read from the page-time collected
 * signals on the streaming path, else from the live document; a page with
 * neither yields none. Script that the page's scripts insert at run time is
 * not seen: the rule reads the fetched HTML and executes nothing.
 */
function thirdPartyScriptHosts(ctx: RuleContext, page: SitePage): string[] {
  let pageUrl: URL;
  try {
    pageUrl = new URL(page.finalUrl ?? page.url);
  } catch {
    return [];
  }
  const srcs =
    ctx.collectedSignals?.pages.find((p) => p.url === page.url)?.scriptSrcs ??
    documentScriptSrcs(page.parsed?.document);
  const own = ownDomain(pageUrl.hostname);
  const hosts = new Set<string>();
  for (const src of srcs) {
    let url: URL;
    try {
      url = new URL(src, pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (host === own || host.endsWith(`.${own}`)) continue;
    hosts.add(host);
    if (hosts.size >= MAX_THIRD_PARTY_HOSTS) break;
  }
  return [...hosts];
}

/**
 * Raw `<script src>` values of a live document, leaving out scripts inside
 * `<noscript>` (they never load). Duck-typed on purpose: this file is part of
 * the dependency-free `@squirrelscan/rules/security-headers` entry, so it
 * cannot import the DOM helpers.
 */
function documentScriptSrcs(doc: unknown): string[] {
  const d = doc as {
    querySelectorAll?(sel: string): Iterable<{
      getAttribute(name: string): string | null;
      closest?(sel: string): unknown;
    }>;
  } | null;
  if (typeof d?.querySelectorAll !== "function") return [];
  const srcs: string[] = [];
  try {
    for (const el of d.querySelectorAll("script[src]")) {
      if (el.closest?.("noscript")) continue;
      const src = el.getAttribute("src");
      if (src !== null) srcs.push(src);
    }
  } catch {
    // linkedom edge cases: treat as no scripts.
  }
  return srcs;
}

/** Second-level labels that sit under a two-letter country code as a public suffix (`co.uk`, `com.au`). */
const CCTLD_SECOND_LEVELS = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "gov",
  "ltd",
  "ne",
  "net",
  "or",
  "org",
  "plc",
]);

/**
 * The domain whose hosts count as the page's own: the last two labels of the
 * page host (`www.example.com` owns `static.example.com`), or three when the
 * last two look like a country suffix such as `co.uk`. No public suffix list
 * is loaded here, so this is a guess, and it errs toward first party: a vendor
 * on another tenant of a shared hosting suffix is missed, a first-party CDN is
 * never reported. An IP address owns only itself.
 */
function ownDomain(pageHost: string): string {
  const host = pageHost.toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  const lastTwo = labels.slice(-2);
  const keep =
    lastTwo.length === 2 &&
    lastTwo[1]!.length === 2 &&
    CCTLD_SECOND_LEVELS.has(lastTwo[0]!)
      ? 3
      : 2;
  return labels.slice(-keep).join(".");
}

/** Longest directive value kept in evidence (the policy itself can be long). */
const MAX_DIRECTIVE_VALUE = 300;

/**
 * The directives that carry a weak script source, as evidence (#1735): the name
 * browsers read it from (`script-src-elem`, `script-src-attr`, `script-src` or
 * the `default-src` fallback), that directive's value, and which weak sources
 * it holds. Mirrors the checks above: elements are judged on script-src-elem,
 * inline handlers on script-src-attr ('unsafe-inline' only), eval on script-src.
 */
function weakCarriers(
  directives: Map<string, string>,
  elemSrc: string,
  attrSrc: string,
  scriptSrc: string
): Array<{ directive: string; value: string; sources: string[] }> {
  const named = (specific: string) =>
    directives.has(specific)
      ? specific
      : directives.has("script-src")
        ? "script-src"
        : "default-src";
  const rows = new Map<string, Set<string>>();
  const add = (directive: string, sources: string[]) => {
    if (sources.length === 0) return;
    const set = rows.get(directive) ?? new Set<string>();
    for (const source of sources) set.add(source);
    rows.set(directive, set);
  };
  add(
    named("script-src-elem"),
    weakScriptSources(elemSrc).filter((v) => v !== "'unsafe-eval'")
  );
  add(
    named("script-src-attr"),
    weakScriptSources(attrSrc).filter((v) => v === "'unsafe-inline'")
  );
  add(
    named("script-src"),
    weakScriptSources(scriptSrc).filter((v) => v === "'unsafe-eval'")
  );
  return [...rows].map(([directive, sources]) => ({
    directive,
    value: (directives.get(directive) ?? "").slice(0, MAX_DIRECTIVE_VALUE),
    sources: [...sources],
  }));
}

/** Known proxy prefixes that a crawled same-origin script URL falls under. */
function proxyPathsLoaded(ctx: RuleContext, pageUrl: string): string[] {
  let origin: string;
  try {
    origin = new URL(ctx.site?.baseUrl || pageUrl).origin;
  } catch {
    return [];
  }
  const found = new Set<string>();
  const scripts = ctx.site?.scripts ?? [];
  const limit = Math.min(scripts.length, MAX_PROXY_SCAN);
  for (let i = 0; i < limit && found.size < CSP_PROXY_PATHS.length; i++) {
    const script = scripts[i]!;
    if (script.status !== null && script.status >= 400) continue;
    let url: URL;
    try {
      url = new URL(script.url, origin);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    const path = url.pathname.toLowerCase();
    for (const prefix of CSP_PROXY_PATHS) {
      if (path === prefix || path.startsWith(`${prefix}/`)) found.add(prefix);
    }
  }
  return CSP_PROXY_PATHS.filter((p) => found.has(p));
}

/** The weak entries of WEAK_VALUES in one script directive's value. */
function weakScriptSources(scriptSrc: string): string[] {
  const sources = sourceTokens(scriptSrc);
  // CSP3: a nonce or hash in the list makes browsers ignore 'unsafe-inline',
  // and 'strict-dynamic' ignores it along with every host and scheme source
  // (#441). Read from the directive's own list only: tokens after a comma
  // belong to a comma-joined second policy, maybe to another directive. On
  // purpose this still warns when that second policy is itself strict.
  const ownSources = sourceTokens(scriptSrc.split(",", 1)[0] ?? "");
  const strictDynamic = ownSources.has("'strict-dynamic'");
  const inlineIgnored =
    strictDynamic || [...ownSources].some(isNonceOrHashSource);
  return WEAK_VALUES.filter((v) => {
    if (v === "*") return !strictDynamic && [...sources].some(isAnyHostSource);
    if (v === "'unsafe-inline'" && inlineIgnored) return false;
    return sources.has(v);
  });
}

/**
 * The source expressions of one directive value, lowercased. Keywords,
 * schemes and hosts all match case-insensitively in CSP, so `'UNSAFE-INLINE'`
 * is `'unsafe-inline'`. Commas split too: a header holding several policies
 * arrives comma-joined, and no source expression contains one.
 */
function sourceTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[\t\n\f\r ,]+/)
      .filter(Boolean)
  );
}

/**
 * A host-source whose host is a bare `*`, such as `*`, `https://*` or
 * `*:443`, with or without a path. Each one matches any host. A wildcard that
 * is only the first label, `*.example.com`, stays inside one domain.
 */
function isAnyHostSource(token: string): boolean {
  const afterScheme = token.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const host = afterScheme.split(/[:/]/, 1)[0];
  return host === "*";
}

/**
 * A nonce-source or hash-source, such as `'nonce-r4nd0m'` or `'sha256-…'`.
 * `token` comes from `sourceTokens`, already lowercased, so the base64 class
 * needs no upper-case letters.
 */
function isNonceOrHashSource(token: string): boolean {
  // base64-value: one or more base64 characters, then at most two `=`.
  return /^'(?:nonce|sha256|sha384|sha512)-[a-z0-9+/_-]+={0,2}'$/.test(token);
}

/**
 * Parse CSP header into directive map
 */
function parseCSP(policy: string): Map<string, string> {
  const directives = new Map<string, string>();

  for (const part of policy.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) {
      directives.set(trimmed.toLowerCase(), "");
    } else {
      const name = trimmed.substring(0, spaceIdx).toLowerCase();
      const value = trimmed.substring(spaceIdx + 1);
      directives.set(name, value);
    }
  }

  return directives;
}
