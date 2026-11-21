// repo#1082: a run narrowed by --rule-include/--rule-exclude carries a partial marker in the
// publish payload and every output format; an unfiltered run carries none. A rule the user
// excluded never appears as a locked-rules upsell.

import { withoutFilteredLockedRules } from "@squirrelscan/audit-engine";
import { renderJson } from "@squirrelscan/report/output/json";
import { renderLlm } from "@squirrelscan/report/output/llm";
import { renderMarkdown } from "@squirrelscan/report/output/markdown";
import { renderText } from "@squirrelscan/report/output/text";
import { renderXml } from "@squirrelscan/report/output/xml";
import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/types";

import {
  buildPartialAudit,
  resolveRulesConfig,
  wcagRuleDisables,
  zeroRulesError,
} from "../../src/audit/rule-filter";
import { lockedRulesFooterLine } from "../../src/cli/banner";
import {
  computeLockedRules,
  slimForPublish,
} from "../../src/controllers/report/publish";

const base = (over: Partial<AuditReport> = {}): AuditReport =>
  ({
    baseUrl: "https://example.com",
    timestamp: "2026-11-10T10:00:00.000Z",
    totalPages: 0,
    passed: 0,
    warnings: 0,
    failed: 0,
    pages: [],
    siteChecks: [],
    ruleResults: {},
    ...over,
  }) as unknown as AuditReport;

const partial = buildPartialAudit({ enable: ["ax/*", "perf/*"], disable: [] });

describe("buildPartialAudit", () => {
  test("is undefined for an unfiltered run", () => {
    expect(buildPartialAudit({ enable: [], disable: [] })).toBeUndefined();
  });

  test("names the categories an include filter leaves", () => {
    expect(partial?.include).toEqual(["ax/*", "perf/*"]);
    expect(partial?.includedCategories).toContain("ax");
    expect(partial?.includedCategories).toContain("perf");
    expect(partial?.includedCategories).not.toContain("core");
  });

  test("an exclude filter drops only the excluded category", () => {
    const p = buildPartialAudit({ enable: [], disable: ["perf/*"] });
    expect(p?.exclude).toEqual(["perf/*"]);
    expect(p?.includedCategories).not.toContain("perf");
    expect(p?.includedCategories).toContain("core");
  });

  test("excluding one rule keeps its category in the scored set", () => {
    const p = buildPartialAudit({ enable: [], disable: ["core/meta-title"] });
    expect(p?.exclude).toEqual(["core/meta-title"]);
    expect(p?.includedCategories).toContain("core");
    expect(p?.includedCategories).toContain("perf");
  });

  test("including one rule scores only its category", () => {
    const p = buildPartialAudit({ enable: ["core/meta-title"], disable: [] });
    expect(p?.includedCategories).toEqual(["core"]);
  });
});

describe("a run narrowed by a WCAG level (repo#3093)", () => {
  test("is partial and names the level, keeping the user's patterns as they were", () => {
    const p = buildPartialAudit({ enable: [], disable: [] }, [], "AA");
    expect(p).toBeDefined();
    expect(p?.wcagLevel).toBe("AA");
    expect(p?.include).toEqual([]);
    expect(p?.exclude).toEqual([]);
    expect(p?.includedCategories).toContain("a11y");
    expect(p?.includedCategories).toContain("core");
  });

  test("an include filter plus a level records both", () => {
    const p = buildPartialAudit({ enable: ["a11y/*"], disable: [] }, [], "A");
    expect(p?.include).toEqual(["a11y/*"]);
    expect(p?.wcagLevel).toBe("A");
    expect(p?.includedCategories).toEqual(["a11y"]);
  });

  test("an unfiltered run with no level has no marker and no wcagLevel", () => {
    expect(
      buildPartialAudit({ enable: [], disable: [] }, [], undefined)
    ).toBeUndefined();
    expect(
      buildPartialAudit({ enable: ["ax/*"], disable: [] })
    ).not.toHaveProperty("wcagLevel");
  });
});

