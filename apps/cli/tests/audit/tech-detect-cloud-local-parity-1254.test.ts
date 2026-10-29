// #1254: the cloud call and the local scan build their pages through one
// function, so a signed-in audit and a signed-out one read the same bytes. The
// cloud service runs the same package over the payload, so what that payload
// detects must equal what the local scan reports for the same crawl.

import type { CloudServicesClient } from "@squirrelscan/cloud-client";
import type { TechDetectPagePayload } from "@squirrelscan/core-contracts";

import { detectReportTechnologiesMulti } from "@squirrelscan/audit-engine";
import { describe, expect, test } from "bun:test";

import type { SiteContextPage } from "../../src/audit/adapter";

import {
  detectLocalTechnologies,
  runCloudTechDetect,
} from "../../src/audit/cloud";
import { getDefaultConfig } from "../../src/config";

const REF = "abcdefghijklmnopqrst";
const BASE = "https://example.com/";

function crawled(url: string, html: string): SiteContextPage {
  return {
    page: {
      url,
      finalUrl: url,
      status: 200,
      html,
      headers: {},
      securityHeaders: {},
    },
    parsed: null,
  } as unknown as SiteContextPage;
}

const siteContext = [
  crawled(
    BASE,
    `<html><body><div id="root"></div><script src="/assets/index-1.js"></script></body></html>`
  ),
  crawled(
    `${BASE}app`,
    `<html><body><script src="/assets/chunk-2.js"></script></body></html>`
  ),
];
const scripts = [
  {
    url: `${BASE}assets/index-1.js`,
    content: `const sb=createClient("https://${REF}.supabase.co","k");`,
    sourcePages: [BASE],
  },
  {
    url: `${BASE}assets/chunk-2.js`,
    content: `initializeApp({authDomain:"demo-app.firebaseapp.com"})`,
    sourcePages: [`${BASE}app`],
  },
];

describe("cloud payload and local scan agree on the same crawl", () => {
  test("same technologies, bundle bodies in the payload, one page carrying each body", async () => {
    let sent: TechDetectPagePayload[] = [];
    const client = {
      detectTechnologies: async (req: { pages: TechDetectPagePayload[] }) => {
        sent = req.pages;
        return { technologies: [], added: [], removed: [], firstScan: true };
      },
    } as unknown as CloudServicesClient;

    const config = getDefaultConfig();
    await runCloudTechDetect({
      client,
      config,
      auditId: "a1",
      baseUrl: BASE,
      siteContext,
      scripts,
    });
    expect(sent.map((p) => p.url)).toEqual([BASE, `${BASE}app`]);
    expect(
      sent[0]?.scripts?.some((s) =>
        s.content?.startsWith("const sb=createClient(")
      )
    ).toBe(true);
    expect(
      sent[1]?.scripts?.some((s) => s.content?.startsWith("initializeApp("))
    ).toBe(true);

    const cloudIds = new Set(
      detectReportTechnologiesMulti(
        sent.map((page) => ({ ...page, headers: page.headers ?? {} }))
      ).items.map((t) => t.id)
    );
    const local = detectLocalTechnologies({
      baseUrl: BASE,
      siteContext,
      scripts,
    });
    const localIds = new Set(local?.items.map((t) => t.id));
    expect(localIds).toEqual(cloudIds);
    expect(localIds.has("supabase")).toBe(true);
    expect(localIds.has("firebase")).toBe(true);
  });
});
