import type { WafChallengeResult } from "./types";
import {
  CHALLENGE_200_SIGNATURES,
  CHALLENGE_INTERSTITIAL_MAX_TEXT,
  CHALLENGE_INTERSTITIAL_PATTERNS,
  WAF_CHALLENGE_STATUS_CODES,
  getWafProviderName,
} from "./providers";
import { detectWaf } from "./detect";

function hasChallengeInterstitialMarkers(html: string): boolean {
  const sample = html.slice(0, 10240);
  return CHALLENGE_INTERSTITIAL_PATTERNS.some((pattern) => pattern.test(sample));
}

function tagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return html.length - 1;
}

function skipElement(lower: string, html: string, tag: string, start: number): number {
  const prefix = `</${tag}`;
  let cursor = start;
  while (cursor < html.length) {
    const close = lower.indexOf(prefix, cursor);
    if (close < 0) return html.length;
    const boundary = lower[close + prefix.length];
    if (boundary === ">" || /\s/.test(boundary ?? "")) {
      return tagEnd(html, close + prefix.length) + 1;
    }
    cursor = close + prefix.length;
  }
  return html.length;
}

/** Approximate visible-text length without backtracking over hostile markup. */
function visibleTextLength(html: string): number {
  const lower = html.toLowerCase();
  let cursor = 0;
  let length = 0;
  let pendingSpace = false;

  while (cursor < html.length) {
    if (html[cursor] === "<") {
      if (lower.startsWith("<!--", cursor)) {
        const end = lower.indexOf("-->", cursor + 4);
        cursor = end < 0 ? html.length : end + 3;
        pendingSpace = true;
        continue;
      }

      const end = tagEnd(html, cursor + 1);
      let nameStart = cursor + 1;
      while (/\s/.test(lower[nameStart] ?? "")) nameStart++;
      let nameEnd = nameStart;
      while (/[a-z]/.test(lower[nameEnd] ?? "")) nameEnd++;
      const name = lower.slice(nameStart, nameEnd);
      cursor =
        name === "script" || name === "style" ? skipElement(lower, html, name, end + 1) : end + 1;
      pendingSpace = true;
      continue;
    }

    if (html[cursor] === "&") {
      const entityEnd = html.indexOf(";", cursor + 1);
      if (entityEnd > cursor && entityEnd - cursor <= 32) {
        cursor = entityEnd + 1;
        pendingSpace = true;
        continue;
      }
    }

    if (/\s/.test(html[cursor])) {
      pendingSpace = true;
    } else {
      if (pendingSpace && length > 0) length++;
      length++;
      pendingSpace = false;
      if (length > CHALLENGE_INTERSTITIAL_MAX_TEXT) return length;
    }
    cursor++;
  }

  return length;
}

/**
 * Detect DataDome/Kasada bot-challenge interstitials that carry no generic interstitial
 * string (e.g. served at HTTP 200). A challenge is always a tiny-text body, so both marker
 * tiers require that (keeps a blog that merely prints the marker out). Strong markers are
 * challenge-only hosts and fire at any status; weak markers also appear on a protected
 * site's normal pages (e.g. a sparse SPA shell), so they additionally require a WAF
 * challenge status to avoid dropping real content.
 */
function detectFingerprintedChallenge(html: string, status: number): WafChallengeResult {
  const sample = html.slice(0, 20480);
  const challengeStatus = WAF_CHALLENGE_STATUS_CODES.has(status);
  let tinyBody: boolean | null = null; // computed lazily, only once a marker matches
  for (const sig of CHALLENGE_200_SIGNATURES) {
    const strong = sig.strongMarkers.some((pattern) => pattern.test(sample));
    const weak =
      !strong && challengeStatus && sig.weakMarkers.some((pattern) => pattern.test(sample));
    if (!strong && !weak) {
      continue;
    }
    if (tinyBody === null) {
      tinyBody = visibleTextLength(html) <= CHALLENGE_INTERSTITIAL_MAX_TEXT;
    }
    if (tinyBody) {
      return { detected: true, provider: getWafProviderName(sig.provider) };
    }
  }
  return { detected: false, provider: null };
}

function buildWafHeaders(page: {
  headers: { server?: string | null; cfCacheStatus?: string | null; xCache?: string | null };
}): Headers {
  const headers = new Headers();
  if (page.headers.server) {
    headers.set("server", page.headers.server);
  }
  if (page.headers.cfCacheStatus) {
    headers.set("cf-cache-status", page.headers.cfCacheStatus);
  }
  if (page.headers.xCache) {
    headers.set("x-cache", page.headers.xCache);
  }
  return headers;
}

/** Detect whether page HTML appears to be a WAF/challenge interstitial. */
export function detectWafChallengePage(page: {
  status: number;
  headers: { server?: string | null; cfCacheStatus?: string | null; xCache?: string | null };
  html: string | null;
}): WafChallengeResult {
  if (!page.html) {
    return { detected: false, provider: null };
  }

  if (hasChallengeInterstitialMarkers(page.html)) {
    const statusSuggestsChallenge = WAF_CHALLENGE_STATUS_CODES.has(page.status);
    const wafResult = detectWaf(buildWafHeaders(page), page.html.slice(0, 10240));
    if (statusSuggestsChallenge || wafResult.detected) {
      return {
        detected: true,
        provider: wafResult.provider ? getWafProviderName(wafResult.provider) : null,
      };
    }
  }

  // DataDome/Kasada interstitials carry no generic marker and are often served at 200.
  return detectFingerprintedChallenge(page.html, page.status);
}
