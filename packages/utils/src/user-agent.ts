/// <reference path="./external.d.ts" />

// Random user-agent generation for realistic crawling
// Uses user-agents package for up-to-date browser fingerprints, filtered to
// current-generation browsers only (#854): the unfiltered pool includes UAs
// back to Chrome 39 (~2014), and Cloudflare tarpits requests from those,
// turning crawl speed into a per-run lottery.

import UserAgent from "user-agents";

const MIN_CHROME_MAJOR = 120;
const MIN_EDGE_MAJOR = 120;
const MIN_FIREFOX_MAJOR = 115;
const MIN_SAFARI_MAJOR = 16;

// Used when the modern-browser filter can't produce a candidate (empty
// dataset match, or the underlying package throws) so crawls never stall.
export const FALLBACK_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * True when a UA string identifies a current-generation browser (Chrome/Edge
 * >= 120, Firefox >= 115, Safari >= 16). Unparseable strings return false.
 */
export function isModernUserAgentString(ua: string): boolean {
  // Edge (desktop "Edg/", Android "EdgA/", iOS "EdgiOS/") also carries a
  // Chrome/ or Safari Version/ token, so it must be checked first.
  const edge = ua.match(/Edg(?:A|iOS)?\/(\d+)/);
  if (edge) return Number(edge[1]) >= MIN_EDGE_MAJOR;

  // iOS Chrome identifies as "CriOS/" instead of "Chrome/".
  const chrome = ua.match(/(?:Chrome|CriOS)\/(\d+)/);
  if (chrome) return Number(chrome[1]) >= MIN_CHROME_MAJOR;

  // iOS Firefox identifies as "FxiOS/" instead of "Firefox/".
  const firefox = ua.match(/(?:Firefox|FxiOS)\/(\d+)/);
  if (firefox) return Number(firefox[1]) >= MIN_FIREFOX_MAJOR;

  if (ua.includes("Safari/")) {
    // Safari's own version lives in "Version/X"; "Safari/X" is the WebKit build number.
    const safari = ua.match(/Version\/(\d+)/);
    if (safari) return Number(safari[1]) >= MIN_SAFARI_MAJOR;
  }

  return false;
}

// Reused across draws: constructing the filter is the expensive part (the
// package resamples its dataset), `.random()` on an existing instance is cheap.
let modernPoolGenerator: UserAgent | null | undefined;

function getModernPoolGenerator(): UserAgent | null {
  if (modernPoolGenerator !== undefined) return modernPoolGenerator;
  try {
    modernPoolGenerator = new UserAgent((data: { userAgent: string }) =>
      isModernUserAgentString(data.userAgent),
    );
  } catch {
    // user-agents throws if a filter matches zero entries in its dataset snapshot.
    modernPoolGenerator = null;
  }
  return modernPoolGenerator;
}

/**
 * Get a random browser user-agent string, restricted to modern desktop,
 * mobile, and tablet browsers.
 */
export function getRandomUserAgent(): string {
  const generator = getModernPoolGenerator();
  if (!generator) return FALLBACK_USER_AGENT;
  try {
    return generator.random().toString();
  } catch {
    return FALLBACK_USER_AGENT;
  }
}

/**
 * Resolve user-agent: use provided value or generate random
 * Empty string triggers random generation
 */
export function resolveUserAgent(configValue: string): string {
  if (configValue === "") {
    return getRandomUserAgent();
  }
  return configValue;
}
