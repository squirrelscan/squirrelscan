import type { CloudPrefetchInput } from "@squirrelscan/audit-engine";

// #1841, the CLI half of the render skip. The engine test proves that
// `hostUnreachableByCloud: true` drops the render service before it charges.
// This proves the two CLI seams actually SET it, and set it from the right
// thing — deleting either assignment would otherwise fail no test at all.
//
// "From the right thing" is the load-bearing part. The classification is on the
// audit's BASE url, not on the page payloads: a crawl of http://localhost:3000
// can perfectly well carry page urls that look public (an absolute link, a
// rewritten canonical), and keying off those would put the render service back
// on a site the hosted browser cannot reach.
import { afterAll, describe, expect, mock, test } from "bun:test";

const realEngine = await import("@squirrelscan/audit-engine");

/** Every prefetchCloudData call the seams below made. */
const calls: CloudPrefetchInput[] = [];

// Spread the REAL module: a partial stub leaks process-wide and drops exports
// sibling suites need.
mock.module("@squirrelscan/audit-engine", () => ({
  ...realEngine,
  prefetchCloudData: async (input: CloudPrefetchInput) => {
    calls.push(input);
    return { store: new Map(), spend: [], totalSpent: 0, failures: [] };
  },
}));

const { runCloudPrefetch, runCloudPrefetchFromPayloads } =
  await import("@/audit/cloud");

afterAll(() => {
  mock.restore();
});

const cloudConfig = {
  enabled: true,
  batch_size: 20,
  confirm_threshold: 0,
  max_credits_per_audit: 0,
} as never;

/** Only the fields these seams read: the rule filter and its options. */
const config = {
  rules: { enable: [], disable: [] },
  rule_options: {},
} as never;

/** Page payloads on a PUBLIC host, to prove the base is what decides. */
const publicPages = [
  { url: "https://cdn.example.com/a", html: "<html></html>" },
  { url: "https://cdn.example.com/b", html: "<html></html>" },
] as never;

function payloadsWith(pages: unknown) {
  return {
    pages,
    metadataPages: [],
    blocklist: null,
    gapsSeeds: [],
    renderedPageUrls: new Set<string>(),
  } as never;
}

async function runPayloadSeam(baseUrl: string) {
  calls.length = 0;
  await runCloudPrefetchFromPayloads(
    {
      client: {} as never,
      cloudConfig,
      config,
      baseUrl,
      auditId: "audit-1",
    } as never,
    payloadsWith(publicPages)
  );
  return calls[0]!;
}

async function runSiteContextSeam(baseUrl: string) {
  calls.length = 0;
  await runCloudPrefetch({
    client: {} as never,
    cloudConfig,
    config,
    siteContext: [],
    baseUrl,
    auditId: "audit-1",
  } as never);
  return calls[0]!;
}

const seams: Array<[string, (baseUrl: string) => Promise<CloudPrefetchInput>]> =
  [
    ["runCloudPrefetchFromPayloads", runPayloadSeam],
    ["runCloudPrefetch", runSiteContextSeam],
  ];

describe.each(seams)("%s", (_name, run) => {
  test.each([
    ["http://localhost:3000"],
    ["http://127.0.0.1:4321/"],
    ["http://192.168.1.10:8000/"],
    ["http://box.local/"],
    ["http://intranet/"],
  ])(
    "a %s base marks the host unreachable, whatever the pages say",
    async (baseUrl) => {
      const input = await run(baseUrl);
      expect(input.hostUnreachableByCloud).toBe(true);
      expect(input.siteUrl).toBe(baseUrl);
    }
  );

  test("a public base leaves it false, so render runs exactly as before", async () => {
    const input = await run("https://example.com");
    expect(input.hostUnreachableByCloud).toBe(false);
  });

  // The flag must be NARROW: it is the only thing about the request that a
  // private base changes. Everything else works from pages the CLI already
  // crawled and does not care where the site lives, so a local audit keeps its
  // AI summary, tech detection and the rest. Asserted as an equality against
  // the public run rather than a count, so it holds whatever the rule set is.
  test("nothing else about the request changes for a private base", async () => {
    const priv = await run("http://localhost:3000");
    const pub = await run("https://example.com");
    expect(priv.rules).toEqual(pub.rules);
    expect(priv.metadataPages).toEqual(pub.metadataPages);
    expect(priv.pages).toEqual(pub.pages);
    // The site payloads legitimately differ: archive-indexing is handed the
    // base url, which is the thing that changed. Compare their SHAPE.
    expect(Object.keys(priv.sitePayloads ?? {})).toEqual(
      Object.keys(pub.sitePayloads ?? {})
    );
    // The ONE difference.
    expect(priv.hostUnreachableByCloud).toBe(true);
    expect(pub.hostUnreachableByCloud).toBe(false);
  });
});

describe("runCloudPrefetchFromPayloads", () => {
  test("public page payloads are passed through untouched", async () => {
    const input = await runPayloadSeam("http://localhost:3000");
    expect(input.pages).toHaveLength(2);
    expect(input.pages[0]!.url).toBe("https://cdn.example.com/a");
  });
});
