// #1807: edge detection from headers, published IP ranges and ASN, and the origin kept apart. Synthetic
// header and IP fixtures only (the IPs are taken from the bundled provider range files).
import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "@squirrelscan/tech-detect";
import { EDGE_ASN_PROVIDERS, EDGE_RANGE_PROVIDERS, matchEdgeAsn, matchEdgeRanges } from "@squirrelscan/utils/geoip/edge";

import { buildReportHost, detectEdge } from "../src/host-info";

const techs = (headers: Record<string, string>, url = "https://example.test/") =>
  detectTechnologies({ url, headers, html: "<html><body>x</body></html>" }).map((t) => ({
    id: t.id,
    name: t.name,
    category: t.category,
    detectedBy: t.detectedBy,
  }));

const HEADER_CASES: Array<[string, Record<string, string>]> = [
  ["cloudflare", { "cf-ray": "8a1b2c3d4e5f-SYD" }],
  ["cloudfront", { "x-amz-cf-id": "abc123", "x-amz-cf-pop": "SYD62-C1" }],
  ["fastly", { "x-fastly-request-id": "0123abcd" }],
  ["akamai", { "x-akamai-transformed": "9 - 0 pmb=mRUM,1" }],
  ["vercel", { "x-vercel-id": "syd1::abcde-1" }],
  ["netlify", { "x-nf-request-id": "01HXYZ" }],
  ["azure-front-door", { "x-azure-ref": "0abcdefg" }],
];

describe("header source", () => {
  for (const [id, headers] of HEADER_CASES) {
    test(`${id} is found from its headers alone`, () => {
      const edge = detectEdge([], techs(headers));
      expect(edge?.id).toBe(id);
      expect(edge?.source).toBe("header");
      expect(edge?.matched).toEqual(["header"]);
    });
  }

  test("lookalike header names are not an edge", () => {
    const lookalikes = {
      "cf-rays": "x",
      "x-amz-cf-identity": "x",
      "x-fastly-requests": "x",
      "x-vercel-identifier": "x",
      "x-nf-requests": "x",
      "x-azure-reference": "x",
    };
    expect(detectEdge([], techs(lookalikes))).toBeNull();
  });

  test("an edge named only by page HTML is not a header match", () => {
    const edge = detectEdge([], [{ id: "cloudfront", detectedBy: "html:cloudfront\\.net" }]);
    expect(edge).toBeNull();
  });
});

describe("ip-range source", () => {
  const IN: Array<[string, string]> = [
    ["cloudflare", "173.245.48.1"],
    ["cloudflare", "2400:cb00::1"],
    ["cloudfront", "23.228.249.5"],
    ["fastly", "151.101.1.1"],
    ["azure-front-door", "4.145.22.161"],
    ["google-cloud", "34.35.1.1"],
  ];
  const OUT: string[] = ["173.245.64.1", "151.102.1.1", "4.145.22.168", "8.8.8.8", "93.184.216.34", "2001:db8::1"];

  for (const [id, ip] of IN) {
    test(`${ip} is in the ${id} ranges alone`, () => {
      const edge = detectEdge([ip], []);
      expect(edge?.id).toBe(id);
      expect(edge?.source).toBe("ip-range");
      expect(edge?.address).toBe(ip);
    });
  }
  for (const ip of OUT) {
    test(`${ip} is just outside every range`, () => {
      expect(matchEdgeRanges(ip)).toEqual([]);
    });
  }
  test("an IPv4-mapped IPv6 address is the IPv4 address", () => {
    expect(matchEdgeRanges("::ffff:151.101.1.1").map((m) => m.provider)).toEqual(["fastly"]);
  });
  test("a range list that covers a whole cloud is marked broad and ranks last", () => {
    expect(detectEdge(["34.35.1.1"], [])?.broad).toBe(true);
    expect(detectEdge(["34.35.1.1", "151.101.1.1"], [])?.id).toBe("fastly");
  });
  test("a Cloudflare address matches only Cloudflare", () => {
    expect(matchEdgeRanges("173.245.48.1").map((m) => m.provider)).toEqual(["cloudflare"]);
  });
});

describe("asn source", () => {
  const IN: Array<[string, string]> = [
    ["cloudflare", "1.1.1.1"],
    ["akamai", "2.16.0.1"],
    ["fastly", "23.154.64.1"],
    ["vercel", "143.13.0.1"],
  ];
  for (const [id, ip] of IN) {
    test(`${ip} is found by ASN alone as ${id}`, () => {
      const edge = detectEdge([ip], []);
      expect(edge?.id).toBe(id);
      expect(edge?.source).toBe("asn");
      expect(edge?.asn).toBeGreaterThan(0);
    });
  }
  test("an address outside the edge ASNs, and shared cloud ASNs, are not an edge", () => {
    expect(matchEdgeAsn("8.8.8.8")).toBeNull();
    // 54.239.0.1 is Amazon (AS16509), a shared cloud ASN that is deliberately not an edge ASN
    expect(matchEdgeAsn("54.239.0.1")).toBeNull();
  });
});

