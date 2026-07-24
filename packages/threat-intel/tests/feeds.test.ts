// Feed cache (daily-pull) + snapshot indexing + synchronous membership lookups.
// All network is mocked via an injected transport; the clock is injected so the
// TTL behaviour is deterministic.

import { describe, expect, test } from "bun:test";

import { MemoryKvStore, getOrRefresh } from "../src/cache";
import { lookupInSnapshot, refreshFeeds } from "../src/feeds";
import type { IntelConfig, IntelTransport } from "../src/index";

function jsonResponse(body: unknown): ReturnType<IntelTransport> {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    json: () => Promise.resolve(body),
  });
}

describe("getOrRefresh — daily-pull cache", () => {
  test("caches within TTL, refreshes after it expires", async () => {
    const kv = new MemoryKvStore();
    let calls = 0;
    const refresh = () => {
      calls++;
      return Promise.resolve(`v${calls}`);
    };
    const ttl = 1000;

    expect(await getOrRefresh(kv, "k", ttl, refresh, 0)).toBe("v1");
    expect(await getOrRefresh(kv, "k", ttl, refresh, 500)).toBe("v1"); // cached
    expect(calls).toBe(1);
    expect(await getOrRefresh(kv, "k", ttl, refresh, 1500)).toBe("v2"); // expired
    expect(calls).toBe(2);
  });

  test("serves stale data when a refresh throws (feed down ≠ blank list)", async () => {
    const kv = new MemoryKvStore();
    await getOrRefresh(kv, "k", 1000, () => Promise.resolve("good"), 0);
    const served = await getOrRefresh(
      kv,
      "k",
      1000,
      () => Promise.reject(new Error("feed down")),
      5000, // expired → would refresh, but refresh throws
    );
    expect(served).toBe("good");
  });

  test("rethrows when nothing is cached and refresh fails", async () => {
    const kv = new MemoryKvStore();
    await expect(
      getOrRefresh(kv, "k", 1000, () => Promise.reject(new Error("boom")), 0),
    ).rejects.toThrow("boom");
  });
});

describe("refreshFeeds + lookupInSnapshot", () => {
  const config: IntelConfig = {
    enabled: true,
    feedTtlMs: 24 * 60 * 60 * 1000,
    providers: {
      openphish: { enabled: true },
      threatfox: { enabled: true },
    },
  };

  // Mock transport: OpenPhish returns a URL list, ThreatFox returns a domain IOC.
  const transport: IntelTransport = (url) => {
    if (url.includes("openphish")) {
      return jsonResponse("https://evil-collector.tk/grab\nhttps://phish.example/login");
    }
    if (url.includes("threatfox")) {
      return jsonResponse({
        query_status: "ok",
        data: [{ id: "42", ioc: "bad-domain.tk", ioc_type: "domain", threat_type: "phishing" }],
      });
    }
    return jsonResponse({});
  };

  test("indexes URL feeds and answers exact-URL membership", async () => {
    const snap = await refreshFeeds(config, {
      transport,
      kv: new MemoryKvStore(),
      now: 0,
    });
    expect(snap.providers).toContain("openphish");
    const hit = lookupInSnapshot(snap, "https://evil-collector.tk/grab");
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0]?.provider).toBe("openphish");
    expect(lookupInSnapshot(snap, "https://clean.example/")).toHaveLength(0);
  });

  test("a domain IOC flags every URL under that registrable domain", async () => {
    const snap = await refreshFeeds(config, {
      transport,
      kv: new MemoryKvStore(),
      now: 0,
    });
    const hit = lookupInSnapshot(snap, "https://www.bad-domain.tk/some/deep/path?x=1");
    expect(hit.some((s) => s.provider === "threatfox")).toBe(true);
  });

  test("a sub-host domain IOC flags subdomains but NOT sibling hosts", async () => {
    // ThreatFox lists a specific host on shared infra; siblings must be spared.
    const t: IntelTransport = (url) =>
      url.includes("threatfox")
        ? jsonResponse({
            query_status: "ok",
            data: [
              {
                id: "1",
                ioc: "phish.shared-host.com",
                ioc_type: "domain",
                threat_type: "phishing",
              },
            ],
          })
        : jsonResponse("");
    const snap = await refreshFeeds(
      { ...config, providers: { threatfox: { enabled: true } } },
      { transport: t, kv: new MemoryKvStore(), now: 0 },
    );
    // The listed host + its subdomains match.
    expect(lookupInSnapshot(snap, "https://phish.shared-host.com/x").length).toBeGreaterThan(0);
    expect(lookupInSnapshot(snap, "https://a.phish.shared-host.com/").length).toBeGreaterThan(0);
    // A sibling host on the SAME registrable domain must NOT be flagged.
    expect(lookupInSnapshot(snap, "https://www.shared-host.com/")).toHaveLength(0);
    expect(lookupInSnapshot(snap, "https://other.shared-host.com/")).toHaveLength(0);
  });

  test("URL membership ignores scheme / www / trailing slash / query", async () => {
    const snap = await refreshFeeds(config, {
      transport,
      kv: new MemoryKvStore(),
      now: 0,
    });
    expect(lookupInSnapshot(snap, "http://www.phish.example/login/").length).toBeGreaterThan(0);
  });

  test("disabled providers are not pulled", async () => {
    const snap = await refreshFeeds(
      { ...config, providers: {} },
      { transport, kv: new MemoryKvStore(), now: 0 },
    );
    expect(snap.providers).toHaveLength(0);
    expect(lookupInSnapshot(snap, "https://evil-collector.tk/grab")).toHaveLength(0);
  });
});
