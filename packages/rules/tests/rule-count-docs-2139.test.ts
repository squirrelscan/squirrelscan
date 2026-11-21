import { normalizeCategoryCode } from "@squirrelscan/core-contracts";
import {
  PUBLIC_CATEGORY_COUNT,
  PUBLIC_RULE_COUNT_FLOOR,
} from "@squirrelscan/utils/constants";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadAllRules } from "../src/index";

// repo#2139: rule counts in the public docs and README were hand-copied, and the
// only guard lived in the private repo, so a rule addition could merge here with
// stale counts and nothing failed until the submodule pointer moved. This test
// runs in the public repo so the mistake is caught in the PR that makes it.
//
// Totals are advertised as a floor: the live total rounded DOWN to the nearest
// 10 ("340+" for 342 rules). The floor is derived here from the registry, never
// read from the constant under test, so a stale PUBLIC_RULE_COUNT_FLOOR fails
// too, and the guard trips the moment the live total reaches the next multiple
// of 10. Category counts and per-category card counts are exact.

const REPO_ROOT = join(import.meta.dir, "../../..");
const FIX =
  "To fix: update the number in the named file (and the constant in packages/utils/src/constants.ts if needed).";

const read = (file: string): string =>
  readFileSync(join(REPO_ROOT, file), "utf8");

const rules = [...loadAllRules().values()];
const liveTotal = rules.length;
const liveByCategory = new Map<string, number>();
for (const rule of rules) {
  liveByCategory.set(
    rule.meta.category,
    (liveByCategory.get(rule.meta.category) ?? 0) + 1
  );
}
const liveCategories = liveByCategory.size;

/** The rounding step of the advertised total. Pinned here: changing it is a copy policy change. */
const FLOOR_STEP = 10;
const advertisedFloor = Math.floor(liveTotal / FLOOR_STEP) * FLOOR_STEP;

type Surface = { file: string; re: RegExp };

const TOTAL_SURFACES: Surface[] = [
  { file: "docs/rules/index.mdx", re: /\*\*(\d+)\+ rules\*\*/g },
  { file: "docs/index.mdx", re: /(\d+)\+ rules, \d+ categories/g },
  { file: "docs/index.mdx", re: /\*\*(\d+)\+ rules\*\*/g },
  {
    file: "docs/index.mdx",
    re: /\*\*Total: (\d+)\+ rules across \d+ categories\b/g,
  },
  { file: "docs/agent-setup/index.mdx", re: /(\d+)\+ rules across SEO/g },
  { file: "docs/configuration/rules.mdx", re: /\*\*(\d+)\+ rules\*\*/g },
  { file: "README.md", re: /\*\*\[(\d+)\+ rules, \d+ categories\]/g },
  {
    file: "README.md",
    re: /\*\*Total: (\d+)\+ rules across \d+ categories\*\*/g,
  },
];

const CATEGORY_SURFACES: Surface[] = [
  { file: "docs/rules/index.mdx", re: /\*\*(\d+) categories\*\*/g },
  { file: "docs/index.mdx", re: /\d+\+ rules, (\d+) categories/g },
  { file: "docs/index.mdx", re: /\*\*(\d+) categories\*\*/g },
  {
    file: "docs/index.mdx",
    re: /\*\*Total: \d+\+ rules across (\d+) categories\b/g,
  },
  { file: "README.md", re: /\*\*\[\d+\+ rules, (\d+) categories\]/g },
  {
    file: "README.md",
    re: /\*\*Total: \d+\+ rules across (\d+) categories\*\*/g,
  },
];

const numbersIn = (s: Surface): number[] =>
  [...read(s.file).matchAll(s.re)].map((m) => Number(m[1]));

