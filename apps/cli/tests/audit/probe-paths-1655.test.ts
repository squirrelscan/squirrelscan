// `--discovery-probe-path` reads repeatable or comma-separated probe paths (#1655).

import { describe, expect, test } from "bun:test";

import { parseDiscoveryProbePaths } from "@/audit/probe-paths";

describe("parseDiscoveryProbePaths", () => {
  test("none given: an empty list", () => {
    expect(parseDiscoveryProbePaths(undefined)).toEqual({
      ok: true,
      paths: [],
    });
  });

  test("repeatable and comma-separated, deduplicated", () => {
    expect(
      parseDiscoveryProbePaths(["/llms.txt", "/AGENTS.md,/llms.txt"])
    ).toEqual({
      ok: true,
      paths: ["/llms.txt", "/AGENTS.md"],
    });
  });

  test("a path that is not a probe path is an error, not a silent no-op", () => {
    const result = parseDiscoveryProbePaths("/llms.txt,/agents");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('"/agents"');
  });
});
