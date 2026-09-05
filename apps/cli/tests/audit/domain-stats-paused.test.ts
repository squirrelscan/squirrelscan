// Domain stats is paused: the hosted route answers 404 for everyone, so the CLI
// step must not run and must not narrate itself.
//
// The config default is the switch, but a default is easy to assert and easy to
// pass vacuously, so these drive the real `runCloudDomainStats` and watch what it
// does to the client, the spend callback and the progress stream. The case that
// bit us is the second one: a config written before the pause still says
// `domain_stats = true`, and that user must get silence, not two progress lines
// about a step that cannot produce anything.

import { CloudClientError } from "@squirrelscan/cloud-client";
import { describe, expect, test } from "bun:test";

import { runCloudDomainStats } from "../../src/audit/cloud";
import { getDefaultConfig } from "../../src/config";

/** The paused hosted route: 404, no body the client can turn into a result. */
function pausedClient(calls: string[]) {
  return {
    domainStats: async () => {
      calls.push("domainStats");
      throw new CloudClientError(
        "service_unavailable",
        404,
        "Domain stats is not available"
      );
    },
  } as never;
}

function liveClient(calls: string[]) {
  return {
    domainStats: async () => {
      calls.push("domainStats");
      return {
        domain: "example.com",
        metrics: { backlinks: 10 },
        capturedAt: "2026-09-03T00:00:00.000Z",
        cached: false,
      };
    },
  } as never;
}

function harness() {
  const calls: string[] = [];
  const progress: string[] = [];
  const spend: number[] = [];
  return {
    calls,
    progress,
    spend,
    args: {
      auditId: "audit-1",
      baseUrl: "https://example.com",
      onProgress: (m: string) => progress.push(m),
      onSpend: (c: number) => spend.push(c),
    },
  };
}

describe("runCloudDomainStats — paused by default", () => {
  test("default config → no client call, no progress, no spend, null result", async () => {
    const h = harness();
    const config = getDefaultConfig();
    config.cloud.enabled = true;

    const result = await runCloudDomainStats({
      client: pausedClient(h.calls),
      config,
      ...h.args,
    });

    expect(result).toBeNull();
    expect(h.calls).toEqual([]);
    expect(h.progress).toEqual([]);
    expect(h.spend).toEqual([]);
  });

  test("an existing domain_stats = true config degrades SILENTLY on the paused 404", async () => {
    const h = harness();
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    config.cloud.domain_stats = true;

    const result = await runCloudDomainStats({
      client: pausedClient(h.calls),
      config,
      ...h.args,
    });

    // The call happens (the CLI cannot know the service is off until it asks),
    // but nothing reaches the user: no section, no spend, no throw, and above all
    // no "cloud: domain stats / cloud: domain stats skipped" on every audit.
    expect(result).toBeNull();
    expect(h.calls).toEqual(["domainStats"]);
    expect(h.progress).toEqual([]);
    expect(h.spend).toEqual([]);
  });

  test("cloud.enabled false wins over an opted-in domain_stats", async () => {
    const h = harness();
    const config = getDefaultConfig();
    config.cloud.enabled = false;
    config.cloud.domain_stats = true;

    expect(
      await runCloudDomainStats({
        client: pausedClient(h.calls),
        config,
        ...h.args,
      })
    ).toBeNull();
    expect(h.calls).toEqual([]);
  });

  test("a null client (logged out) short-circuits before anything else", async () => {
    const h = harness();
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    config.cloud.domain_stats = true;

    expect(
      await runCloudDomainStats({ client: null, config, ...h.args })
    ).toBeNull();
    expect(h.progress).toEqual([]);
  });

  test("paused, not removed: opting in against a LIVE service still returns stats", async () => {
    // Guards the revival path — the pause must be a default, not a dead branch.
    const h = harness();
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    config.cloud.domain_stats = true;

    const result = await runCloudDomainStats({
      client: liveClient(h.calls),
      config,
      ...h.args,
    });

    expect(result?.domainStats.domain).toBe("example.com");
    expect(h.calls).toEqual(["domainStats"]);
  });
});
