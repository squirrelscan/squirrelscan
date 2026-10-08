// CSP policy parsing and source-list matching (CSP3 section 6.7), shared by
// security/csp-blocks-own-resources. Only what a static check needs: http(s)
// resources, host/scheme/port/path sources, 'self', 'none' and 'strict-dynamic'.

/** The fetch directives a page's markup and a vendor's runtime hosts map onto. */
export type CspFetchKind = "script" | "style" | "frame" | "img" | "font" | "connect";

/** Directives consulted for each kind, most specific first (CSP3 fallback list). */
export const CSP_FALLBACK: Record<CspFetchKind, readonly string[]> = {
  script: ["script-src-elem", "script-src", "default-src"],
  style: ["style-src-elem", "style-src", "default-src"],
  frame: ["frame-src", "child-src", "default-src"],
  img: ["img-src", "default-src"],
  font: ["font-src", "default-src"],
  connect: ["connect-src", "default-src"],
};

/** One policy: directive name to its source expressions. */
export type CspPolicy = Map<string, string[]>;

/**
 * Split a header value into policies and directives. A header repeated or
 * several policies joined arrive comma-separated, and every one of them has to
 * allow a resource. The first occurrence of a directive wins, as in a browser.
 */
export function parseCspPolicies(header: string, commaSeparated = true): CspPolicy[] {
  const policies: CspPolicy[] = [];
  // A meta tag holds exactly one policy, so only a header is split on commas.
  for (const raw of commaSeparated ? header.split(",") : [header]) {
    const policy: CspPolicy = new Map();
    for (const part of raw.split(";")) {
      const tokens = part.trim().split(/[\t\n\f\r ]+/).filter(Boolean);
      const name = tokens.shift()?.toLowerCase();
      if (!name || policy.has(name)) continue;
      policy.set(name, tokens);
    }
    if (policy.size > 0) policies.push(policy);
  }
  return policies;
}

/** The directive that governs `kind` in `policy`, or undefined when none applies. */
export function governingDirective(policy: CspPolicy, kind: CspFetchKind): string | undefined {
  return CSP_FALLBACK[kind].find((name) => policy.has(name));
}

export interface ResourceContext {
  /** The document's own URL: the base for 'self' and for scheme-less sources. */
  page: URL;
  /** `upgrade-insecure-requests` rewrites an http subresource to https. */
  upgradeInsecure: boolean;
}

function defaultPort(protocol: string): string {
  return protocol === "https:" || protocol === "wss:" ? "443" : protocol === "http:" || protocol === "ws:" ? "80" : "";
}

function portOf(url: URL): string {
  return url.port || defaultPort(url.protocol);
}

/** Scheme equality, allowing the secure upgrade the spec permits (http to https). */
function schemeMatches(source: string, resource: string): boolean {
  if (source === resource) return true;
  return (
    (source === "http" && resource === "https") ||
    (source === "ws" && (resource === "wss" || resource === "https" || resource === "http")) ||
    (source === "wss" && resource === "https")
  );
}

