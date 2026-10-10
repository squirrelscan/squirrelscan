import { describe, expect, test } from "bun:test";

import {
  AUDIT_LEVELS,
  CONFIG_MAX_PAGES_DEFAULT,
  configLevelOverrides,
  configMaxPagesChoice,
  defaultAuditLevel,
  defaultSmartAudits,
  describeAuditLevel,
  levelBannerValue,
  levelCoverageMode,
  levelHelpList,
  levelMaxPages,
  parseAuditLevel,
  readLevelFlag,
  resolveLocalAuditLevel,
  unknownLevelMessage,
} from "@/cli/audit-level";
import {
  COVERAGE_FULL_MAX_PAGES,
  COVERAGE_QUICK_MAX_PAGES,
  COVERAGE_SURFACE_MAX_PAGES,
} from "@/constants";

describe("parseAuditLevel (the shared parser)", () => {
  test("accepts the three levels", () => {
    expect(parseAuditLevel("quick")).toBe("quick");
    expect(parseAuditLevel("surface")).toBe("surface");
    expect(parseAuditLevel("full")).toBe("full");
  });

  test("aliases 'fast' to 'quick' (the bug that produced `max NaN pages`)", () => {
    expect(parseAuditLevel("fast")).toBe("quick");
    expect(parseAuditLevel("FAST")).toBe("quick");
  });

  test("is case-insensitive and trims whitespace", () => {
    expect(parseAuditLevel("  Full  ")).toBe("full");
    expect(parseAuditLevel("SURFACE")).toBe("surface");
  });

  test("returns null for anything else (caller errors instead of a NaN cap)", () => {
    expect(parseAuditLevel("turbo")).toBeNull();
    expect(parseAuditLevel("")).toBeNull();
    expect(parseAuditLevel("deep")).toBeNull();
    expect(parseAuditLevel("full,full")).toBeNull();
  });

  test("the error names the three levels", () => {
    expect(unknownLevelMessage("turbo")).toBe(
      "unknown audit level 'turbo'. Valid: quick, surface, full (fast is accepted as quick)."
    );
  });
});

describe("readLevelFlag: --level and its old name --coverage / -C", () => {
  test("either spelling, or neither", () => {
    expect(readLevelFlag({ level: "full" })).toEqual({ ok: true, raw: "full" });
    expect(readLevelFlag({ coverage: "fast" })).toEqual({
      ok: true,
      raw: "fast",
    });
    expect(readLevelFlag({})).toEqual({ ok: true, raw: undefined });
  });

  test("both at once must name the same level", () => {
    expect(readLevelFlag({ level: "quick", coverage: "fast" })).toEqual({
      ok: true,
      raw: "quick",
    });
    const conflict = readLevelFlag({ level: "full", coverage: "quick" });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error).toContain(
        "--level full and --coverage quick name different levels"
      );
    }
  });

  test("a repeated flag is refused with its own error, even when the values agree", () => {
    expect(readLevelFlag({ coverage: ["full", "full"] })).toEqual({
      ok: false,
      error:
        "--coverage was given more than once (full, full). Pass one level.",
    });
    expect(readLevelFlag({ level: ["quick", "full"] })).toEqual({
      ok: false,
      error: "--level was given more than once (quick, full). Pass one level.",
    });
  });
});

describe("levelMaxPages", () => {
  test("maps each level to its page budget", () => {
    expect(levelMaxPages("quick")).toBe(COVERAGE_QUICK_MAX_PAGES);
    expect(levelMaxPages("surface")).toBe(COVERAGE_SURFACE_MAX_PAGES);
    expect(levelMaxPages("full")).toBe(COVERAGE_FULL_MAX_PAGES);
  });

  test("returns a finite integer budget for every level", () => {
    for (const level of AUDIT_LEVELS) {
      expect(Number.isInteger(levelMaxPages(level))).toBe(true);
    }
  });
});

describe("defaultAuditLevel", () => {
  test("paid plan → surface (cloud checks + summary run)", () => {
    expect(defaultAuditLevel("paid")).toBe("surface");
  });

  test("free plan → surface (pro-parity demo #684)", () => {
    expect(defaultAuditLevel("free")).toBe("surface");
  });

  test("anonymous → quick (local rules, no account)", () => {
    expect(defaultAuditLevel("anonymous")).toBe("quick");
  });
});

