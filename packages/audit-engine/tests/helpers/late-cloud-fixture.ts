// Shared fixture for the late-bound cloud results tests and bench (pub#2121): a
// deterministic stub of the cloud services with injectable per-call latency, and
// the prefetch input the container builds, from a stored crawl's pages.

import type { CloudServicesClient } from "@squirrelscan/cloud-client";
import type { CloudConfig, Config } from "@squirrelscan/config";
import type {
  AiParsePageType,
  CloudPagePayload,
  CloudServiceId,
  PageRecord,
  RenderResultItem,
  RenderResultResponse,
  SiteMetadataResponse,
} from "@squirrelscan/core-contracts";

import type { CloudPrefetchInput } from "../../src/cloud-prefetch";
import { gateStage1, selectCloudRules } from "../../src/cloud-prefetch-run";

export const STUB_METADATA: SiteMetadataResponse = {
  siteType: "blog",
  isYMYL: false,
  isLocalBusiness: false,
  hasOwnershipVerified: false,
  confidence: "high",
};

const BALANCE = {
  balance: { monthly: 0, pack: 1_000_000, total: 1_000_000, periodEnd: null },
  plan: {} as never,
  pricing: {} as never,
  pricingVersion: 1,
};

const PAGE_TYPES: AiParsePageType[] = ["article", "product", "homepage"];

/** A small stable number from a url, so every stubbed answer varies by page but never by run. */
function seedOf(url: string): number {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) >>> 0;
  return h;
}

/** The rendered page the stub returns: some pages gain JS-only words, some error. */
function renderItem(url: string): RenderResultItem {
  const s = seedOf(url);
  const extra = s % 3 === 0 ? " ".repeat(1) + "hydrated words ".repeat(400) : "";
  return {
    url,
    status: 200,
    html: `<html><head><title>r ${s % 97}</title></head><body><main><p>rendered body ${s}</p>${extra}</main></body></html>`,
    ...(s % 5 === 0
      ? {
          runtime: {
            consoleErrors: [{ message: `TypeError: x is undefined (${s % 4})`, source: `${url}/app.js` }],
            pageErrors: [],
            failedRequests: [],
          },
        }
      : {}),
  } as unknown as RenderResultItem;
}

export interface StubCalls {
  /** `service:batch-index` in dispatch order (batch index counts that service's calls). */
  dispatched: string[];
}

/**
 * A cloud client answering every prefetch service from the page url alone.
 * `latency(service, call)` delays each call (call = 0-based count of that
 * service's calls so far, i.e. its batch index when batches dispatch in order);
 * a page-unit call's latency is paid on its submit.
 */
export function stubCloudClient(
  latency: (service: CloudServiceId, call: number, urls: string[]) => Promise<void> | void = () => {},
  calls: StubCalls = { dispatched: [] },
): CloudServicesClient {
  const counts = new Map<CloudServiceId, number>();
  const delay = async (service: CloudServiceId, urls: string[]) => {
    const call = counts.get(service) ?? 0;
    counts.set(service, call + 1);
    calls.dispatched.push(`${service}:${call}`);
    await latency(service, call, urls);
  };
  const jobs = new Map<string, string[]>();
  return {
    getBalance: async () => BALANCE,
    siteMetadata: async () => {
      await delay("site-metadata", []);
      return STUB_METADATA;
    },
    keywordGaps: async () => {
      await delay("keyword-gaps", []);
      return { gaps: [], summary: "" };
    },
    contentGaps: async () => {
      await delay("content-gaps", []);
      return { gaps: [], summary: "" };
    },
    blocklistCheck: async () => {
      await delay("blocklist-check", []);
      return { matches: [], listsVersion: "stub-1" };
    },
    archiveIndexing: async (req: { url: string }) => {
      await delay("archive-indexing", []);
      return {
        domain: new URL(req.url).hostname,
        wayback: { indexed: true },
        commonCrawl: { indexed: false },
        capturedAt: "2026-01-01T00:00:00.000Z",
        cached: true,
      };
    },
    aiParse: async (req: { pages: CloudPagePayload[] }) => {
      await delay(
        "ai-parse",
        req.pages.map((p) => p.url),
      );
      return {
        results: req.pages.map((p) => {
          const s = seedOf(p.url);
          return {
            url: p.url,
            pageType: PAGE_TYPES[s % PAGE_TYPES.length]!,
            parsabilityScore: (s % 100) / 100,
            confidence: 0.9,
          };
        }),
      };
    },
    authoritySignals: async (req: { pages: CloudPagePayload[] }) => {
      await delay(
        "authority-signals",
        req.pages.map((p) => p.url),
      );
      return {
        results: req.pages.map((p) => {
          const s = seedOf(p.url);
          return {
            url: p.url,
            authorPresent: s % 2 === 0,
            citationCount: s % 4,
            outboundLinkCount: s % 9,
            signals: s % 2 === 0 ? ["byline"] : [],
          };
        }),
      };
    },
    render: async (req: { urls: string[] }) => {
      await delay("render", req.urls);
      const jobId = `job-${jobs.size}`;
      jobs.set(jobId, req.urls);
      return { jobId, status: "queued" };
    },
    renderResult: async (jobId: string): Promise<RenderResultResponse> => ({
      jobId,
      status: "done",
      results: (jobs.get(jobId) ?? []).map(renderItem),
    }),
  } as unknown as CloudServicesClient;
}

/** Slim payloads for every stored 2xx HTML page, in crawl order, as the container sends. */
export function payloadsFor(pages: readonly PageRecord[]): CloudPagePayload[] {
  return pages
    .filter((p) => p.status >= 200 && p.status < 300 && (p.html ?? "").length > 0)
    .map((p) => ({ url: p.url, textExcerpt: `excerpt of ${p.url}` }));
}

/** The prefetch input a container run builds for `config`, with every cloud rule enabled. */
export function prefetchInputFor(
  client: CloudServicesClient,
  config: Config,
  pages: CloudPagePayload[],
  siteUrl: string,
  batchSize: number,
): Omit<CloudPrefetchInput, "accumulator"> {
  const cloud: CloudConfig = {
    ...config.cloud,
    enabled: true,
    max_credits_per_audit: 0,
    confirm_threshold: Number.MAX_SAFE_INTEGER,
    batch_size: batchSize,
  };
  return {
    client,
    config: cloud,
    rules: selectCloudRules(config),
    pages,
    metadataPages: [{ url: siteUrl, title: "Home" }],
    sitePayloads: {
      "keyword-gaps": { domain: new URL(siteUrl).hostname },
      "content-gaps": { domain: new URL(siteUrl).hostname },
      "blocklist-check": { urls: [siteUrl], selectors: [] },
      "archive-indexing": { url: siteUrl },
    } as CloudPrefetchInput["sitePayloads"],
    gate: gateStage1,
    siteUrl,
    auditId: "audit-2121",
  };
}

/** Config with every rule on, including the opt-in cloud rules, and nothing that touches the network. */
export function lateCloudConfig(base: Config): Config {
  return {
    ...base,
    rules: { ...base.rules, enable: ["*"], disable: [] },
    cloud: { ...base.cloud, enabled: true },
  };
}

/** A promise with its resolver, for holding a batch until the test lets it go. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