const HOST_SOURCE_RE =
  /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9_]+(?:[.-][a-z0-9_]+)*)\.?(?::(\*|\d+))?(\/[^?#]*)?$/i;

function pathMatches(sourcePath: string | undefined, resourcePath: string): boolean {
  if (!sourcePath) return true;
  const decode = (p: string) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  };
  const want = decode(sourcePath);
  const got = decode(resourcePath);
  return want.endsWith("/") ? got.startsWith(want) : got === want;
}

/** Whether one source expression allows `resource`. `'self'` and host sources only. */
function sourceMatches(token: string, resource: URL, ctx: ResourceContext): boolean {
  const lower = token.toLowerCase();
  if (lower === "'self'") {
    const page = ctx.page;
    return (
      resource.hostname === page.hostname &&
      portOf(resource) === portOf(page) &&
      schemeMatches(page.protocol.slice(0, -1), resource.protocol.slice(0, -1))
    );
  }
  if (lower.startsWith("'")) return false;

  // A scheme-source: `https:` allows any https URL, `http:` allows http and https.
  const schemeOnly = /^([a-z][a-z0-9+.-]*):$/.exec(lower);
  if (schemeOnly) return schemeMatches(schemeOnly[1]!, resource.protocol.slice(0, -1));

  const m = HOST_SOURCE_RE.exec(token);
  if (!m) return false;
  const [, scheme, host, port, path] = m;
  const resourceScheme = resource.protocol.slice(0, -1);

  if (scheme) {
    if (!schemeMatches(scheme.toLowerCase(), resourceScheme)) return false;
  } else if (host !== "*" || port || path) {
    // No scheme: the page's own scheme, or https when the page is http. A bare
    // `*` takes any network scheme, which for http(s) resources is all of them.
    if (!schemeMatches(ctx.page.protocol.slice(0, -1), resourceScheme)) return false;
  }

  const wanted = host!.toLowerCase();
  const got = resource.hostname.toLowerCase().replace(/\.$/, "");
  if (wanted !== "*") {
    if (wanted.startsWith("*.")) {
      // `*.example.com` needs a label before the dot, so `example.com` itself is
      // intentionally not matched (CSP3 host-part matching).
      if (!got.endsWith(wanted.slice(1))) return false;
    } else if (wanted !== got) {
      return false;
    }
  }

  if (port === "*") {
    // any port
  } else if (port) {
    if (port !== portOf(resource)) return false;
  } else if (resource.port && resource.port !== defaultPort(resource.protocol)) {
    return false;
  }

  return pathMatches(path, resource.pathname);
}

export interface MatchOptions {
  /** The element's `nonce` attribute, which a `'nonce-...'` source can match. */
  nonce?: string;
  /** The element carries `integrity`, which a hash source can allow (CSP3). */
  integrity?: boolean;
}

/**
 * Whether `sources` (one directive's expression list) allow `url`. Returns
 * `undefined` when a static check cannot decide, so the caller reports nothing:
 * `'strict-dynamic'` makes the browser ignore host sources for scripts.
 */
export function sourceListAllows(
  sources: readonly string[],
  url: URL,
  kind: CspFetchKind,
  ctx: ResourceContext,
  opts: MatchOptions = {},
): boolean | undefined {
  const lowered = sources.map((s) => s.toLowerCase());
  if (kind === "script" && lowered.includes("'strict-dynamic'")) return undefined;
  // A hash source can allow an external file whose `integrity` matches; the
  // hash is not checked here, so the verdict is undecidable rather than a block.
  if (opts.integrity && lowered.some((s) => /^'sha(?:256|384|512)-/.test(s))) return undefined;
  if (lowered.length === 0 || (lowered.length === 1 && lowered[0] === "'none'")) return false;

  if (opts.nonce) {
    const wanted = `'nonce-${opts.nonce}'`;
    if (sources.includes(wanted)) return true;
  }

  const target = ctx.upgradeInsecure && url.protocol === "http:" && ctx.page.protocol === "https:"
    ? new URL(url.href.replace(/^http:/, "https:"))
    : url;
  return sources.some((token) => sourceMatches(token, target, ctx));
}

/**
 * Whether every policy allows `url` for `kind`. A policy with no governing
 * directive allows it. `undefined` when any governing list is undecidable.
 */
export function policiesAllow(
  policies: readonly CspPolicy[],
  url: URL,
  kind: CspFetchKind,
  page: URL,
  opts: MatchOptions = {},
): { allowed: boolean | undefined; directive?: string } {
  let undecided = false;
  for (const policy of policies) {
    const directive = governingDirective(policy, kind);
    if (!directive) continue;
    const ctx: ResourceContext = { page, upgradeInsecure: policy.has("upgrade-insecure-requests") };
    const verdict = sourceListAllows(policy.get(directive)!, url, kind, ctx, opts);
    if (verdict === false) return { allowed: false, directive };
    if (verdict === undefined) undecided = true;
  }
  return { allowed: undecided ? undefined : true };
}
