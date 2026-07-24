// Tests for rule category utilities

import { describe, expect, test } from "bun:test";

import {
  CATEGORIES,
  CATEGORY_CODES,
  getCategoryName,
  getCategoryDescription,
  getCategoryInfo,
  getCategoryPriority,
  getCategoriesSortedByPriority,
  isValidCategory,
  type RuleCategory,
  type CategoryInfo,
} from "../../src/rules/categories";

describe("CATEGORIES", () => {
  test("contains all 23 categories", () => {
    expect(Object.keys(CATEGORIES).length).toBe(23);
  });

  test("each category has code, name, description, and priority", () => {
    for (const code of CATEGORY_CODES) {
      const info = CATEGORIES[code];
      expect(info.code).toBe(code);
      expect(typeof info.name).toBe("string");
      expect(info.name.length).toBeGreaterThan(0);
      expect(typeof info.description).toBe("string");
      expect(info.description.length).toBeGreaterThan(0);
      expect(typeof info.priority).toBe("number");
      expect(info.priority).toBeGreaterThanOrEqual(0);
      expect(info.priority).toBeLessThanOrEqual(100);
    }
  });

  test("contains expected categories", () => {
    const expectedCategories = [
      "core",
      "content",
      "links",
      "images",
      "schema",
      "security",
      "integrity",
      "a11y",
      "i18n",
      "perf",
      "ax",
      "social",
      "crawl",
      "url",
      "mobile",
      "legal",
      "local",
      "video",
      "analytics",
      "eeat",
      "blocking",
      "gaps",
      "other",
    ];

    for (const category of expectedCategories) {
      expect(category in CATEGORIES).toBe(true);
    }
  });
});

describe("CATEGORY_CODES", () => {
  test("is an array of all category codes", () => {
    expect(Array.isArray(CATEGORY_CODES)).toBe(true);
    expect(CATEGORY_CODES.length).toBe(23);
  });

  test("matches CATEGORIES keys", () => {
    const categoryKeys = Object.keys(CATEGORIES);
    for (const code of CATEGORY_CODES) {
      expect(categoryKeys).toContain(code);
    }
    for (const key of categoryKeys) {
      expect(CATEGORY_CODES).toContain(key as RuleCategory);
    }
  });
});

describe("getCategoryName", () => {
  test("returns correct name for core", () => {
    expect(getCategoryName("core")).toBe("Core SEO");
  });

  test("returns correct name for a11y", () => {
    expect(getCategoryName("a11y")).toBe("Accessibility");
  });

  test("returns correct name for perf", () => {
    expect(getCategoryName("perf")).toBe("Performance");
  });

  test("returns correct name for eeat", () => {
    expect(getCategoryName("eeat")).toBe("E-E-A-T");
  });

  test("returns correct names for all categories", () => {
    const expectedNames: Record<RuleCategory, string> = {
      core: "Core SEO",
      content: "Content",
      links: "Links",
      images: "Images",
      schema: "Structured Data",
      security: "Security",
      integrity: "Site Integrity",
      a11y: "Accessibility",
      i18n: "Internationalization",
      perf: "Performance",
      ax: "Agent Experience",
      social: "Social Media",
      crawl: "Crawlability",
      url: "URL Structure",
      mobile: "Mobile",
      legal: "Legal Compliance",
      local: "Local SEO",
      video: "Video",
      analytics: "Analytics",
      eeat: "E-E-A-T",
      blocking: "Blocking",
      gaps: "Keyword & Content Gaps",
      other: "Other",
    };

    for (const [code, name] of Object.entries(expectedNames)) {
      expect(getCategoryName(code as RuleCategory)).toBe(name);
    }
  });
});

describe("getCategoryInfo", () => {
  test("returns CategoryInfo object with all fields", () => {
    const info = getCategoryInfo("core");
    expect(info).toHaveProperty("code");
    expect(info).toHaveProperty("name");
    expect(info).toHaveProperty("description");
    expect(info).toHaveProperty("priority");
  });

  test("returns correct info for core", () => {
    const info = getCategoryInfo("core");
    expect(info.code).toBe("core");
    expect(info.name).toBe("Core SEO");
    expect(info.description).toContain("meta tags");
  });

  test("returns correct info for security", () => {
    const info = getCategoryInfo("security");
    expect(info.code).toBe("security");
    expect(info.name).toBe("Security");
    expect(info.description).toContain("HTTPS");
  });

  test("returns info for all categories", () => {
    for (const code of CATEGORY_CODES) {
      const info = getCategoryInfo(code);
      expect(info.code).toBe(code);
      expect(typeof info.name).toBe("string");
      expect(typeof info.description).toBe("string");
      expect(typeof info.priority).toBe("number");
    }
  });
});

