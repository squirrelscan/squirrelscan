// #1406: a signed-in audit reports the technologies the free local whole-bundle scan finds as well as
// what the cloud scan found, in one section. The cloud keeps its history; only the local scan's result
// (never its bytes) is merged.

import type { CloudServicesClient } from "@squirrelscan/cloud-client";
import type {
  ReportTechnologies,
  ReportTechnology,
  TechDetectPagePayload,
} from "@squirrelscan/core-contracts";

import { describe, expect, test } from "bun:test";

import type { SiteContextPage } from "../../src/audit/adapter";

import {
  detectLocalTechnologies,
  mergeLocalTechnologies,
  runCloudTechDetect,
} from "../../src/audit/cloud";
import { getDefaultConfig } from "../../src/config";

const BASE = "https://example.com/";
const REF = "abcdefghijklmnopqrst";

const tech = (
  id: string,
  over: Partial<ReportTechnology> = {}
): ReportTechnology => ({
  id,
  name: id,
  category: "framework",
  version: null,
  confidence: "high",
  detectedBy: "test",
  ...over,
});
const section = (
  items: ReportTechnology[],
  over: Partial<ReportTechnologies> = {}
): ReportTechnologies => ({
  items,
  added: [],
  removed: [],
  firstScan: false,
  ...over,
});

describe("mergeLocalTechnologies", () => {
  test("a technology only the local scan found is added, marked local, and has no scan diff", () => {
    const merged = mergeLocalTechnologies(
      section([tech("react")], {
        source: "cloud",
        added: ["react"],
        removed: ["jquery"],
        firstScan: false,
        scannedAt: "2026-01-01T00:00:00Z",
      }),
      section([tech("react"), tech("svelte")], { source: "local" })
    );
    expect(merged.items.map((t) => [t.id, t.origin])).toEqual([
      ["react", undefined],
      ["svelte", "local"],
    ]);
    expect(merged).toMatchObject({
      source: "cloud",
      added: ["react"],
      removed: ["jquery"],
      firstScan: false,
      scannedAt: "2026-01-01T00:00:00Z",
    });
    expect(merged.added).not.toContain("svelte");
  });

  test("a version the cloud scan lacked is filled in from the local scan; the cloud's own wins", () => {
    const merged = mergeLocalTechnologies(
      section([tech("vue"), tech("react", { version: "18.2.0" })], {
        source: "cloud",
      }),
      section(
        [
          tech("vue", { version: "3.4.1" }),
          tech("react", { version: "17.0.0" }),
        ],
        { source: "local" }
      )
    );
    expect(
      Object.fromEntries(merged.items.map((t) => [t.id, t.version]))
    ).toEqual({ vue: "3.4.1", react: "18.2.0" });
  });

  test("the cloud payload's cut stops being a limit once the local scan read the bundles; the local scan's own cut is reported", () => {
    const cut = { reasons: ["bundle-bytes" as const], scripts: 3 };
    const read = mergeLocalTechnologies(
      section([tech("react")], { source: "cloud", truncated: cut }),
      section([], { source: "local" })
    );
    expect(read.truncated).toBeUndefined();
    const localCut = { reasons: ["time-budget" as const], scripts: 1 };
    const stillCut = mergeLocalTechnologies(
      section([tech("react")], { source: "cloud", truncated: cut }),
      section([], { source: "local", truncated: localCut })
    );
    expect(stillCut.truncated).toEqual(localCut);
  });

  test("with no local result the cloud section is returned as it was, cut included", () => {
    const cloud = section([tech("react")], {
      source: "cloud",
      truncated: { reasons: ["bundle-bytes"], scripts: 1 },
    });
    expect(mergeLocalTechnologies(cloud, null)).toBe(cloud);
  });
});

describe("a bundle past the cloud payload cap, on a signed-in audit with the cloud client stubbed", () => {
  const page = (url: string, html: string): SiteContextPage =>
    ({
      page: {
        url,
        finalUrl: url,
        status: 200,
        html,
        headers: {},
        securityHeaders: {},
      },
      parsed: null,
    }) as unknown as SiteContextPage;
  const siteContext = [
    page(
      BASE,
      `<html><body><div id="root"></div><script src="/assets/index.js"></script></body></html>`
    ),
  ];
  // The fingerprint sits 400 KB into an 800 KB bundle, past the 64 KB the cloud payload carries (head and tail).
  const marker = `const sb=createClient("https://${REF}.supabase.co","k");`;
  const scripts = [
    {
      url: `${BASE}assets/index.js`,
      content: `${"/* pad */ ".repeat(40_000)}${marker}${"/* pad */ ".repeat(40_000)}`,
      sourcePages: [BASE],
    },
  ];

  test("the local scan finds it, the merged section lists it beside the cloud's, and the bytes are not sent", async () => {
    let sent: TechDetectPagePayload[] = [];
    const client = {
      detectTechnologies: async (req: { pages: TechDetectPagePayload[] }) => {
        sent = req.pages;
        return {
          technologies: [tech("react")],
          added: ["react"],
          removed: [],
          firstScan: false,
        };
      },
    } as unknown as CloudServicesClient;
    const config = getDefaultConfig();
    const cloud = await runCloudTechDetect({
      client,
      config,
      auditId: "a1",
      baseUrl: BASE,
      siteContext,
      scripts,
    });
    expect(cloud).not.toBeNull();
    // The payload carries the bundle cut to the caps, not the 800 KB body: the local scan's bytes stay here.
    const sentBundleBytes = sent
      .flatMap((p) => p.scripts ?? [])
      .reduce((sum, script) => sum + (script.content?.length ?? 0), 0);
    expect(sentBundleBytes).toBeGreaterThan(0);
    expect(sentBundleBytes).toBeLessThan(200_000);
    expect(cloud!.technologies.truncated?.reasons).toContain("bundle-bytes");

    const local = detectLocalTechnologies({
      baseUrl: BASE,
      siteContext,
      scripts,
      keepEmpty: true,
    });
    const merged = mergeLocalTechnologies(cloud!.technologies, local);
    const supabase = merged.items.find((t) => t.id === "supabase");
    expect(supabase?.origin).toBe("local");
    expect(
      merged.items.some((t) => t.id === "react" && t.origin === undefined)
    ).toBe(true);
    expect(merged.added).toEqual(["react"]);
    // The local scan read the bundle whole, so the payload's cut is no longer a limit.
    expect(merged.truncated).toBeUndefined();
    expect(merged.source).toBe("cloud");
  });
});
