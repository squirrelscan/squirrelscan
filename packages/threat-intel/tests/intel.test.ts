// Memoized on-demand lookups + the end-to-end IntelContext built from a prefetch.
// Network is mocked; the key guarantees are: each distinct URL is queried once,
// and lookupUrl answers from BOTH memoized provider verdicts and feed snapshots.

import { describe, expect, test } from "bun:test";

import { buildIntelContext, prefetchIntel } from "../src/intel";
import { runLookups } from "../src/lookups";
import type { IntelConfig, IntelTransport } from "../src/index";

function jsonResponse(body: unknown, ok = true): ReturnType<IntelTransport> {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    json: () => Promise.resolve(body),
  });
}

describe("runLookups — memoized per run", () => {
  const config: IntelConfig = {
    enabled: true,
    feedTtlMs: 1000,
    providers: { "safe-browsing": { apiKey: "k" } },
  };

  test("queries each distinct URL once, even when listed multiple times", async () => {
    const seen: string[] = [];
    const transport: IntelTransport = (url, init) => {
      // Safe Browsing echoes the queried URL from the POST body.
      const body = init?.body ? JSON.parse(init.body) : {};
      const queried = body?.threatInfo?.threatEntries?.[0]?.url ?? url;
      seen.push(queried);
      const malicious = queried.includes("evil");
      return jsonResponse(malicious ? { matches: [{ threatType: "SOCIAL_ENGINEERING" }] } : {});
    };

    const verdicts = await runLookups(
      [
        "https://evil.tk/a",
        "https://evil.tk/a", // dup → not re-queried
        "https://www.evil.tk/a/", // normalizes to the same key → not re-queried
        "https://clean.example/",
      ],
      config,
      { transport },
    );

    // evil.tk/a (one key after normalization) + clean.example = 2 distinct queries
    expect(seen.length).toBe(2);
    expect(verdicts.get("evil.tk/a")?.listed).toBe(true);
    expect(verdicts.get("evil.tk/a")?.sources[0]?.provider).toBe("safe-browsing");
    expect(verdicts.get("clean.example")?.listed).toBe(false);
    expect(verdicts.get("clean.example")?.checked).toBe(true);
  });

  test("no lookup provider enabled → empty verdict map", async () => {
    const verdicts = await runLookups(
      ["https://x.tk/"],
      { enabled: true, feedTtlMs: 1000, providers: {} },
      { transport: () => jsonResponse({}) },
    );
    expect(verdicts.size).toBe(0);
  });
});

describe("buildIntelContext", () => {
  test("signatures-only (no resolved data): lookups are 'unknown', not 'clean'", () => {
    const intel = buildIntelContext();
    expect(intel.signatureCount).toBeGreaterThanOrEqual(1);
    const v = intel.lookupUrl("https://anything.example/");
    expect(v.listed).toBe(false);
    expect(v.checked).toBe(false); // no provider consulted → unknown
    expect(intel.providers).toHaveLength(0);
  });

  test("end-to-end: prefetch feeds + lookups, then lookupUrl answers from both", async () => {
    const config: IntelConfig = {
      enabled: true,
      feedTtlMs: 1000,
      providers: {
        openphish: { enabled: true }, // feed
        virustotal: { apiKey: "k" }, // lookup
      },
    };

    const transport: IntelTransport = (url) => {
      if (url.includes("openphish")) {
        return jsonResponse("https://feedlisted.tk/x"); // text feed
      }
      if (url.includes("virustotal")) {
        return jsonResponse({ data: { attributes: { last_analysis_stats: { malicious: 3 } } } });
      }
      return jsonResponse({});
    };

    const resolved = await prefetchIntel(config, {
      urls: ["https://mysite.example/page"],
      transport,
      now: 0,
    });
    const intel = buildIntelContext({ resolved });

    expect(intel.providers).toContain("openphish");
    expect(intel.providers).toContain("virustotal");

    // Listed by the on-demand VirusTotal lookup (memoized).
    const own = intel.lookupUrl("https://mysite.example/page");
    expect(own.listed).toBe(true);
    expect(own.checked).toBe(true);
    expect(own.sources.some((s) => s.provider === "virustotal")).toBe(true);

    // Listed by the feed snapshot (no per-URL call needed) — covers external links.
    const external = intel.lookupUrl("https://feedlisted.tk/x");
    expect(external.listed).toBe(true);
    expect(external.sources.some((s) => s.provider === "openphish")).toBe(true);

    // Unlisted URL, but feeds present → checked=true (a real "clean" answer).
    const clean = intel.lookupUrl("https://unrelated.example/");
    expect(clean.listed).toBe(false);
    expect(clean.checked).toBe(true);
  });

  test("a 404 from VirusTotal (never scanned) is 'unknown', not 'clean'", async () => {
    const config: IntelConfig = {
      enabled: true,
      feedTtlMs: 1000,
      providers: { virustotal: { apiKey: "k" } },
    };
    const transport: IntelTransport = () => jsonResponse({}, false); // 404/500
    const resolved = await prefetchIntel(config, {
      urls: ["https://x.example/"],
      transport,
      now: 0,
    });
    const intel = buildIntelContext({ resolved });
    const v = intel.lookupUrl("https://x.example/");
    expect(v.listed).toBe(false);
    expect(v.sources).toHaveLength(0);
  });
});