describe("zero-rules pre-check sees the WCAG level (repo#3093)", () => {
  const config = { enable: ["*"], disable: [] };
  const check = (
    enable: string[],
    disable: string[],
    level?: "A" | "AA" | "AAA"
  ) =>
    zeroRulesError(enable, resolveRulesConfig(config, { enable, disable }), {
      level,
      disables: wcagRuleDisables(level),
    });

  test("--rule-include a11y/touch-targets --wcag-level AA is refused", () => {
    expect(check(["a11y/touch-targets"], [], "AA")).toContain("WCAG level AA");
  });

  test("a rule the level keeps, or no level, is not refused", () => {
    expect(check(["a11y/touch-targets"], [], "AAA")).toBeNull();
    expect(check(["a11y/touch-targets"], [])).toBeNull();
    expect(check(["a11y/color-contrast"], [], "AA")).toBeNull();
    expect(check(["a11y/*"], [], "A")).toBeNull();
  });

  // pub#2110: the selection can come from `[rules] enable` alone, the way audit.ts calls it.
  const checkConfig = (configEnable: string[], level?: "A" | "AA" | "AAA") => {
    const resolved = resolveRulesConfig(
      { enable: configEnable, disable: [] },
      { enable: [], disable: [] }
    );
    return zeroRulesError(resolved.enable, resolved, {
      level,
      disables: wcagRuleDisables(level),
    });
  };

  test("config-only [rules] enable of a rule the WCAG level leaves out is refused", () => {
    expect(checkConfig(["a11y/touch-targets"], "AA")).toContain(
      "WCAG level AA"
    );
  });

  test("config-only enable the level keeps, or the default, is not refused", () => {
    expect(checkConfig(["a11y/touch-targets"], "AAA")).toBeNull();
    expect(checkConfig(["a11y/touch-targets"])).toBeNull();
    expect(checkConfig(["*"], "AA")).toBeNull();
  });

  test("the include/exclude contradiction keeps its own message", () => {
    expect(check(["ax/*"], ["ax/*"], "AA")).toContain("contradict each other");
  });
});

describe("output formats", () => {
  const filtered = base({ partialAudit: partial });
  const full = base();

  test("json carries meta.partialAudit only when filtered", () => {
    expect(
      JSON.parse(renderJson(filtered)).meta.partialAudit.includedCategories
    ).toContain("ax");
    expect("partialAudit" in JSON.parse(renderJson(full)).meta).toBe(false);
  });

  test("text, markdown, xml and llm mark a filtered run", () => {
    expect(renderText(filtered)).toContain("Partial audit: included ax, perf");
    expect(renderMarkdown(filtered)).toContain("Partial audit");
    expect(renderXml(filtered)).toContain("<partial-audit ");
    expect(renderLlm(filtered)).toContain("<partial-audit ");
  });

  test("no format marks an unfiltered run", () => {
    expect(renderText(full)).not.toContain("Partial audit");
    expect(renderMarkdown(full)).not.toContain("Partial audit");
    expect(renderXml(full)).not.toContain("partial-audit");
    expect(renderLlm(full)).not.toContain("partial-audit");
  });
});

describe("publish payload", () => {
  test("carries the marker for a filtered run and none otherwise", () => {
    const withMarker = slimForPublish(
      base({ partialAudit: partial })
    ) as unknown as {
      partialAudit?: { includedCategories: string[] };
    };
    expect(withMarker.partialAudit?.includedCategories).toContain("ax");
    const without = slimForPublish(base()) as unknown as Record<
      string,
      unknown
    >;
    expect("partialAudit" in without).toBe(false);
  });
});

describe("locked rules", () => {
  const cloudRuleIds = (): string[] =>
    computeLockedRules(base()).map((r) => r.id);

  test("a rule excluded with --rule-exclude is not locked", () => {
    const ids = cloudRuleIds();
    expect(ids.length).toBeGreaterThan(0);
    const target = ids[0]!;
    const excluded = computeLockedRules(
      base({
        partialAudit: {
          include: [],
          exclude: [target],
          includedCategories: [],
        },
      })
    );
    expect(excluded.map((r) => r.id)).not.toContain(target);
    expect(excluded.length).toBe(ids.length - 1);
  });

  test("an include filter leaves out cloud rules outside it", () => {
    const locked = computeLockedRules(
      base({
        partialAudit: {
          include: ["nothing-matches/*"],
          exclude: [],
          includedCategories: [],
        },
      })
    );
    expect(locked).toEqual([]);
  });

  test("the footer drops an excluded rule and prints for an unfiltered run", () => {
    const locked = [{ id: "perf/cloud-x", name: "X" }];
    const p = {
      include: [],
      exclude: ["perf/cloud-x"],
      includedCategories: ["core"],
    };
    expect(
      lockedRulesFooterLine({
        lockedRules: withoutFilteredLockedRules(locked, p),
      })
    ).toBeNull();
    expect(
      lockedRulesFooterLine({
        lockedRules: withoutFilteredLockedRules(locked, undefined),
      })
    ).not.toBeNull();
  });
});
