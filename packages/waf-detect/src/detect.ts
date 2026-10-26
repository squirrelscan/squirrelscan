import type { WafDetectionResult, WafProvider } from "./types";
import {
  CONTENT_PATTERNS,
  COOKIE_PATTERNS,
  HEADER_PATTERNS,
  PROVIDER_PRECEDENCE,
} from "./providers";
import { signatureViews } from "./views";

type Confidence = WafDetectionResult["confidence"];

const NO_WAF: WafDetectionResult = {
  detected: false,
  provider: null,
  confidence: "low",
  indicators: [],
  providers: [],
};

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** What one source (headers, cookies, body) said: each provider's best confidence, and why. */
interface Signals {
  confidence: Map<WafProvider, Confidence>;
  indicators: string[];
}

function emptySignals(): Signals {
  return { confidence: new Map(), indicators: [] };
}

function note(signals: Signals, provider: WafProvider, confidence: Confidence, indicator: string): void {
  signals.indicators.push(indicator);
  const prior = signals.confidence.get(provider);
  if (prior === undefined || RANK[confidence] > RANK[prior]) {
    signals.confidence.set(provider, confidence);
  }
}

function merge(...all: Signals[]): Signals {
  const merged = emptySignals();
  for (const signals of all) {
    merged.indicators.push(...signals.indicators);
    for (const [provider, confidence] of signals.confidence) {
      const prior = merged.confidence.get(provider);
      if (prior === undefined || RANK[confidence] > RANK[prior]) {
        merged.confidence.set(provider, confidence);
      }
    }
  }
  return merged;
}

/** Attribute: the most specific provider with a signal (PROVIDER_PRECEDENCE), with its confidence. */
function attribute(signals: Signals): WafDetectionResult {
  if (signals.confidence.size === 0) return NO_WAF;
  const providers = PROVIDER_PRECEDENCE.filter((provider) => signals.confidence.has(provider));
  const provider = providers[0] ?? null;
  return {
    detected: true,
    provider,
    confidence: provider ? (signals.confidence.get(provider) ?? "low") : "low",
    indicators: signals.indicators,
    providers,
  };
}

/**
 * The cookie NAMES a response sets, values dropped: `set-cookie` values are
 * sessions and tokens, and nothing downstream needs them (#750).
 */
export function cookieNamesFromHeaders(headers: Headers): string[] {
  const names: string[] = [];
  for (const cookie of headers.getSetCookie()) {
    const end = cookie.indexOf("=");
    const name = (end < 0 ? cookie : cookie.slice(0, end)).trim();
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  return names;
}

function headerSignals(headers: Headers): Signals {
  const signals = emptySignals();
  for (const { provider, headers: headerPatterns, confidence } of HEADER_PATTERNS) {
    for (const { name, pattern } of headerPatterns) {
      const value = headers.get(name);
      if (value !== null && (!pattern || pattern.test(value))) {
        note(signals, provider, confidence, `header:${name}=${value.slice(0, 50)}`);
      }
    }
  }
  return signals;
}

function cookieSignals(names: readonly string[]): Signals {
  const signals = emptySignals();
  for (const { provider, names: patterns, confidence } of COOKIE_PATTERNS) {
    for (const name of names) {
      if (patterns.some((pattern) => pattern.test(name))) {
        note(signals, provider, confidence, `cookie:${name}`);
      }
    }
  }
  return signals;
}

function contentSignals(html: string): Signals {
  const signals = emptySignals();
  // Only check first 10KB to avoid performance issues. Each pattern reads the
  // view it acts in, so a page quoting a signature is not attributed (#693).
  const views = signatureViews(html.slice(0, 10240));
  for (const { provider, patterns, confidence, view } of CONTENT_PATTERNS) {
    const sample = views[view];
    for (const pattern of patterns) {
      if (pattern.test(sample)) {
        note(signals, provider, confidence, `content:${pattern.source.slice(0, 30)}`);
        break; // One match per provider is enough
      }
    }
  }
  return signals;
}

/** Detect WAF from response headers, including the cookie names they set. */
export function detectWafFromHeaders(headers: Headers): WafDetectionResult {
  return attribute(merge(headerSignals(headers), cookieSignals(cookieNamesFromHeaders(headers))));
}

/** Detect WAF from cookie names alone (a stored response that kept names, not values). */
export function detectWafFromCookies(names: readonly string[]): WafDetectionResult {
  return attribute(cookieSignals(names));
}

/** Detect WAF from response body (challenge/block pages) */
export function detectWafFromContent(html: string): WafDetectionResult {
  return attribute(contentSignals(html));
}

/**
 * Combined WAF detection from headers, the cookies they set, and an optional
 * body. Every source is read and the most specific provider wins, so a
 * DataDome block served through Cloudflare (`cf-ray` plus DataDome's cookie,
 * header or markup) is attributed to DataDome, not Cloudflare (#750).
 */
export function detectWaf(headers: Headers, body?: string): WafDetectionResult {
  const fromHeaders = merge(headerSignals(headers), cookieSignals(cookieNamesFromHeaders(headers)));
  return attribute(body ? merge(fromHeaders, contentSignals(body)) : fromHeaders);
}

/**
 * Quick check if a 403 response is likely WAF-blocked.
 * Use for external link checking to distinguish "truly forbidden" from "bot blocked".
 *
 * Headers and body only, never cookies: a bot product sets its cookies on
 * every response of a site it protects, so a genuine "forbidden" 403 there
 * carries them too (#750).
 */
export function isLikelyWafBlock(
  status: number,
  headers: Headers,
  body?: string,
): boolean {
  if (status !== 403) {
    return false;
  }
  const signals = body ? merge(headerSignals(headers), contentSignals(body)) : headerSignals(headers);
  return attribute(signals).detected;
}
