// The per-category "Rules" tables in README.md and docs/index.mdx, and the category cards on the rules
// pages (docs/rules/index.mdx and each group page), state how many rules each category has. A new rule
// that skips them leaves those counts stale in the most-read places in the repo, so this holds them to
// the live registry: a category's row or card must exist and its count must equal the number of loaded
// rules in it.
//
// The private repo's apps/api/tests/routes/rule-count-consistency.test.ts reads the same files at the
// gitlink bump. This guard fails in the public PR itself instead, and the two must never disagree: the
// same counting source (`loadAllRules()` by `meta.category`), the same card and prose parsing for the
// rules pages, and the same floor rule (`PUBLIC_RULE_COUNT_FLOOR` is the live total rounded DOWN to the
// nearest 50, so the live total is in [floor, floor + 50)).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeCategoryCode } from "@squirrelscan/core-contracts";
import { PUBLIC_CATEGORY_COUNT, PUBLIC_RULE_COUNT_FLOOR } from "@squirrelscan/utils/constants";

import { CATEGORIES } from "../src/categories";
import { loadAllRules } from "../src/loader";

const ROOT = join(import.meta.dir, "../../..");

/** Live rule count per category code, from the same registry the audit runs. */
const registry = new Map<string, number>();
for (const rule of loadAllRules().values()) {
  registry.set(rule.meta.category, (registry.get(rule.meta.category) ?? 0) + 1);
}
const total = [...registry.values()].reduce((sum, n) => sum + n, 0);

/** category display name -> code, for the categories the registry has rules in. */
const codeByName = new Map(
  [...registry.keys()].map((code) => [
    (CATEGORIES as Record<string, { name: string }>)[code]?.name ?? code,
    code,
  ]),
);

interface Table {
  /** Rows of the first table under the "Rule categories" heading: display name to stated count. */
  rows: Map<string, number>;
  text: string;
}

/** `| Crawlability | 21 | ... |` or `| **Crawlability** | 21 | ... |`, under `## Rule categories`. */
function readTable(file: string): Table {
  const text = readFileSync(join(ROOT, file), "utf8");
  const start = text.indexOf("## Rule categories");
  if (start === -1) throw new Error(`${file}: no "## Rule categories" section`);
  const section = text.slice(start);
  const rows = new Map<string, number>();
  for (const match of section.matchAll(/^\| \*{0,2}([^|*]+?)\*{0,2} \| (\d+) \|/gm)) {
    const [, name, count] = match;
    if (name === "Category") continue;
    if (rows.has(name as string)) throw new Error(`${file}: "${name}" is listed twice`);
    rows.set(name as string, Number(count));
  }
  return { rows, text: section };
}

const FILES = ["README.md", "docs/index.mdx"] as const;

describe("rule counts in README.md and docs/index.mdx", () => {
  for (const file of FILES) {
    const table = readTable(file);

    test(`${file}: every category with rules has a row, and every row is a category`, () => {
      const listed = [...table.rows.keys()].sort();
      const expected = [...codeByName.keys()].sort();
      const missing = expected.filter((name) => !table.rows.has(name));
      const unknown = listed.filter((name) => !codeByName.has(name));
      expect({ file, missing, unknown }).toEqual({ file, missing: [], unknown: [] });
    });

    test(`${file}: each category's count equals the registry's`, () => {
      const wrong: string[] = [];
      for (const [name, stated] of table.rows) {
        const code = codeByName.get(name);
        if (code === undefined) continue; // reported by the test above
        const actual = registry.get(code) ?? 0;
        if (stated !== actual) {
          wrong.push(
            `${file}: ${name} (${code}/*) says ${stated} rules, the registry has ${actual}. Update that row.`,
          );
        }
      }
      expect(wrong).toEqual([]);
    });

    test(`${file}: the rows add up to the registry's total`, () => {
      const sum = [...table.rows.values()].reduce((a, b) => a + b, 0);
      expect(`${file}: rows sum to ${sum}`).toBe(`${file}: rows sum to ${total}`);
    });
  }

  test("docs/index.mdx states the category count and the advertised floor", () => {
    const { text } = readTable("docs/index.mdx");
    expect(text).toContain(`**${codeByName.size} categories**`);
    const stated = [...text.matchAll(/\*\*(?:Total: )?(\d+)\+ rules\b/g)].map((m) => Number(m[1]));
    expect(stated.length).toBeGreaterThan(0);
    for (const floor of stated) expect(floor).toBe(PUBLIC_RULE_COUNT_FLOOR);
  });

  test("README.md states the same floor and category count, in both places it says them", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const feature = /\*\*\[(\d+)\+ rules, (\d+) categories\]/.exec(readme);
    const totalLine = /\*\*Total: (\d+)\+ rules across (\d+) categories\*\*/.exec(readme);
    for (const found of [feature, totalLine]) {
      expect(found).not.toBeNull();
      expect(Number(found?.[1])).toBe(PUBLIC_RULE_COUNT_FLOOR);
      expect(Number(found?.[2])).toBe(codeByName.size);
    }
  });

  // The same two checks the private guard makes of the constant itself.
  test("PUBLIC_RULE_COUNT_FLOOR is the live total rounded down to the nearest 50", () => {
    expect(PUBLIC_RULE_COUNT_FLOOR).toBeLessThanOrEqual(total);
    expect(total).toBeLessThan(PUBLIC_RULE_COUNT_FLOOR + 50);
  });

  test("PUBLIC_CATEGORY_COUNT matches the live category count", () => {
    expect(PUBLIC_CATEGORY_COUNT).toBe(registry.size);
  });
});