describe("public rule counts match the registry (repo#2139)", () => {
  test("PUBLIC_RULE_COUNT_FLOOR is the live total rounded down to the nearest 10", () => {
    expect(`floor ${PUBLIC_RULE_COUNT_FLOOR} (live total ${liveTotal})`).toBe(
      `floor ${advertisedFloor} (live total ${liveTotal})`
    );
  });

  test("PUBLIC_CATEGORY_COUNT equals the live category count", () => {
    expect(PUBLIC_CATEGORY_COUNT).toBe(liveCategories);
  });

  for (const s of TOTAL_SURFACES) {
    test(`${s.file} ${s.re.source} states the rule floor`, () => {
      const found = numbersIn(s);
      if (found.length === 0)
        throw new Error(
          `${s.re} not found in ${s.file}: the copy moved; update this test.`
        );
      for (const n of found) {
        if (n !== advertisedFloor) {
          throw new Error(
            `${s.file} says ${n}+ rules, expected ${advertisedFloor}+ (live total ${liveTotal}). ${FIX}`
          );
        }
      }
    });
  }

  for (const s of CATEGORY_SURFACES) {
    test(`${s.file} ${s.re.source} states the live category count`, () => {
      const found = numbersIn(s);
      if (found.length === 0)
        throw new Error(
          `${s.re} not found in ${s.file}: the copy moved; update this test.`
        );
      for (const n of found) {
        if (n !== liveCategories) {
          throw new Error(
            `${s.file} says ${n} categories, expected ${liveCategories}. ${FIX}`
          );
        }
      }
    });
  }
});

// Every "N+ rules" (or "N+ audit rules", "N+ rule catalog") in the public copy states the floor, not
// only the sentences listed above: a new page that says "300+ rules" fails here the day it lands.
describe("every rounded rule total in the public copy is the floor", () => {
  const FENCE_RE = /```[\s\S]*?```/g;
  const TOTAL_RE = /\b(\d[\d,]*)\+\s+(?:audit\s+)?rules?\b/g;
  const files = [
    "README.md",
    "AGENTS.md",
    "npm/package.json",
    ".claude-plugin/marketplace.json",
    ...[...new Bun.Glob("docs/**/*.mdx").scanSync({ cwd: REPO_ROOT })].filter(
      (file) => !file.includes("node_modules")
    ),
  ].sort();

  test("the sweep reads the docs", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  test("no file states a different rounded total", () => {
    const wrong: string[] = [];
    let seen = 0;
    for (const file of files) {
      const text = read(file).replace(FENCE_RE, "");
      for (const m of text.matchAll(TOTAL_RE)) {
        seen += 1;
        const n = Number((m[1] as string).replace(/,/g, ""));
        if (n !== advertisedFloor)
          wrong.push(`${file}: "${m[0]}", expected ${advertisedFloor}+`);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });
});

describe("docs category cards match the registry (repo#2139)", () => {
  const DIR = "docs/rules";
  // Cloud-only gap analysis has no local rules, so its card cannot be derived.
  const DOCS_ONLY = new Set(["gaps"]);
  const CARD_RE =
    /<Card\b[^>]*\bhref="\/rules\/([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/Card>/g;
  const COUNT_RE = /\((\d+)\s+rules\b/;

  const pages = [
    `${DIR}/index.mdx`,
    ...readdirSync(join(REPO_ROOT, DIR), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${DIR}/${e.name}/index.mdx`)
      .sort(),
  ].flatMap((file) => {
    let text: string;
    try {
      text = read(file);
    } catch {
      return [];
    }
    const cards = [...text.matchAll(CARD_RE)].map(([, slug, body]) => ({
      slug,
      count: body.match(COUNT_RE)?.[1],
    }));
    return cards.length === 0 ? [] : [{ file, cards }];
  });

  test("the rules index parses as an overview page with cards", () => {
    expect(pages.map((p) => p.file)).toContain(`${DIR}/index.mdx`);
  });

  test("every live category has a card on the rules index", () => {
    const index = pages.find((p) => p.file === `${DIR}/index.mdx`);
    const documented = new Set(
      index?.cards.map((c) => normalizeCategoryCode(c.slug))
    );
    const owed = [...liveByCategory.keys()]
      .filter((c) => !documented.has(c))
      .sort();
    expect(owed).toEqual([]);
  });

  for (const { file, cards } of pages) {
    for (const { slug, count } of cards) {
      test(`${file}: /rules/${slug} card count matches the registry`, () => {
        const code = normalizeCategoryCode(slug);
        if (count === undefined) {
          throw new Error(
            `/rules/${slug} card in ${file} has no "(N rules)" count: card format changed; update this test.`
          );
        }
        if (DOCS_ONLY.has(code)) return;
        const live = liveByCategory.get(code);
        if (live === undefined) {
          throw new Error(
            `/rules/${slug} in ${file} maps to category "${code}" with no rules in loadAllRules(): renamed or removed category.`
          );
        }
        if (Number(count) !== live) {
          throw new Error(
            `${file}: /rules/${slug} card says ${count} rules, registry has ${live}. ${FIX}`
          );
        }
      });
    }
  }
});
