// Audit levels: the preset table is the one definition every surface reads, so
// these tests pin it. A change to a level's value must be deliberate and shows up here.

import { describe, expect, test } from "bun:test";

import {
  AUDIT_LEVEL_PRESETS,
  AUDIT_LEVELS,
  AUDIT_MAX_PAGES,
  AUDIT_SETTING_COPY,
  AUDIT_SETTING_KEYS,
  clampAuditPages,
  crawlStrategyCoverageMode,
  effectiveAuditSettings,
  legacyCloudDepthSettings,
  levelOfSettings,
  LEGACY_CLOUD_DEPTH_PROFILES,
  parseAuditLevel,
  parseLegacyCloudDepth,
  parseResolvedAuditSettings,
  resolveAuditSettings,
} from "../src/audit-levels";
import { COVERAGE_PAGE_LIMITS } from "../src/limits";
import { PLANS } from "../src/plans";

describe("the three levels", () => {
  test("are quick, surface and full, in that order", () => {
    expect(AUDIT_LEVELS).toEqual(["quick", "surface", "full"]);
  });

  test("page budgets are the crawler's coverage page limits", () => {
    for (const level of AUDIT_LEVELS) {
      expect(AUDIT_LEVEL_PRESETS[level].pages).toBe(COVERAGE_PAGE_LIMITS[level]);
    }
    expect(AUDIT_LEVELS.map((l) => AUDIT_LEVEL_PRESETS[l].pages)).toEqual([25, 100, 500]);
  });

  test("pins every attribute of each level", () => {
    expect(AUDIT_LEVEL_PRESETS).toEqual({
      quick: {
        pages: 25,
        crawlStrategy: "seed-and-sitemap",
        cloudChecks: false,
        render: "auto",
        externalLinks: false,
        probe: "passive",
      },
      surface: {
        pages: 100,
        crawlStrategy: "sampled",
        cloudChecks: true,
        render: "all",
        externalLinks: true,
        probe: "active",
      },
      full: {
        pages: 500,
        crawlStrategy: "all",
        cloudChecks: true,
        render: "all",
        externalLinks: true,
        probe: "active",
      },
    });
  });

  test("no level defaults to aggressive probing", () => {
    for (const level of AUDIT_LEVELS)
      expect(AUDIT_LEVEL_PRESETS[level].probe).not.toBe("aggressive");
  });

  test("every level fits under every plan's page ceiling, so plans only bind a custom limit", () => {
    const smallest = Math.min(...Object.values(PLANS).map((p) => p.maxPagesPerAudit));
    for (const level of AUDIT_LEVELS) {
      expect(AUDIT_LEVEL_PRESETS[level].pages).toBeLessThanOrEqual(smallest);
    }
  });

  test("the hard ceiling is 10,000 pages", () => {
    expect(AUDIT_MAX_PAGES).toBe(10_000);
  });
});

describe("custom", () => {
  test("a level with no overrides is that level", () => {
    const r = resolveAuditSettings("surface");
    expect(r.level).toBe("surface");
    expect(r.changes).toEqual([]);
    expect(r.settings).toEqual(AUDIT_LEVEL_PRESETS.surface);
  });

  test("overrides equal to the level's own values do not make it custom", () => {
    expect(resolveAuditSettings("surface", { pages: 100, probe: "active" }).level).toBe("surface");
  });

  test("changing any setting makes it custom and names what changed, in form order", () => {
    const r = resolveAuditSettings("surface", { probe: "passive", pages: 200 });
    expect(r.level).toBe("custom");
    expect(r.basedOn).toBe("surface");
    expect(r.changes).toEqual(["pages", "probe"]);
    expect(r.settings.pages).toBe(200);
  });

  test("levelOfSettings names a preset when settings match one exactly, else custom", () => {
    expect(levelOfSettings({ ...AUDIT_LEVEL_PRESETS.full })).toBe("full");
    expect(levelOfSettings({ ...AUDIT_LEVEL_PRESETS.full, pages: 499 })).toBe("custom");
  });

  test("pages clamp to 1..10,000 and a non-finite value falls back to the default level's", () => {
    expect(clampAuditPages(0)).toBe(1);
    expect(clampAuditPages(-5)).toBe(1);
    expect(clampAuditPages(12.9)).toBe(12);
    expect(clampAuditPages(1_000_000)).toBe(10_000);
    expect(clampAuditPages(Number.NaN)).toBe(100);
    expect(clampAuditPages(Number.POSITIVE_INFINITY)).toBe(100);
    expect(resolveAuditSettings("full", { pages: 99_999 }).settings.pages).toBe(10_000);
  });
});

describe("reading a stored snapshot back", () => {
  test("a snapshot round-trips unchanged", () => {
    const custom = resolveAuditSettings("surface", { pages: 200, render: "off" });
    expect(parseResolvedAuditSettings(JSON.parse(JSON.stringify(custom)))).toEqual(custom);
    const quick = resolveAuditSettings("quick");
    expect(parseResolvedAuditSettings(quick)).toEqual(quick);
  });

  test("keeps the stored level and changes, so a later preset change does not rewrite history", () => {
    const stored = {
      level: "surface",
      basedOn: "surface",
      changes: [],
      settings: { ...AUDIT_LEVEL_PRESETS.surface, pages: 80 },
    };
    expect(parseResolvedAuditSettings(stored)).toMatchObject({
      level: "surface",
      changes: [],
      settings: { pages: 80 },
    });
  });

  test("anything that is not a snapshot is null", () => {
    for (const value of [null, undefined, "surface", 3, [], {}, { basedOn: "deep" }]) {
      expect(parseResolvedAuditSettings(value)).toBeNull();
    }
  });

  test("untrusted values never come back: bad settings fall back to the level, bad words are recomputed", () => {
    const parsed = parseResolvedAuditSettings({
      level: '"/><script>',
      basedOn: "FULL",
      changes: ["pages", "<x>", 7],
      settings: { pages: Infinity, render: "<img>", probe: "loud", cloudChecks: "yes", externalLinks: false },
    });
    expect(parsed).toEqual({
      level: "custom",
      basedOn: "full",
      changes: ["pages"],
      settings: { ...AUDIT_LEVEL_PRESETS.full, externalLinks: false },
    });
  });
});