describe("combined sources and origin", () => {
  test("every source that agrees is recorded, strongest first", () => {
    const edge = detectEdge(["173.245.48.1"], techs({ "cf-ray": "x-SYD" }));
    expect(edge?.source).toBe("header");
    expect(edge?.matched).toEqual(["header", "ip-range"]);
  });
  test("a disagreeing source is kept as alsoMatched, not merged", () => {
    const edge = detectEdge(["151.101.1.1"], techs({ "cf-ray": "x-SYD" }));
    expect(edge?.id).toBe("cloudflare");
    expect(edge?.alsoMatched).toEqual([{ id: "fastly", name: "Fastly", source: "ip-range" }]);
  });
  test("an origin behind an edge is reported separately", () => {
    const edge = detectEdge(
      [],
      [
        { id: "cloudflare-cdn", name: "Cloudflare", category: "cdn", detectedBy: "header:cf-ray" },
        { id: "heroku", name: "Heroku", category: "hosting", detectedBy: "header:via" },
      ],
    );
    expect(edge?.id).toBe("cloudflare");
    expect(edge?.edgeHosted).toBe(false);
    expect(edge?.origin).toEqual({ status: "identified", id: "heroku", name: "Heroku" });
  });
  test("no identifiable origin is unknown, never the edge", () => {
    const edge = detectEdge([], techs({ "cf-ray": "x-SYD" }));
    expect(edge?.origin).toEqual({ status: "unknown" });
  });
  test("Vercel, Netlify and Cloudflare Pages are edge hosted with no separate origin", () => {
    for (const t of [
      { id: "vercel", detectedBy: "header:x-vercel-id" },
      { id: "netlify", detectedBy: "header:x-nf-request-id" },
    ]) {
      const e = detectEdge([], [t, { id: "heroku", category: "hosting" as const }]);
      expect(e?.edgeHosted).toBe(true);
      expect(e?.origin).toEqual({ status: "edge-hosted" });
    }
    const pages = detectEdge(
      [],
      [
        { id: "cloudflare-cdn", detectedBy: "header:cf-ray" },
        { id: "cloudflare-pages", detectedBy: "html:\\.pages\\.dev" },
      ],
    );
    expect(pages?.id).toBe("cloudflare");
    expect(pages?.edgeHosted).toBe(true);
  });
  test("a Cloudflare IP alone is not Pages: edge hosted stays false", () => {
    expect(detectEdge(["173.245.48.1"], [])?.edgeHosted).toBe(false);
  });
  test("no edge: nothing is reported and the country stays an origin location", async () => {
    expect(detectEdge(["8.8.8.8"], [{ id: "wordpress" }])).toBeNull();
    const host = await buildReportHost({ host: "x.test", ipv4: ["8.8.8.8"], ipv6: [] }, [{ id: "wordpress" }]);
    expect(host?.edge).toBeUndefined();
    expect(host?.country?.location).toBe("origin");
  });
  test("an edge found only from an IP labels the country as the edge's", async () => {
    const host = await buildReportHost({ host: "x.test", ipv4: ["151.101.1.1"], ipv6: [] }, []);
    expect(host?.edge?.id).toBe("fastly");
    expect(host?.country?.location).toBe("edge");
    expect(JSON.parse(JSON.stringify(host)).edge.origin).toEqual({ status: "unknown" });
  });
});

describe("bundled data", () => {
  test("the range file covers every provider with a published list", () => {
    for (const id of ["cloudflare", "cloudfront", "fastly", "azure-front-door", "google-cloud"]) {
      expect(EDGE_RANGE_PROVIDERS).toContain(id);
    }
  });
  test("the ASN file covers the providers with edge-specific ASNs", () => {
    for (const id of ["cloudflare", "fastly", "akamai", "vercel"]) expect(EDGE_ASN_PROVIDERS).toContain(id);
  });
});

describe("refresh record", () => {
  test("SNAPSHOT.json records the fetch date and a sha256 for every file fetched", async () => {
    const snap = (await Bun.file(new URL("../../utils/geoip-db/SNAPSHOT.json", import.meta.url)).json()) as any;
    expect(snap.edge.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snap.edge.asn.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.edge.asn.license).toBe("CC-BY-4.0");
    const urls = snap.edge.rangeSources.map((s: any) => s.url);
    for (const u of ["cloudflare.com/ips-v4", "cloudflare.com/ips-v6", "ip-ranges.amazonaws.com", "api.fastly.com/public-ip-list", "gstatic.com/ipranges/cloud.json", "ServiceTags_Public"]) {
      expect(urls.some((x: string) => x.includes(u))).toBe(true);
    }
    for (const s of snap.edge.rangeSources) expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
