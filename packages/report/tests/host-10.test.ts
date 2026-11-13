// Host section (#10): addresses, GeoIP country, connect time in every format, and the edge label.
import { describe, expect, test } from "bun:test";

import type { ReportHost } from "@squirrelscan/core-contracts";

import { hostRows } from "../src/host";
import { renderJson } from "../src/output/json";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";

const origin: ReportHost = {
  host: "example.test",
  addresses: { ipv4: ["8.8.8.8"], ipv6: ["2001:4860:1c00::1"] },
  country: { code: "US", name: "United States", location: "origin", address: "8.8.8.8" },
  latency: { ms: 12, measure: "tcp-connect", address: "8.8.8.8", port: 443 },
  geoipSnapshot: "2026-11",
};
const edge: ReportHost = {
  ...origin,
  country: { ...origin.country!, location: "edge", edge: { id: "cloudflare-cdn", name: "Cloudflare" } },
};

describe("hostRows", () => {
  test("an origin country is the hosting country", () => {
    const row = hostRows(origin).find((r) => r.key === "country")!;
    expect(row.label).toBe("Hosting country");
    expect(row.value).toBe("United States (US)");
  });
  test("an edge country is labelled edge/anycast and not the origin's (regression)", () => {
    const row = hostRows(edge).find((r) => r.key === "country")!;
    expect(row.label).toBe("Edge location");
    expect(row.value).toContain("edge/anycast");
    expect(row.value).toContain("Cloudflare");
    expect(row.value).toContain("not the origin");
    expect(hostRows(edge).some((r) => r.label === "Hosting country")).toBe(false);
  });
  test("latency says what was measured; no country means no country row", () => {
    const rows = hostRows({ ...origin, country: undefined, geoipSnapshot: undefined });
    expect(rows.find((r) => r.key === "latency")!.value).toContain("TCP connect");
    expect(rows.some((r) => r.key === "country" || r.key === "geoip")).toBe(false);
  });
});

describe("report output", () => {
  const base = {
    baseUrl: "https://example.test",
    timestamp: "2026-11-12T00:00:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
  } as never;
  test("JSON carries the host and the edge location", () => {
    const json = JSON.parse(renderJson({ ...(base as object), host: edge } as never));
    expect(json.host.country.location).toBe("edge");
    expect(json.host.country.edge.name).toBe("Cloudflare");
    expect(json.host.addresses.ipv6).toEqual(["2001:4860:1c00::1"]);
    expect(json.host.latency.measure).toBe("tcp-connect");
  });
  test("JSON omits host when none resolved", () => {
    expect(JSON.parse(renderJson(base)).host).toBeUndefined();
  });
  test("text and markdown say edge, not hosting country", () => {
    const report = { ...(base as object), host: edge } as never;
    expect(renderText(report)).toContain("Edge location");
    expect(renderText(report)).not.toContain("Hosting country");
    expect(renderMarkdown(report)).toContain("Edge location");
  });
});