describe("setting words", () => {
  test("every setting has a label", () => {
    expect(Object.keys(AUDIT_SETTING_COPY).sort()).toEqual([...AUDIT_SETTING_KEYS].sort());
    for (const key of AUDIT_SETTING_KEYS) expect(AUDIT_SETTING_COPY[key].label.length).toBeGreaterThan(0);
  });
});

describe("crawl strategy", () => {
  test("each level's strategy maps back to the crawler mode of the same name", () => {
    for (const level of AUDIT_LEVELS) {
      expect(crawlStrategyCoverageMode(AUDIT_LEVEL_PRESETS[level].crawlStrategy)).toBe(level);
    }
  });

  test("a custom audit crawls by its strategy, not by the level it started from", () => {
    const custom = resolveAuditSettings("quick", { crawlStrategy: "all" });
    expect(crawlStrategyCoverageMode(custom.settings.crawlStrategy)).toBe("full");
  });
});

describe("parsing", () => {
  test("accepts the three names, any case, with fast as the old name for quick", () => {
    expect(parseAuditLevel("quick")).toBe("quick");
    expect(parseAuditLevel(" Surface ")).toBe("surface");
    expect(parseAuditLevel("FULL")).toBe("full");
    expect(parseAuditLevel("fast")).toBe("quick");
  });

  test("rejects everything else instead of guessing", () => {
    for (const bad of ["", "deep", "custom", "bogus", "quick,full", "0"]) {
      expect(parseAuditLevel(bad)).toBeNull();
    }
  });
});

describe("effective settings under a plan and a balance", () => {
  test("no limits changes nothing", () => {
    const r = effectiveAuditSettings({ ...AUDIT_LEVEL_PRESETS.full });
    expect(r.settings.pages).toBe(500);
    expect(r.pagesLimitedBy).toBeNull();
  });

  test("a plan ceiling lowers a custom page limit and says so", () => {
    const r = effectiveAuditSettings(
      { ...AUDIT_LEVEL_PRESETS.full, pages: 5000 },
      { planMaxPages: 500 },
    );
    expect(r.settings.pages).toBe(500);
    expect(r.requestedPages).toBe(5000);
    expect(r.pagesLimitedBy).toBe("plan");
  });

  test("a balance that covers fewer pages lowers it further, and the balance is named", () => {
    const r = effectiveAuditSettings(
      { ...AUDIT_LEVEL_PRESETS.full },
      { planMaxPages: 500, affordablePages: 225 },
    );
    expect(r.settings.pages).toBe(225);
    expect(r.pagesLimitedBy).toBe("balance");
  });

  test("a limit above the request does not limit", () => {
    const r = effectiveAuditSettings(
      { ...AUDIT_LEVEL_PRESETS.surface },
      { planMaxPages: 500, affordablePages: 400 },
    );
    expect(r.settings.pages).toBe(100);
    expect(r.pagesLimitedBy).toBeNull();
  });

  test("a limit never takes the budget below one page", () => {
    expect(
      effectiveAuditSettings({ ...AUDIT_LEVEL_PRESETS.quick }, { affordablePages: 0 }).settings
        .pages,
    ).toBe(1);
  });

  test("a fractional limit rounds down to whole pages", () => {
    const full = { ...AUDIT_LEVEL_PRESETS.full };
    expect(effectiveAuditSettings(full, { planMaxPages: 120.7 }).settings.pages).toBe(120);
    expect(effectiveAuditSettings(full, { affordablePages: 2.9 }).settings.pages).toBe(2);
  });
});

describe("the old cloud depths", () => {
  test("each old name maps to the settings it ran with, so a migration changes nothing", () => {
    const pages = LEGACY_CLOUD_DEPTH_PROFILES.map(
      (p) => legacyCloudDepthSettings(p).settings.pages,
    );
    expect(pages).toEqual([10, 50, 250, 500]);
    expect(legacyCloudDepthSettings("deep").basedOn).toBe("surface");
    expect(legacyCloudDepthSettings("fast").basedOn).toBe("quick");
  });

  test("every old depth is custom today: none equals a level exactly", () => {
    for (const p of LEGACY_CLOUD_DEPTH_PROFILES) {
      expect(legacyCloudDepthSettings(p).level).toBe("custom");
    }
  });

  test("they all keep external links off, as the cloud did", () => {
    for (const p of LEGACY_CLOUD_DEPTH_PROFILES) {
      expect(legacyCloudDepthSettings(p).settings.externalLinks).toBe(false);
    }
  });

  test("parses the old names only", () => {
    expect(parseLegacyCloudDepth("Deep")).toBe("deep");
    expect(parseLegacyCloudDepth("quick")).toBeNull();
  });
});