// The category cards on docs/rules/index.mdx and on each score group's overview page repeat the
// per-category counts: `<Card href="/rules/<category>">... (N rules)</Card>`. Pages are discovered by
// reading the directory, so a new group page is guarded the day it lands. The href slug is the category
// code (the renamed ones, adblock and ai, normalized), never the display title. The "Gap Analysis" card
// documents opt-in cloud gap analysis, which ships no local rules, so its count is not derived here.
describe("rules page category cards", () => {
  const RULES_DOCS_DIR = "docs/rules";
  const DOCS_ONLY_CATEGORIES = new Set(["gaps"]);
  const CARD_RE = /<Card\b[^>]*\bhref="\/rules\/([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/Card>/g;
  const COUNT_RE = /\((\d+)\s+rules\b/;

  const candidates = [
    `${RULES_DOCS_DIR}/index.mdx`,
    ...readdirSync(join(ROOT, RULES_DOCS_DIR), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${RULES_DOCS_DIR}/${entry.name}/index.mdx`)
      .sort(),
  ];
  const pages = candidates.flatMap((file) => {
    let text: string;
    try {
      text = readFileSync(join(ROOT, file), "utf8");
    } catch {
      return [];
    }
    const cards = [...text.matchAll(CARD_RE)].map(([, slug, body]) => ({
      slug: slug as string,
      code: normalizeCategoryCode(slug as string),
      count: (body as string).match(COUNT_RE)?.[1],
    }));
    return cards.length === 0 ? [] : [{ file, cards }];
  });

  test("docs/rules/index.mdx and the four group pages still parse as card pages", () => {
    const parsed = new Set(pages.map((page) => page.file));
    const missing = [
      "index.mdx",
      "seo/index.mdx",
      "performance/index.mdx",
      "security/index.mdx",
      "agents/index.mdx",
    ]
      .map((name) => `${RULES_DOCS_DIR}/${name}`)
      .filter((file) => !parsed.has(file));
    expect(missing).toEqual([]);
  });

  test("every card's count equals the registry's", () => {
    const wrong: string[] = [];
    for (const { file, cards } of pages) {
      for (const { slug, code, count } of cards) {
        if (DOCS_ONLY_CATEGORIES.has(code)) continue;
        const live = registry.get(code);
        if (count === undefined) {
          wrong.push(`${file}: the /rules/${slug} card has no "(N rules)" count`);
        } else if (live === undefined) {
          wrong.push(`${file}: /rules/${slug} maps to "${code}", which has no rules in the registry`);
        } else if (Number(count) !== live) {
          wrong.push(
            `${file}: /rules/${slug} (${code}/*) says ${count} rules, the registry has ${live}. Update that card.`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("docs/rules/index.mdx documents every category the registry has", () => {
    const page = pages.find((p) => p.file === `${RULES_DOCS_DIR}/index.mdx`);
    const documented = new Set(page?.cards.map((card) => card.code));
    const owed = [...registry.keys()].filter((code) => !documented.has(code)).sort();
    expect(owed).toEqual([]);
  });
});

// Counts the rules pages state in PROSE rather than in a card, and every other count sentence in the
// README and the docs index. The cards and the category tables are guarded above; a sentence like
// "HTTPS, headers, and safe link practices (23 rules)" under a group page's own heading was not, so
// the Security count sat one behind the registry until the private gitlink bump caught it. Listed
// rather than inferred (a bare "N rules" cannot be attributed to a category by guessing), and a SWEEP
// makes any new, unlisted count sentence fail, so a number nobody listed cannot drift silently.
describe("rule counts stated in prose", () => {
  const RULES_DOCS_DIR = "docs/rules";
  const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

  // `against` is the category code the number describes, or "total" for the whole catalog, which
  // pages state as the advertised floor ("300+"), not the exact total.
  const PROSE_COUNTS: Array<{ file: string; against: string; re: RegExp }> = [
    { file: `${RULES_DOCS_DIR}/index.mdx`, against: "total", re: /All (\d+)\+ audit rules/ },
    {
      file: `${RULES_DOCS_DIR}/index.mdx`,
      against: "total",
      // The paired bold counts ("**300+ rules** across **22 categories**") make this a whole-catalog claim.
      re: /\*\*(\d+)\+ rules\*\*\s+\S+\s+\*\*\d+ categories\*\*/,
    },
    {
      // The Security group page documents three categories as cards and its own `security/*`
      // category as a sentence under the next heading.
      file: `${RULES_DOCS_DIR}/security/index.mdx`,
      against: "security",
      re: /safe link practices \((\d+) rules\)/,
    },
  ];

  const expected = (against: string): number | undefined =>
    against === "total" ? PUBLIC_RULE_COUNT_FLOOR : registry.get(against);

  for (const { file, against, re } of PROSE_COUNTS) {
    test(`${file}: the prose count for "${against}" matches`, () => {
      const found = [...read(file).matchAll(new RegExp(re.source, "g"))];
      expect(`${file}: ${found.length} match(es) of ${re}`).toBe(`${file}: 1 match(es) of ${re}`);
      const live = expected(against);
      if (live === undefined) throw new Error(`${file}: "${against}" is not a live category or "total"`);
      expect(Number(found[0]![1])).toBe(live);
    });
  }

  // Everything that says "N rules" outside a code fence and outside a category card must be one of the
  // sentences above. Cards are removed first (their counts are the cards test's job).
  const CARD_RE = /<Card\b[^>]*\bhref="\/rules\/[a-z0-9-]+"[^>]*>[\s\S]*?<\/Card>/g;
  const FENCE_RE = /```[\s\S]*?```/g;
  const STATED_RE = /\b(\d+)\+?\s+(?:audit\s+)?rules\b/g;
  const pages = [
    `${RULES_DOCS_DIR}/index.mdx`,
    ...readdirSync(join(ROOT, RULES_DOCS_DIR), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${RULES_DOCS_DIR}/${entry.name}/index.mdx`)
      .sort(),
  ].filter((file) => {
    try {
      readFileSync(join(ROOT, file), "utf8");
      return true;
    } catch {
      return false;
    }
  });

  for (const file of pages) {
    test(`${file}: no count sentence is left unchecked`, () => {
      let rest = read(file).replace(FENCE_RE, "").replace(CARD_RE, "");
      for (const entry of PROSE_COUNTS.filter((p) => p.file === file)) {
        rest = rest.replace(new RegExp(entry.re.source), "");
      }
      const loose = [...rest.matchAll(STATED_RE)].map((m) => m[0]);
      expect(loose).toEqual([]);
    });
  }

  // The README and docs/index.mdx state the floor and the category count in running text; every one of
  // those sentences must agree with the constants, not only the two the tests above name.
  for (const file of ["README.md", "docs/index.mdx"]) {
    test(`${file}: every "N+ rules" is the advertised floor and every "N categories" the live count`, () => {
      const text = read(file).replace(FENCE_RE, "");
      const floors = [...text.matchAll(/(\d+)\+\s+rules\b/g)].map((m) => Number(m[1]));
      const categories = [...text.matchAll(/(\d+)\s+categories\b/g)].map((m) => Number(m[1]));
      expect(floors.length).toBeGreaterThan(0);
      expect(categories.length).toBeGreaterThan(0);
      for (const n of floors) expect(n).toBe(PUBLIC_RULE_COUNT_FLOOR);
      for (const n of categories) expect(n).toBe(PUBLIC_CATEGORY_COUNT);
    });
  }
});
