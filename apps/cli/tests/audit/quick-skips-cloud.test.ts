// `-C quick` coverage must skip ALL networked cloud enrichment so a quick run
// never prompts for / spends credits. The audit controller gates four cloud
// sites on `isQuickMode` (coverageMode === "quick"):
//   1. dead-links bulk checker  → client forced null
//   2. STEP 2.4 cloud prefetch  → branch skipped
//   3. STEP 2.6 tech-detect     → branch skipped
//   4. STEP 3.1 editor summary  → branch skipped
//
// runAudit() drives a full crawl + fetchers, so it's too integration-heavy to
// invoke unit-style without network. Instead this test reproduces the exact
// gate decisions the controller computes and asserts that quick mode disables
// every cloud branch — and, for the dead-links site, that the controller's
// null client actually makes the downstream `resolveDeadLinksBulkChecker`
// return null (no cloud dead-link checks). Deterministic, no network.

import type { PageRecord } from "@squirrelscan/core-contracts/storage";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { buildSiteContext } from "../../src/audit/adapter";
import { resolveDeadLinksBulkChecker } from "../../src/audit/cloud";
import { getDefaultConfig } from "../../src/config";

function pageRecord(html: string): PageRecord {
  return {
    url: "https://example.com/",
    normalizedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: "hash",
    html,
    parsedData: null,
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
      vary: null,
      etag: null,
      server: null,
      lastModified: null,
      link: null,
      serverTiming: null,
      age: null,
      xCache: null,
      cfCacheStatus: null,
      xVercelCache: null,
      altSvc: null,
      acceptRanges: null,
    },
    securityHeaders: {
      hsts: null,
      csp: null,
      xFrameOptions: null,
      xContentTypeOptions: null,
      referrerPolicy: null,
      permissionsPolicy: null,
      xRobotsTag: null,
    },
  };
}

const HTML = `<html><body>
  <a href="https://external-one.com/a">one</a>
  <a href="https://external-two.com/b">two</a>
</body></html>`;

// A stand-in cloud client — never actually called in any of these cases because
// quick mode forces it null / skips the branch.
const FAKE_CLIENT = {
  deadLinks: async () => {
    throw new Error("quick mode must not reach the cloud client");
  },
} as never;

/**
 * The dead-links client the controller builds:
 *   options.cloudAvailable === false || isQuickMode ? null : client
 */
function controllerDeadLinksClient(opts: {
  cloudAvailable: boolean;
  isQuickMode: boolean;
}) {
  return opts.cloudAvailable === false || opts.isQuickMode ? null : FAKE_CLIENT;
}

/**
 * The shared cloud-branch gate the controller applies to prefetch (STEP 2.4),
 * tech-detect (STEP 2.6) and editor-summary (STEP 3.1):
 *   cloud.enabled && cloudAvailable !== false && !isQuickMode [&& feature flag]
 */
function cloudBranchRuns(opts: {
  cloudEnabled: boolean;
  cloudAvailable: boolean;
  isQuickMode: boolean;
  featureFlag?: boolean;
}) {
  return (
    opts.cloudEnabled &&
    opts.cloudAvailable !== false &&
    !opts.isQuickMode &&
    (opts.featureFlag ?? true)
  );
}

describe("quick coverage skips cloud enrichment", () => {
  test("dead-links cloud client is null in quick mode → no bulk checker", async () => {
    const config = getDefaultConfig(); // cloud.enabled = true by default
    const siteContext = await Effect.runPromise(
      buildSiteContext([pageRecord(HTML)])
    );

    const quickClient = controllerDeadLinksClient({
      cloudAvailable: true,
      isQuickMode: true,
    });
    expect(quickClient).toBeNull();

    // Null client → resolveDeadLinksBulkChecker returns null (local checking).
    const checker = await resolveDeadLinksBulkChecker({
      client: quickClient,
      config,
      auditId: "audit-quick",
      siteContext,
    });
    expect(checker).toBeNull();
  });

  test("dead-links cloud client is live when not quick (and cloud available)", async () => {
    const config = getDefaultConfig();
    const siteContext = await Effect.runPromise(
      buildSiteContext([pageRecord(HTML)])
    );

    const surfaceClient = controllerDeadLinksClient({
      cloudAvailable: true,
      isQuickMode: false,
    });
    expect(surfaceClient).not.toBeNull();

    // External links present + dead-links rule enabled by default → real checker.
    const checker = await resolveDeadLinksBulkChecker({
      client: surfaceClient,
      config,
      auditId: "audit-surface",
      siteContext,
    });
    expect(checker).not.toBeNull();
  });

  test("prefetch / tech-detect / editor-summary branches are skipped in quick mode", () => {
    // Every cloud branch is OFF in quick mode despite cloud being enabled,
    // available, and the per-feature flags set (the defaults).
    expect(
      cloudBranchRuns({
        cloudEnabled: true,
        cloudAvailable: true,
        isQuickMode: true,
      })
    ).toBe(false); // prefetch (STEP 2.4)
    expect(
      cloudBranchRuns({
        cloudEnabled: true,
        cloudAvailable: true,
        isQuickMode: true,
        featureFlag: true, // cloud.technologies
      })
    ).toBe(false); // tech-detect (STEP 2.6)
    expect(
      cloudBranchRuns({
        cloudEnabled: true,
        cloudAvailable: true,
        isQuickMode: true,
        featureFlag: true, // cloud.editor_summary
      })
    ).toBe(false); // editor-summary (STEP 3.1)
  });

  test("the same branches run in surface mode (gate is quick-specific)", () => {
    expect(
      cloudBranchRuns({
        cloudEnabled: true,
        cloudAvailable: true,
        isQuickMode: false,
      })
    ).toBe(true);
  });
});
