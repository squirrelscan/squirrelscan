import { describe, expect, test } from "bun:test";

import { buildReportHost, EDGE_TECHNOLOGY_IDS } from "../src/host-info";

const probe = { host: "example.test", ipv4: ["8.8.8.8"], ipv6: [] as string[] };

describe("buildReportHost country labelling (#10, edge requirement)", () => {
  test("no edge detected: the country is an origin location", async () => {
    const host = await buildReportHost(probe, [{ id: "wordpress" }]);
    expect(host?.country).toMatchObject({ code: "US", location: "origin", address: "8.8.8.8" });
    expect(host?.country?.edge).toBeUndefined();
  });

  for (const [id, name] of Object.entries(EDGE_TECHNOLOGY_IDS)) {
    test(`${id}: the country is an edge location, not the origin's`, async () => {
      const host = await buildReportHost(probe, [{ id: "wordpress" }, { id }]);
      expect(host?.country?.location).toBe("edge");
      expect(host?.country?.edge?.name).toBe(name);
      expect(host?.edge?.name).toBe(name);
      expect(JSON.parse(JSON.stringify(host)).country.location).toBe("edge");
    });
  }

  test("every edge provider the requirement names is covered", () => {
    const names = new Set(Object.values(EDGE_TECHNOLOGY_IDS));
    for (const n of ["Cloudflare", "Amazon CloudFront", "Vercel", "Netlify", "Fastly", "Akamai"]) {
      expect(names.has(n)).toBe(true);
    }
  });

  test("an unrelated CDN fingerprint does not make the country an edge location", async () => {
    const host = await buildReportHost(probe, [{ id: "bunnycdn" }]);
    expect(host?.country?.location).toBe("origin");
  });

  test("the country is omitted, not guessed, when the database has none", async () => {
    const host = await buildReportHost({ host: "lan.test", ipv4: ["10.1.2.3"], ipv6: [] }, []);
    expect(host?.country).toBeUndefined();
    expect(host?.addresses.ipv4).toEqual(["10.1.2.3"]);
  });

  test("IPv6-only hosts are looked up too, and an unresolved host gives no section", async () => {
    const host = await buildReportHost({ host: "v6.test", ipv4: [], ipv6: ["2001:4860:1c00::1"] }, []);
    expect(host?.country?.code).toBe("US");
    expect(await buildReportHost({ host: "x", ipv4: [], ipv6: [] }, [])).toBeUndefined();
  });
});
