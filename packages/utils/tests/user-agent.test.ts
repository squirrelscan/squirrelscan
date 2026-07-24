// Unit tests for the modern-browser UA pool (#854).
//
// The unfiltered `user-agents` package dataset includes UAs back to Chrome 39
// (~2014); Cloudflare tarpits requests from those, making crawl speed a
// per-run lottery. getRandomUserAgent() must only draw current-generation
// browsers.

import { describe, expect, test } from "bun:test";

import {
  FALLBACK_USER_AGENT,
  getRandomUserAgent,
  isModernUserAgentString,
  resolveUserAgent,
} from "../src/user-agent";

const MIN_CHROME_MAJOR = 120;
const MIN_FIREFOX_MAJOR = 115;
const MIN_SAFARI_MAJOR = 16;

describe("isModernUserAgentString", () => {
  test("accepts a current Chrome major", () => {
    expect(
      isModernUserAgentString(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      ),
    ).toBe(true);
  });

  test("rejects a 2017-era Chrome major", () => {
    expect(
      isModernUserAgentString(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.113 Safari/537.36",
      ),
    ).toBe(false);
  });

  test("accepts a current Firefox major", () => {
    expect(
      isModernUserAgentString(
        "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
      ),
    ).toBe(true);
  });

  test("rejects an old Firefox major", () => {
    expect(
      isModernUserAgentString(
        "Mozilla/5.0 (X11; Linux x86_64; rv:52.0) Gecko/20100101 Firefox/52.0",
      ),
    ).toBe(false);
  });

  test("accepts a current Safari version (distinct from the WebKit build number)", () => {
    expect(
      isModernUserAgentString(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      ),
    ).toBe(true);
  });

  test("rejects an old Safari version", () => {
    expect(
      isModernUserAgentString(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/603.3.8 (KHTML, like Gecko) Version/10.1.2 Safari/603.3.8",
      ),
    ).toBe(false);
  });

  test("accepts a current Edge major (Chrome-derived UA, gated on the Edg/ token)", () => {
    expect(
      isModernUserAgentString(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      ),
    ).toBe(true);
  });

  test("rejects an old Edge major even though its embedded Chrome token is modern", () => {
    // Edge's own version can trail the Chromium version it's built on; gate on Edg/ first.
    expect(
      isModernUserAgentString(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/90.0.818.42",
      ),
    ).toBe(false);
  });

  test("accepts iOS Chrome (CriOS/) and rejects an old one despite a Safari Version/ token", () => {
    const modern =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.6422.80 Mobile/15E148 Safari/604.1";
    const old =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/70.0.3538.75 Mobile/15E148 Safari/604.1";
    expect(isModernUserAgentString(modern)).toBe(true);
    expect(isModernUserAgentString(old)).toBe(false);
  });

  test("accepts iOS Firefox (FxiOS/) and rejects an old one", () => {
    const modern =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/126.0 Mobile/15E148 Safari/605.1.15";
    const old =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/15.4 Mobile/15E148 Safari/605.1.15";
    expect(isModernUserAgentString(modern)).toBe(true);
    expect(isModernUserAgentString(old)).toBe(false);
  });

  test("accepts Edge Android (EdgA/) and iOS (EdgiOS/) variants on their own version, not the co-located Chrome/Safari token", () => {
    const modernEdgA =
      "Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.2210.126";
    const oldEdgA =
      "Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/45.0.2.5130";
    const modernEdgiOS =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/131.0.2210.126 Mobile/15E148 Safari/604.1";
    const oldEdgiOS =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 EdgiOS/42.0.2.5130 Mobile/15E148 Safari/604.1";
    expect(isModernUserAgentString(modernEdgA)).toBe(true);
    expect(isModernUserAgentString(oldEdgA)).toBe(false);
    expect(isModernUserAgentString(modernEdgiOS)).toBe(true);
    expect(isModernUserAgentString(oldEdgiOS)).toBe(false);
  });

  test("rejects unparseable strings", () => {
    expect(isModernUserAgentString("")).toBe(false);
    expect(isModernUserAgentString("SomeBot/1.0")).toBe(false);
  });
});

// Independent re-parse of a drawn UA string, written separately from
// isModernUserAgentString so this test doesn't just tautologically re-check
// the function under test against its own output.
const MIN_EDGE_MAJOR = 120;
function independentlyParsedMajor(ua: string): { family: string; major: number } {
  const edge = ua.match(/Edg(?:A|iOS)?\/(\d+)/);
  if (edge) return { family: "Edge", major: Number(edge[1]) };
  const chrome = ua.match(/(?:Chrome|CriOS)\/(\d+)/);
  if (chrome) return { family: "Chrome", major: Number(chrome[1]) };
  const firefox = ua.match(/(?:Firefox|FxiOS)\/(\d+)/);
  if (firefox) return { family: "Firefox", major: Number(firefox[1]) };
  const safari = ua.match(/Version\/(\d+).*Safari\//);
  if (safari) return { family: "Safari", major: Number(safari[1]) };
  throw new Error(`draw did not match any known browser signature: ${ua}`);
}

describe("FALLBACK_USER_AGENT", () => {
  // Guards against the fallback silently drifting stale: if a future
  // maintenance pass bumps the MIN_*_MAJOR thresholds without updating the
  // hardcoded fallback string, this fails loudly.
  test("fallback itself passes the modern-browser filter", () => {
    expect(isModernUserAgentString(FALLBACK_USER_AGENT)).toBe(true);
  });
});

describe("getRandomUserAgent", () => {
  test("100 draws are all non-empty strings identifying a modern browser", () => {
    for (let i = 0; i < 100; i++) {
      const ua = getRandomUserAgent();
      expect(typeof ua).toBe("string");
      expect(ua.length).toBeGreaterThan(10);

      // Every draw must match a modern-browser signature, unless it's the
      // hardcoded fallback (used only if the filtered pool fails).
      if (ua === FALLBACK_USER_AGENT) continue;

      const { family, major } = independentlyParsedMajor(ua);
      const minMajor = {
        Edge: MIN_EDGE_MAJOR,
        Chrome: MIN_CHROME_MAJOR,
        Firefox: MIN_FIREFOX_MAJOR,
        Safari: MIN_SAFARI_MAJOR,
      }[family] as number;
      expect(major).toBeGreaterThanOrEqual(minMajor);
    }
  });

  test("returns different values across draws", () => {
    const uas = new Set<string>();
    for (let i = 0; i < 10; i++) {
      uas.add(getRandomUserAgent());
    }
    expect(uas.size).toBeGreaterThan(1);
  });
});

describe("resolveUserAgent", () => {
  test("returns a modern random UA for empty string", () => {
    const ua = resolveUserAgent("");
    expect(ua).not.toBe("");
    expect(isModernUserAgentString(ua) || ua === FALLBACK_USER_AGENT).toBe(true);
  });

  test("returns custom value when provided", () => {
    const custom = "MyBot/1.0";
    expect(resolveUserAgent(custom)).toBe(custom);
  });
});