describe("resolveLocalAuditLevel: level + overrides → settings and banner", () => {
  test("no overrides is the level, with the level's settings", () => {
    const quick = resolveLocalAuditLevel("quick");
    expect(quick.level).toBe("quick");
    expect(quick.settings).toEqual({
      pages: 25,
      crawlStrategy: "seed-and-sitemap",
      cloudChecks: false,
      render: "auto",
      externalLinks: false,
      probe: "passive",
    });
    expect(levelBannerValue(quick)).toBe("quick · max 25 pages");
    expect(levelBannerValue(resolveLocalAuditLevel("surface"))).toBe(
      "surface · max 100 pages"
    );
    expect(levelBannerValue(resolveLocalAuditLevel("full"))).toBe(
      "full · max 500 pages"
    );
  });

  test("an override equal to the level's value is not a change", () => {
    const resolved = resolveLocalAuditLevel("surface", {
      pages: 100,
      render: "all",
      externalLinks: true,
      probe: "active",
    });
    expect(resolved.level).toBe("surface");
    expect(levelBannerValue(resolved)).toBe("surface · max 100 pages");
  });

  test("--max-pages 200 on surface is custom, and the banner says so", () => {
    const resolved = resolveLocalAuditLevel("surface", { pages: 200 });
    expect(resolved).toMatchObject({
      level: "custom",
      basedOn: "surface",
      changes: ["pages"],
    });
    expect(resolved.settings.pages).toBe(200);
    expect(levelBannerValue(resolved)).toBe("custom (surface + max_pages 200)");
  });

  test("a change other than pages keeps the page count in the banner", () => {
    const resolved = resolveLocalAuditLevel("surface", { render: "off" });
    expect(levelBannerValue(resolved)).toBe(
      "custom (surface + render off) · max 100 pages"
    );
  });

  test("several changes are listed in settings-form order", () => {
    const resolved = resolveLocalAuditLevel("quick", {
      probe: "active",
      pages: 50,
      externalLinks: true,
    });
    expect(resolved.changes).toEqual(["pages", "externalLinks", "probe"]);
    expect(describeAuditLevel(resolved)).toBe(
      "custom (quick + max_pages 50, external_links on, probe active)"
    );
  });

  test("--pentest reads as full + aggressive probing", () => {
    const resolved = resolveLocalAuditLevel("full", { probe: "aggressive" });
    expect(levelBannerValue(resolved)).toBe(
      "custom (full + probe aggressive) · max 500 pages"
    );
  });

  test("pages are clamped to the 10,000 hard cap", () => {
    const resolved = resolveLocalAuditLevel("full", { pages: 50_000 });
    expect(resolved.settings.pages).toBe(10_000);
    expect(levelBannerValue(resolved)).toBe("custom (full + max_pages 10000)");
  });

  test("the crawler mode follows the crawl strategy", () => {
    for (const level of AUDIT_LEVELS) {
      expect(levelCoverageMode(resolveLocalAuditLevel(level))).toBe(level);
    }
    // A page override does not change how the crawl picks pages.
    expect(
      levelCoverageMode(resolveLocalAuditLevel("quick", { pages: 200 }))
    ).toBe("quick");
  });
});

describe("configMaxPagesChoice", () => {
  test("the schema default reads as unset; any other value is the config's choice", () => {
    expect(
      configMaxPagesChoice({ crawler: { max_pages: CONFIG_MAX_PAGES_DEFAULT } })
    ).toBeUndefined();
    expect(configMaxPagesChoice({ crawler: { max_pages: 40 } })).toBe(40);
  });
});

describe("configLevelOverrides", () => {
  const config = (maxPages: number, enabled: boolean) => ({
    crawler: { max_pages: maxPages },
    external_links: { enabled },
  });

  test("the schema defaults `squirrel init` writes override nothing", () => {
    expect(configLevelOverrides(config(100, true))).toEqual({});
  });

  test("another max_pages, or external links off, is a choice", () => {
    expect(configLevelOverrides(config(40, true))).toEqual({ pages: 40 });
    expect(configLevelOverrides(config(100, false))).toEqual({
      externalLinks: false,
    });
  });
});

describe("levelHelpList", () => {
  test("is built from the preset table", () => {
    expect(levelHelpList()).toBe(
      "quick (25 pages, seed and sitemaps, no cloud checks), surface (100 pages, one page per URL pattern, cloud checks), full (500 pages, every page, cloud checks)"
    );
  });
});

describe("defaultSmartAudits (#684)", () => {
  test("signed-in (free or paid, no outage) → on", () => {
    expect(defaultSmartAudits("free", null)).toBe(true);
    expect(defaultSmartAudits("paid", null)).toBe(true);
  });

  test("anonymous, no outage → off", () => {
    expect(defaultSmartAudits("anonymous", null)).toBe(false);
  });

  test("expired token → still on (local store; auth hiccup must not flip it)", () => {
    // Expired collapses accountPlan to "anonymous", but the outage proves an
    // account exists — smart audits is local SQLite and needs no cloud.
    expect(defaultSmartAudits("anonymous", "expired")).toBe(true);
  });

  test("unreachable cloud → still on for a signed-in user", () => {
    expect(defaultSmartAudits("anonymous", "unreachable")).toBe(true);
    expect(defaultSmartAudits("paid", "unreachable")).toBe(true);
  });
});
