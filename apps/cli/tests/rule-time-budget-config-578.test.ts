// #578: `[rules] time_budget_ms` survives config parsing and the
// --rule-include/--rule-exclude merge, so it reaches the rules runner.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigSchema, loadConfig } from "../src/config";
import { mergeOptionsToConfig } from "../src/controllers/audit";

describe("[rules] time_budget_ms (#578)", () => {
  test("parses, and stays unset by default", () => {
    expect(ConfigSchema.parse({}).rules.time_budget_ms).toBeUndefined();
    expect(
      ConfigSchema.parse({ rules: { time_budget_ms: 2500 } }).rules
        .time_budget_ms
    ).toBe(2500);
    expect(
      ConfigSchema.parse({ rules: { time_budget_ms: 0 } }).rules.time_budget_ms
    ).toBe(0);
  });

  test("loads from squirrel.toml", async () => {
    const dir = mkdtempSync(join(tmpdir(), "time-budget-"));
    try {
      const path = join(dir, "squirrel.toml");
      writeFileSync(path, "[rules]\ntime_budget_ms = 3000\n");
      const config = await loadConfig(path, { silent: true });
      expect(config.rules.time_budget_ms).toBe(3000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a budget below the default, other than 0 (#880)", () => {
    for (const ms of [-1, 1, 500, 999, 1000.5]) {
      expect(
        ConfigSchema.safeParse({ rules: { time_budget_ms: ms } }).success
      ).toBe(false);
    }
    const message = ConfigSchema.safeParse({ rules: { time_budget_ms: 500 } })
      .error?.issues[0]?.message;
    expect(message).toBe("time_budget_ms must be 0 (off) or at least 1000");
    expect(
      ConfigSchema.safeParse({ rules: { time_budget_ms: 1000 } }).success
    ).toBe(true);
  });

  test("survives the rule filter merge", () => {
    const config = ConfigSchema.parse({ rules: { time_budget_ms: 2500 } });
    const merged = mergeOptionsToConfig(config, {
      url: "https://example.com",
      ruleInclude: ["core/*"],
      ruleExclude: ["core/meta-title"],
    });
    expect(merged.rules).toEqual({
      enable: ["core/*"],
      disable: ["core/meta-title"],
      time_budget_ms: 2500,
    });
  });
});
