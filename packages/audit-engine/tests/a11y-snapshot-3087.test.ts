// repo#3087: the render service's per-page accessibility snapshot, end to end with a fake client (no network).

import { describe, expect, test } from "bun:test";

import { CloudClientError, type CloudServicesClient } from "@squirrelscan/cloud-client";
import type { CloudConfig } from "@squirrelscan/config";
import {
  A11Y_SNAPSHOT_LIMITS,
  type A11ySnapshot,
  type CloudPagePayload,
  type RenderRequest,
} from "@squirrelscan/core-contracts";
import { humanizeCloudSkip, readA11ySnapshot } from "@squirrelscan/rules";

import { type CloudPrefetchInput, prefetchCloudData } from "../src/cloud-prefetch";

const BALANCE = {
  balance: { monthly: 0, pack: 1000, total: 1000, periodEnd: null },
  plan: {} as never,
  pricing: {} as never,
  pricingVersion: 1,
};
const config = {
  enabled: true,
  max_credits_per_audit: 0,
  confirm_threshold: 1_000_000,
  batch_size: 10,
} as unknown as CloudConfig;
const URL_A = "https://example.com/a";
const URL_B = "https://example.com/b";
const pages: CloudPagePayload[] = [URL_A, URL_B].map((url) => ({ url, textExcerpt: "x" }));

const RULES: CloudPrefetchInput["rules"] = [
  {
    id: "a11y/color-contrast",
    cloud: { service: "render", unit: "page", creditFeature: "audit_page", a11ySnapshot: true },
  },
];

/** Fixture page: one low-contrast paragraph, a button, a link, two boxes. */
const FIXTURE: A11ySnapshot = {
  textNodes: [
    {
      selector: "p.lead",
      text: "Hello",
      color: "rgb(119, 119, 119)",
      backgroundColor: "rgb(255, 255, 255)",
    },
  ],
  interactive: [
    { selector: "button#go", role: "button", name: "Go" },
    { selector: "a.more", role: "link", name: "" },
  ],
  tabOrder: ["button#go", "a.more"],
  boxes: [
    { selector: "button#go", x: 0, y: 10, width: 80, height: 32 },
    { selector: "a.more", x: 0, y: 50, width: 40, height: 16 },
  ],
  truncated: false,
};

function fakeClient(
  snapshotFor: (url: string) => A11ySnapshot | undefined,
  requests: RenderRequest[],
): CloudServicesClient {
  return {
    getBalance: async () => BALANCE,
    render: async (req: RenderRequest) => {
      requests.push(req);
      return { jobId: "job-1", status: "queued", charged: req.urls.length };
    },
    renderResult: async () => ({
      jobId: "job-1",
      status: "done",
      results: requests[0]!.urls.map((url) => ({
        url,
        status: 200,
        html: "<html></html>",
        a11ySnapshot: snapshotFor(url),
      })),
    }),
  } as unknown as CloudServicesClient;
}

const base = (client: CloudServicesClient | null): CloudPrefetchInput => ({
  client,
  config,
  rules: RULES,
  pages,
  siteUrl: "https://example.com",
  auditId: "audit-3087",
});

describe("a11y snapshot prefetch (repo#3087)", () => {
  test("returns colours, role and name, tab order and boxes per page, and asks for the snapshot", async () => {
    const requests: RenderRequest[] = [];
    const res = await prefetchCloudData(base(fakeClient(() => FIXTURE, requests)));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.a11ySnapshot).toBe(true);
    const read = readA11ySnapshot(res.store, URL_A);
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.truncated).toBe(false);
    expect(read.snapshot.textNodes[0]).toMatchObject({
      color: "rgb(119, 119, 119)",
      backgroundColor: "rgb(255, 255, 255)",
    });
    expect(read.snapshot.interactive.map((i) => [i.role, i.name])).toEqual([
      ["button", "Go"],
      ["link", ""],
    ]);
    expect(read.snapshot.tabOrder).toEqual(["button#go", "a.more"]);
    expect(read.snapshot.boxes).toHaveLength(2);
  });

  test("credits are the render debit: counted in totalSpent and the spend ledger", async () => {
    const res = await prefetchCloudData(base(fakeClient(() => FIXTURE, [])));
    expect(res.totalSpent).toBeGreaterThan(0);
    expect(res.spend.some((l) => l.service === "render")).toBe(true);
  });

  test("a rendered crawl still renders for a snapshot rule", async () => {
    const requests: RenderRequest[] = [];
    await prefetchCloudData({ ...base(fakeClient(() => FIXTURE, requests)), crawlRendered: true });
    expect(requests).toHaveLength(1);
  });

  test("a page the service returned without a snapshot is render-failed", async () => {
    const res = await prefetchCloudData(
      base(fakeClient((u) => (u === URL_A ? FIXTURE : undefined), [])),
    );
    expect(readA11ySnapshot(res.store, URL_B)).toEqual({
      status: "skipped",
      skipReason: "render-failed",
    });
    expect(humanizeCloudSkip("render-failed")).toMatch(/could not be rendered/);
  });

  test("an oversized snapshot is capped and says it was truncated", async () => {
    const big: A11ySnapshot = {
      ...FIXTURE,
      boxes: Array.from({ length: A11Y_SNAPSHOT_LIMITS.boxes + 25 }, (_, i) => ({
        selector: `div:nth-child(${i})`,
        x: 0,
        y: i,
        width: 1,
        height: 1,
      })),
    };
    const res = await prefetchCloudData(base(fakeClient(() => big, [])));
    const read = readA11ySnapshot(res.store, URL_A);
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.truncated).toBe(true);
    expect(read.snapshot.boxes).toHaveLength(A11Y_SNAPSHOT_LIMITS.boxes);
    expect(read.snapshot.dropped).toEqual({ boxes: 25 });
  });

  test("logged out, disabled and render-disabled runs never call the service", async () => {
    const requests: RenderRequest[] = [];
    const client = fakeClient(() => FIXTURE, requests);
    const out = await prefetchCloudData(base(null));
    expect(readA11ySnapshot(out.store, URL_A)).toEqual({
      status: "skipped",
      skipReason: "not-authenticated",
    });
    const off = await prefetchCloudData({
      ...base(client),
      config: { ...config, enabled: false } as CloudConfig,
    });
    expect(readA11ySnapshot(off.store, URL_A).status).toBe("skipped");
    const noRender = await prefetchCloudData({ ...base(client), renderDisabled: true });
    expect(readA11ySnapshot(noRender.store, URL_A)).toEqual({
      status: "skipped",
      skipReason: "render-disabled",
    });
    expect(requests).toHaveLength(0);
  });

  test("out of credits: the 402 on submit skips every page insufficient-credits, nothing charged", async () => {
    const client = {
      getBalance: async () => BALANCE,
      render: async () => {
        throw new CloudClientError("insufficient_credits", 402, "out of credits");
      },
    } as unknown as CloudServicesClient;
    const res = await prefetchCloudData(base(client));
    expect(res.totalSpent).toBe(0);
    expect(readA11ySnapshot(res.store, URL_A)).toEqual({
      status: "skipped",
      skipReason: "insufficient-credits",
    });
  });
});
