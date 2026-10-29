// Resolve the start URL's redirect chain before a crawl (squirrelscan/squirrelscan#1281).
//
// One request per hop, each through the egress guard (the same one the crawl's
// seed probe uses), manually followed so the chain is recorded and a hop that is
// refused is never sent. The caller decides what a cross-domain end means; this
// only reports it.

import {
  type SeedRedirectHop,
  type SeedRedirectResolution,
  MAX_SEED_REDIRECT_HOPS,
  redactUrl,
} from "@squirrelscan/core-contracts/seed-redirect";
import { isNonPublicUrl } from "@squirrelscan/utils/non-public-host";
import {
  EgressRefusedError,
  type EgressPolicy,
  egressGuardedSend,
  resolveHostAddresses,
} from "@squirrelscan/utils/public-egress";
import { fetchUndecoded } from "@squirrelscan/utils/response-body";
import { FALLBACK_USER_AGENT } from "@squirrelscan/utils/user-agent";

import { isSameSite } from "./frontier";

const HOP_TIMEOUT_MS = 10_000;
/** The whole chain, so six slow hops cannot park a run before it starts. */
const TOTAL_BUDGET_MS = 30_000;

export interface ResolveStartRedirectOptions {
  /**
   * The request a vetted hop is sent with; tests inject one. Default: the
   * undecoded fetch. Always behind the egress guard.
   */
  transport?: (url: string, init: RequestInit) => Promise<Response>;
  /** Overrides the guard's policy; tests inject DNS here. */
  policy?: Partial<EgressPolicy>;
  /**
   * Connect to the address a hop was vetted on (default). False where the own
   * hosts are not pinned (opted out, or an environment proxy carries the
   * request and resolves for itself): the start URL's host is then sent by name.
   */
  pin?: boolean;
  userAgent?: string;
  /** Per-hop timeout in ms. */
  timeoutMs?: number;
  /** Hops allowed before the chain is reported as too long. */
  maxHops?: number;
}

function parseHttp(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

/** A URL as the loop check compares it: no fragment, which is never sent. */
function visitKey(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

/**
 * Follow `url`'s HTTP redirects and say where the chain ends.
 *
 * Never throws: a network failure on a hop ends the chain there (the audit's
 * own reachability check reports an unreachable destination), and a hop the
 * guard refuses ends it as `refused`. Client-side redirects (meta refresh,
 * script) are not followed here: they are the page's, not the start URL's.
 *
 * The guard's private-network allowance follows the start URL: auditing
 * `localhost` or a LAN address may redirect around the LAN, a public start URL
 * may not redirect into one. Link-local and cloud metadata addresses are
 * refused either way.
 */
export async function resolveStartRedirect(
  url: string,
  options: ResolveStartRedirectOptions = {},
): Promise<SeedRedirectResolution> {
  const start = parseHttp(url);
  if (!start) return { kind: "none", originalUrl: url, finalUrl: url, chain: [] };

  const policy: EgressPolicy = {
    allowPrivateNetwork: isNonPublicUrl(url),
    resolve: resolveHostAddresses,
    ...(options.pin === false ? { pin: false } : {}),
    // Not pinned (opted out, or an environment proxy carries the request): the
    // start URL's own host goes out by name, as the crawl sends it, so a name
    // that only the proxy resolves is not looked up here. Every other hop is
    // still vetted.
    ...(options.pin === false
      ? { trustTarget: (hop: URL) => hop.hostname === start.hostname }
      : {}),
    ...options.policy,
  };
  const send = egressGuardedSend(options.transport ?? fetchUndecoded, policy);
  const maxHops = options.maxHops ?? MAX_SEED_REDIRECT_HOPS;
  const hopTimeout = options.timeoutMs ?? HOP_TIMEOUT_MS;
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const headers = {
    "user-agent": options.userAgent || FALLBACK_USER_AGENT,
    accept: "text/html,application/xhtml+xml,*/*;q=0.8",
  };

  const chain: SeedRedirectHop[] = [];
  // Redirecting responses so far: the chain also holds the destination's answer.
  let redirects = 0;
  // Any hop, not only the last, left the start URL's site (a detour through
  // another domain and back is still another site's redirect).
  let crossed = false;
  const visited = new Set<string>([visitKey(start)]);
  let current = start;

  const done = (
    final: URL | string,
    kind?: "loop" | "too-many" | "refused",
    refusal?: string,
  ): SeedRedirectResolution => {
    const finalUrl = typeof final === "string" ? final : final.href;
    const finalParsed = typeof final === "string" ? parseHttp(final) : final;
    // A start URL the guard refuses outright is not a redirect: the audit's own
    // reachability check reports it, in the words it always has.
    const resolved =
      (kind === "refused" && redirects === 0 ? "none" : kind) ??
      (redirects === 0
        ? "none"
        : !crossed && finalParsed && isSameSite(start, finalParsed)
          ? "same-site"
          : "cross-domain");
    return {
      kind: resolved,
      originalUrl: url,
      finalUrl: redactUrl(finalUrl),
      chain: chain.map((hop) => ({ url: redactUrl(hop.url), status: hop.status })),
      ...(refusal ? { refusal } : {}),
    };
  };

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return done(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(hopTimeout, remaining));
    let response: Response;
    try {
      response = await send(current.href, {
        method: "GET",
        redirect: "manual",
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof EgressRefusedError) {
        return done(current, "refused", error.message);
      }
      return done(current);
    }
    clearTimeout(timer);
    // Only the headers matter; closing the body frees the socket.
    response.body?.cancel().catch(() => {});

    const location =
      response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    chain.push({ url: current.href, status: response.status });
    if (!location) return done(current);

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return done(current);
    }
    redirects++;
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      return done(current, "refused", `refused scheme ${next.protocol}`);
    }
    if (!isSameSite(start, next)) crossed = true;
    if (visited.has(visitKey(next))) return done(next, "loop");
    if (redirects > maxHops) return done(next, "too-many");
    visited.add(visitKey(next));
    current = next;
  }
}
