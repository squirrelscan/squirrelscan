// Feed cache (daily-pull) + snapshot indexing + synchronous membership lookups.
// All network is mocked via an injected transport; the clock is injected so the
// TTL behaviour is deterministic.

import { describe, expect, test } from "bun:test";

import type { IntelConfig, IntelTransport } from "../src/index";

import { MemoryKvStore, getOrRefresh } from "../src/cache";
import { lookupInSnapshot, refreshFeeds } from "../src/feeds";

function jsonResponse(body: unknown): ReturnType<IntelTransport> {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () =>
      Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
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
      () => Promise.reject<string>(new Error("feed down")),
      5000 // expired → would refresh, but refresh throws
    );
    expect(served).toBe("good");
  });

  test("rethrows when nothing is cached and refresh fails", async () => {
    const kv = new MemoryKvStore();
    await expect(
      getOrRefresh(kv, "k", 1000, () => Promise.reject(new Error("boom")), 0)
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
      return jsonResponse(
        "https://evil-collector.tk/grab\nhttps://phish.example/login"
      );
    }
    if (url.includes("threatfox")) {
      return jsonResponse({
        query_status: "ok",
        data: [
          {
            id: "42",
            ioc: "bad-domain.tk",
            ioc_type: "domain",
            threat_type: "phishing",
          },
        ],
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
    const hit = lookupInSnapshot(
      snap,
      "https://www.bad-domain.tk/some/deep/path?x=1"
    );
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
      { transport: t, kv: new MemoryKvStore(), now: 0 }
    );
    // The listed host + its subdomains match.
    expect(
      lookupInSnapshot(snap, "https://phish.shared-host.com/x").length
    ).toBeGreaterThan(0);
    expect(
      lookupInSnapshot(snap, "https://a.phish.shared-host.com/").length
    ).toBeGreaterThan(0);
    // A sibling host on the SAME registrable domain must NOT be flagged.
    expect(lookupInSnapshot(snap, "https://www.shared-host.com/")).toHaveLength(
      0
    );
    expect(
      lookupInSnapshot(snap, "https://other.shared-host.com/")
    ).toHaveLength(0);
  });

  test("URL membership ignores scheme / www / trailing slash / query", async () => {
    const snap = await refreshFeeds(config, {
      transport,
      kv: new MemoryKvStore(),
      now: 0,
    });
    expect(
      lookupInSnapshot(snap, "http://www.phish.example/login/").length
    ).toBeGreaterThan(0);
  });

  test("disabled providers are not pulled", async () => {
    const snap = await refreshFeeds(
      { ...config, providers: {} },
      { transport, kv: new MemoryKvStore(), now: 0 }
    );
    expect(snap.providers).toHaveLength(0);
    expect(
      lookupInSnapshot(snap, "https://evil-collector.tk/grab")
    ).toHaveLength(0);
  });
});

describe("refreshFeeds, failed pulls", () => {
  const failing: IntelTransport = () =>
    Promise.resolve({
      ok: false,
      status: 410,
      text: () => Promise.resolve("gone"),
      json: () => Promise.resolve({}),
    });
  const cfg = (providers: IntelConfig["providers"]): IntelConfig => ({
    enabled: true,
    feedTtlMs: 1000,
    providers,
  });

  test("a failed pull with no cached list is not counted as consulted", async () => {
    const snap = await refreshFeeds(
      cfg({ openphish: { enabled: true }, urlhaus: { apiKey: "k" } }),
      { transport: failing, kv: new MemoryKvStore(), now: 0 }
    );
    expect(snap.providers).toEqual([]);
  });

  test("a failed refresh keeps serving the last good list", async () => {
    const kv = new MemoryKvStore();
    const good: IntelTransport = () =>
      jsonResponse("https://evil-collector.tk/grab");
    const config = cfg({ openphish: { enabled: true } });
    await refreshFeeds(config, { transport: good, kv, now: 0 });
    const snap = await refreshFeeds(config, {
      transport: failing,
      kv,
      now: 5000, // past the TTL, so a refresh is attempted and fails
    });
    expect(snap.providers).toEqual(["openphish"]);
    expect(
      lookupInSnapshot(snap, "https://evil-collector.tk/grab").length
    ).toBeGreaterThan(0);
  });

  test("keyed feeds are skipped without a key, not consulted as empty", async () => {
    let called = false;
    const t: IntelTransport = (...args) => {
      called = true;
      return failing(...args);
    };
    const snap = await refreshFeeds(
      cfg({ phishtank: { enabled: true }, urlhaus: { enabled: true } }),
      { transport: t, kv: new MemoryKvStore(), now: 0 }
    );
    expect(snap.providers).toEqual([]);
    expect(called).toBe(false);
  });

  test("URLhaus CSV export is parsed; offline rows are dropped", async () => {
    const csv = [
      "# id,dateadded,url,url_status,last_online,threat,tags,urlhaus_link,reporter",
      '"1","2026-01-01","https://live.example.com/a.exe","online","","malware_download","","https://urlhaus.abuse.ch/url/1/","r"',
      '"2","2026-01-01","https://dead.example.com/b.exe","offline","","malware_download","","","r"',
    ].join("\n");
    const snap = await refreshFeeds(cfg({ urlhaus: { apiKey: "k" } }), {
      transport: () => jsonResponse(csv),
      kv: new MemoryKvStore(),
      now: 0,
    });
    expect(snap.providers).toEqual(["urlhaus"]);
    expect(
      lookupInSnapshot(snap, "https://live.example.com/a.exe")
    ).toHaveLength(1);
    expect(
      lookupInSnapshot(snap, "https://dead.example.com/b.exe")
    ).toHaveLength(0);
  });

  test("a body that is not the expected format is treated as a failed pull", async () => {
    const snap = await refreshFeeds(cfg({ urlhaus: { apiKey: "k" } }), {
      transport: () => jsonResponse("<html>retired</html>"),
      kv: new MemoryKvStore(),
      now: 0,
    });
    expect(snap.providers).toEqual([]);
  });
});
