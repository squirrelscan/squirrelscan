import { describe, expect, test } from "bun:test";

import { CloudClientError, type CloudServicesClient } from "@squirrelscan/cloud-client";
import type { RenderRequest } from "@squirrelscan/core-contracts";
import type { DocumentFetcher, FetchRequest } from "@squirrelscan/fetchers";

import { createCloudDocumentFetcher, terminalFallbackReason } from "../src/cloud-fetcher";

describe("terminalFallbackReason", () => {
  test("run_inactive (reaped run #475) is immediately terminal → fall back to local HTTP", () => {
    // A single occurrence trips it — no consecutive-failure threshold, unlike 5xx.
    const err = new CloudClientError("run_inactive", 409, "Run is no longer active");
    expect(terminalFallbackReason(err, 1)).toBe("run no longer active");
  });

  test("insufficient_credits and not_authenticated stay terminal", () => {
    expect(terminalFallbackReason(new CloudClientError("insufficient_credits", 402, "x"), 1)).toBe(
      "out of credits",
    );
    expect(terminalFallbackReason(new CloudClientError("not_authenticated", 401, "x"), 1)).toBe(
      "not authenticated",
    );
  });

  test("a lone transient failure is NOT terminal (keeps retrying below the threshold)", () => {
    expect(terminalFallbackReason(new CloudClientError("service_unavailable", 503, "x"), 1)).toBe(
      null,
    );
    // duplicate_request never disables rendering.
    expect(terminalFallbackReason(new CloudClientError("duplicate_request", 409, "x"), 1)).toBe(
      null,
    );
  });

  test("repeated server failures at the threshold become terminal", () => {
    expect(terminalFallbackReason(new CloudClientError("service_unavailable", 503, "x"), 3)).toBe(
      "3 consecutive cloud failures",
    );
  });
});

describe("render runId threading (#1134)", () => {
  // A client that records every render submit and resolves the batch immediately.
  function recordingClient(captured: RenderRequest[]): CloudServicesClient {
    return {
      render: async (req: RenderRequest) => {
        captured.push(req);
        return { jobId: "tok", status: "queued" as const, charged: 2 };
      },
      renderResult: async () => ({
        jobId: "tok",
        status: "done" as const,
        results: [{ url: "https://example.com/", status: 200, html: "<html></html>", headers: {} }],
      }),
    } as unknown as CloudServicesClient;
  }

  const neverFallback = {
    id: "http",
    capabilities: { jsRendering: false, cookies: false, screenshot: false },
    fetch: async () => {
      throw new Error("fallback must not run on a successful render");
    },
  } as unknown as DocumentFetcher;

  const fastOpts = {
    fallback: neverFallback,
    batchWindowMs: 1,
    firstPollDelayMs: 1,
    pollIntervalMs: 5,
  };

  test("resolver threads the run id onto the render submit", async () => {
    const captured: RenderRequest[] = [];
    const fetcher = createCloudDocumentFetcher(recordingClient(captured), {
      ...fastOpts,
      runId: () => "run-xyz",
    });
    await fetcher.fetch({ url: "https://example.com/" } as FetchRequest);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.runId).toBe("run-xyz");
  });

  test("omits runId when no resolver is supplied", async () => {
    const captured: RenderRequest[] = [];
    const fetcher = createCloudDocumentFetcher(recordingClient(captured), fastOpts);
    await fetcher.fetch({ url: "https://example.com/" } as FetchRequest);
    expect(captured[0]?.runId).toBeUndefined();
  });

  test("omits runId when the resolver returns undefined (async register not yet resolved)", async () => {
    const captured: RenderRequest[] = [];
    const fetcher = createCloudDocumentFetcher(recordingClient(captured), {
      ...fastOpts,
      runId: () => undefined,
    });
    await fetcher.fetch({ url: "https://example.com/" } as FetchRequest);
    expect(captured[0]?.runId).toBeUndefined();
  });
});
