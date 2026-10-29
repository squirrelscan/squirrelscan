import type { WafChallengeDetail, WafChallengeResult, WafResponse } from "./types";
import {
  CHALLENGE_200_SIGNATURES,
  CHALLENGE_INTERSTITIAL_MAX_TEXT,
  CHALLENGE_MARKUP_SIGNATURES,
  CHALLENGE_TEXT_PATTERNS,
  WAF_CHALLENGE_STATUS_CODES,
  getWafProviderName,
} from "./providers";
import { classifyWafResponse } from "./classify";
import { detectWaf } from "./detect";
import { signatureViews } from "./views";
import { visibleTextLength } from "./visible-text";

/**
 * Which kind of interstitial marker the page's opening carries, if any. Markup
 * is checked first on purpose: a page with both is held to the markup rule.
 * Each marker is read where it acts, so a page quoting one is not a challenge
 * (#693).
 */
function challengeMarkers(html: string): "markup" | "text" | null {
  const views = signatureViews(html.slice(0, 10240));
  if (CHALLENGE_MARKUP_SIGNATURES.some(({ view, pattern }) => pattern.test(views[view]))) {
    return "markup";
  }
  if (CHALLENGE_TEXT_PATTERNS.some((pattern) => pattern.test(views.text))) return "text";
  return null;
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
  // Every marker is a host or a script object, read where it acts (#693).
  const sample = signatureViews(html.slice(0, 20480)).markup;
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

function buildWafHeaders(page: WafResponse): Headers {
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

/**
 * Detect whether a response is a WAF/bot challenge or block page, and say who
 * and why. `detected` is the high-confidence reading (see `classifyWafResponse`).
 */
export function inspectWafChallengePage(page: WafResponse): WafChallengeDetail {
  const block = classifyWafResponse(page);
  if (block.verdict === "blocked") {
    return { detected: true, provider: block.provider, providerId: block.providerId, signal: block.signal };
  }

  if (!page.html) {
    return NOT_DETECTED;
  }

  const markers = challengeMarkers(page.html);
  if (markers) {
    const statusSuggestsChallenge = WAF_CHALLENGE_STATUS_CODES.has(page.status);
    const wafResult = detectWaf(buildWafHeaders(page), page.html.slice(0, 10240));
    // Challenge text alone is something any page can say, so on a 200 it takes
    // challenge markup to call the page a challenge: a protected site's own
    // pages carry its WAF's headers too (#666).
    if (statusSuggestsChallenge || (markers === "markup" && wafResult.detected)) {
      return {
        detected: true,
        provider: wafResult.provider ? getWafProviderName(wafResult.provider) : null,
        providerId: wafResult.provider,
        signal: markers === "markup" ? "challenge page markup" : "challenge page wording",
      };
    }
  }

  // DataDome/Kasada interstitials carry no generic marker and are often served at 200.
  const fingerprinted = detectFingerprintedChallenge(page.html, page.status);
  if (!fingerprinted.detected) return NOT_DETECTED;
  return {
    ...fingerprinted,
    providerId: fingerprinted.provider === "DataDome" ? "datadome" : "kasada",
    signal: "bot-challenge script on a near-empty page",
  };
}

const NOT_DETECTED: WafChallengeDetail = { detected: false, provider: null, providerId: null, signal: null };

/** Detect whether page HTML appears to be a WAF/challenge interstitial. */
export function detectWafChallengePage(page: WafResponse): WafChallengeResult {
  const { detected, provider } = inspectWafChallengePage(page);
  return { detected, provider };
}
