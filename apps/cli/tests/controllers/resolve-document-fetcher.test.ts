// resolveDocumentFetcher — cloud must NOT build a browser-render fetcher when
// cloud is unavailable this run (expired/unreachable), even for explicit
// --render / [cloud].rendering="browser" (resolveCloudRendering returns
// "browser" before checking auth). Guards the #161 cloudAvailable gate.

import type { DocumentFetcher } from "@squirrelscan/fetchers";

import { getDefaultConfig } from "@squirrelscan/config";
import { describe, expect, test } from "bun:test";

import {
  resolveDocumentFetcher,
  type RunAuditOptions,
} from "../../src/controllers/audit";

const opts = (o: Partial<RunAuditOptions>): RunAuditOptions =>
  o as RunAuditOptions;

// Happy path (cloudAvailable:true + rendering=browser → cloud fetcher built)
// needs mocking createCloudClientFromSettings; covered by the PR e2e runs.

describe("resolveDocumentFetcher — cloudAvailable gate", () => {
  test("cloudAvailable:false → plain HTTP even with rendering=browser", () => {
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    config.cloud.rendering = "browser";
    expect(
      resolveDocumentFetcher(opts({ cloudAvailable: false }), config)
    ).toBeUndefined();
  });

  test("rendering=http → plain HTTP regardless of cloudAvailable", () => {
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    config.cloud.rendering = "http";
    expect(
      resolveDocumentFetcher(opts({ cloudAvailable: true }), config)
    ).toBeUndefined();
  });

  test("explicit documentFetcher always wins (even with cloud unavailable)", () => {
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    config.cloud.rendering = "browser";
    const custom: DocumentFetcher = {
      id: "custom",
      capabilities: { jsRendering: false, cookies: false, screenshot: false },
      async fetch() {
        throw new Error("not used");
      },
    };
    expect(
      resolveDocumentFetcher(
        opts({ documentFetcher: custom, cloudAvailable: false }),
        config
      )
    ).toBe(custom);
  });
});

// #1664: a render that was asked for and could not run says why, for the report.
describe("resolveDocumentFetcher — fallback reason hook (#1664)", () => {
  test("cloud unavailable with rendering=browser reports why", () => {
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    config.cloud.rendering = "browser";
    const reasons: string[] = [];
    resolveDocumentFetcher(
      opts({ cloudAvailable: false }),
      config,
      undefined,
      false,
      {
        onFallbackReason: (reason) => reasons.push(reason),
      }
    );
    expect(reasons).toEqual(["cloud unavailable (signed out or unreachable)"]);
  });

  test("rendering=http was never asked for, so there is no reason", () => {
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    config.cloud.rendering = "http";
    const reasons: string[] = [];
    resolveDocumentFetcher(
      opts({ cloudAvailable: true }),
      config,
      undefined,
      false,
      {
        onFallbackReason: (reason) => reasons.push(reason),
      }
    );
    expect(reasons).toEqual([]);
  });
});
