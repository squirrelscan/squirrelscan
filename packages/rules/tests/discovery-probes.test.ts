// #409 — the pre-crawl discovery probes follow the rule selection. A probe is
// sent only while an enabled rule reads it, so `--rule-exclude ax` (or
// `[rules] disable`) keeps /swagger.json and the rest off the wire with no
// other setting, and `[crawler] disable_discovery_probes = true` turns them all off.

import { describe, expect, test } from "bun:test";

import { DISCOVERY_PROBES } from "@squirrelscan/core-contracts/storage";

import { selectDiscoveryProbes } from "../src/discovery-probes";
import { loadAllRules } from "../src/loader";
import type { Rule } from "../src/types";

const ALL = { enable: ["*"], disable: [] };
const API_PATHS = [
  "/.well-known/api-catalog",
  "/openapi.json",
  "/swagger.json",
  "/api/openapi.json",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
];

describe("selectDiscoveryProbes (#409)", () => {
  test("every probe has a reader, so a default audit still sends all of them", () => {
    const declared = new Set(
      [...loadAllRules().values()].flatMap((rule) => rule.meta.discoveryProbes ?? []),
    );
    for (const probe of DISCOVERY_PROBES) expect(declared.has(probe)).toBe(true);
    expect(selectDiscoveryProbes({ enabled: true, rules: ALL })).toEqual([...DISCOVERY_PROBES]);
  });

  test("disable_discovery_probes = true sends none, whatever the rules", () => {
    expect(selectDiscoveryProbes({ enabled: false, rules: ALL })).toEqual([]);
  });

  test("excluding the ax category sends none", () => {
    expect(selectDiscoveryProbes({ enabled: true, rules: { enable: ["*"], disable: ["ax/*"] } })).toEqual(
      [],
    );
    // The legacy `ai` code is an alias of `ax`.
    expect(selectDiscoveryProbes({ enabled: true, rules: { enable: ["*"], disable: ["ai/*"] } })).toEqual(
      [],
    );
  });

  test("including only other categories sends none", () => {
    expect(selectDiscoveryProbes({ enabled: true, rules: { enable: ["core/*", "perf/*"] } })).toEqual([]);
  });

  test("excluding ax/api-discovery drops only the paths it reads", () => {
    const selected = selectDiscoveryProbes({
      enabled: true,
      rules: { enable: ["*"], disable: ["ax/api-discovery"] },
    });
    for (const path of API_PATHS) expect(selected).not.toContain(path);
    expect(selected).toContain("/AGENTS.md");
    expect(selected).toContain("/.well-known/mcp.json");
    expect(selected).toContain("llms-txt");
    expect(selected).toHaveLength(DISCOVERY_PROBES.length - API_PATHS.length);
  });

  test("a probe with two readers stays while either one runs", () => {
    // agent-access is read by ax/agent-blocking and ax/pay-per-crawl.
    const one = selectDiscoveryProbes({
      enabled: true,
      rules: { enable: ["*"], disable: ["ax/agent-blocking"] },
    });
    expect(one).toContain("agent-access");
    const both = selectDiscoveryProbes({
      enabled: true,
      rules: ALL,
      ruleOptions: { "ax/agent-blocking": { enabled: false }, "ax/pay-per-crawl": { enabled: false } },
    });
    expect(both).not.toContain("agent-access");
  });

  test("a plugin rule's declared probes count when its namespace is passed", () => {
    const pluginRule: Rule = {
      meta: {
        id: "acme/openapi-owner",
        name: "OpenAPI owner",
        description: "Reads the OpenAPI probe.",
        category: "ax",
        scope: "site",
        severity: "info",
        weight: 1,
        discoveryProbes: ["/openapi.json"],
      },
      run: () => ({ checks: [] }),
    };
    expect(
      selectDiscoveryProbes({
        enabled: true,
        rules: { enable: ["*"], disable: ["ax/*"] },
        additionalNamespaces: [{ name: "acme", rules: [pluginRule] }],
      }),
    ).toEqual(["/openapi.json"]);
  });

  test("a single rule gets exactly its own probes", () => {
    expect(selectDiscoveryProbes({ enabled: true, rules: { enable: ["ax/agents-md"] } })).toEqual([
      "llms-txt",
      "/AGENTS.md",
      "/agents.md",
      "/.well-known/agents.md",
      "/docs/AGENTS.md",
    ]);
  });
});