describe("getCategoryDescription", () => {
  test("returns description for core", () => {
    const desc = getCategoryDescription("core");
    expect(desc).toContain("meta tags");
  });

  test("returns description for security", () => {
    const desc = getCategoryDescription("security");
    expect(desc).toContain("HTTPS");
  });

  test("returns description for all categories", () => {
    for (const code of CATEGORY_CODES) {
      const desc = getCategoryDescription(code);
      expect(typeof desc).toBe("string");
      expect(desc.length).toBeGreaterThan(10);
    }
  });
});

describe("isValidCategory", () => {
  test("returns true for valid categories", () => {
    expect(isValidCategory("core")).toBe(true);
    expect(isValidCategory("content")).toBe(true);
    expect(isValidCategory("security")).toBe(true);
    expect(isValidCategory("a11y")).toBe(true);
    expect(isValidCategory("perf")).toBe(true);
  });

  test("returns false for invalid categories", () => {
    expect(isValidCategory("invalid")).toBe(false);
    expect(isValidCategory("performance")).toBe(false); // old name, should be "perf"
    expect(isValidCategory("seo")).toBe(false); // not a category
    expect(isValidCategory("")).toBe(false);
    expect(isValidCategory("CORE")).toBe(false); // case sensitive
  });

  test("returns true for all CATEGORY_CODES", () => {
    for (const code of CATEGORY_CODES) {
      expect(isValidCategory(code)).toBe(true);
    }
  });
});

describe("RuleCategory type", () => {
  test("can be used as type annotation", () => {
    const category: RuleCategory = "core";
    expect(category).toBe("core");
  });

  test("category codes from CATEGORIES match RuleCategory", () => {
    // This test validates that RuleCategory is derived from CATEGORIES keys
    for (const code of Object.keys(CATEGORIES)) {
      const typed: RuleCategory = code as RuleCategory;
      expect(isValidCategory(typed)).toBe(true);
    }
  });
});

describe("CategoryInfo type", () => {
  test("can be used as type annotation", () => {
    const info: CategoryInfo = {
      code: "test",
      name: "Test Category",
      description: "A test category for unit testing",
      priority: 50,
      group: "seo",
    };
    expect(info.code).toBe("test");
    expect(info.name).toBe("Test Category");
    expect(info.description).toBe("A test category for unit testing");
    expect(info.priority).toBe(50);
  });
});

describe("getCategoryPriority", () => {
  test("returns correct priority for crawl (highest)", () => {
    expect(getCategoryPriority("crawl")).toBe(100);
  });

  test("returns correct priority for core", () => {
    expect(getCategoryPriority("core")).toBe(95);
  });

  test("returns correct priority for other (lowest)", () => {
    expect(getCategoryPriority("other")).toBe(0);
  });

  test("returns priority for all categories", () => {
    for (const code of CATEGORY_CODES) {
      const priority = getCategoryPriority(code);
      expect(typeof priority).toBe("number");
      expect(priority).toBeGreaterThanOrEqual(0);
      expect(priority).toBeLessThanOrEqual(100);
    }
  });
});

describe("getCategoriesSortedByPriority", () => {
  test("returns all categories", () => {
    const sorted = getCategoriesSortedByPriority();
    expect(sorted.length).toBe(23);
  });

  test("returns categories in descending priority order", () => {
    const sorted = getCategoriesSortedByPriority();
    for (let i = 0; i < sorted.length - 1; i++) {
      const currentPriority = getCategoryPriority(sorted[i]);
      const nextPriority = getCategoryPriority(sorted[i + 1]);
      expect(currentPriority).toBeGreaterThanOrEqual(nextPriority);
    }
  });

  test("crawl is first (highest priority)", () => {
    const sorted = getCategoriesSortedByPriority();
    expect(sorted[0]).toBe("crawl");
  });

  test("other is last (lowest priority)", () => {
    const sorted = getCategoriesSortedByPriority();
    expect(sorted[sorted.length - 1]).toBe("other");
  });
});
