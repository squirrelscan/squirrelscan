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
  return CHALLENGE_INTERSTITIAL_PATTERNS.some((pattern) =>
    pattern.test(sample),
  );
}

/** Approximate visible-text length: drop scripts/styles/tags to tell an interstitial from real content. */
function visibleTextLength(html: string): number {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/**
 * Detect DataDome/Kasada bot-challenge interstitials that carry no generic interstitial
 * string (e.g. served at HTTP 200). A challenge is always a tiny-text body, so both marker
 * tiers require that (keeps a blog that merely prints the marker out). Strong markers are
 * challenge-only hosts and fire at any status; weak markers also appear on a protected
 * site's normal pages (e.g. a sparse SPA shell), so they additionally require a WAF
 * challenge status to avoid dropping real content.
 */
function detectFingerprintedChallenge(
  html: string,
  status: number,
): WafChallengeResult {
  const sample = html.slice(0, 20480);
  const challengeStatus = WAF_CHALLENGE_STATUS_CODES.has(status);
  let tinyBody: boolean | null = null; // computed lazily, only once a marker matches
  for (const sig of CHALLENGE_200_SIGNATURES) {
    const strong = sig.strongMarkers.some((pattern) => pattern.test(sample));
    const weak =
      !strong &&
      challengeStatus &&
      sig.weakMarkers.some((pattern) => pattern.test(sample));
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
export function detectWafChallengePage(
  page: {
    status: number;
    headers: { server?: string | null; cfCacheStatus?: string | null; xCache?: string | null };
    html: string | null;
  },
): WafChallengeResult {
  if (!page.html) {
    return { detected: false, provider: null };
  }

  if (hasChallengeInterstitialMarkers(page.html)) {
    const statusSuggestsChallenge = WAF_CHALLENGE_STATUS_CODES.has(page.status);
    const wafResult = detectWaf(
      buildWafHeaders(page),
      page.html.slice(0, 10240),
    );
    if (statusSuggestsChallenge || wafResult.detected) {
      return {
        detected: true,
        provider: wafResult.provider
          ? getWafProviderName(wafResult.provider)
          : null,
      };
    }
  }

  // DataDome/Kasada interstitials carry no generic marker and are often served at 200.
  return detectFingerprintedChallenge(page.html, page.status);
}
