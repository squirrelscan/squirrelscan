import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeCategoryCode } from "@squirrelscan/core-contracts";
import { PUBLIC_CATEGORY_COUNT, PUBLIC_RULE_COUNT_FLOOR } from "@squirrelscan/utils/constants";

import { loadAllRules } from "../src/index";

// repo#2139: rule counts in the public docs and README were hand-copied, and the
// only guard lived in the private repo, so a rule addition could merge here with
// stale counts and nothing failed until the submodule pointer moved. This test
// runs in the public repo so the mistake is caught in the PR that makes it.
//
// Totals are advertised as a floor ("300+", PUBLIC_RULE_COUNT_FLOOR); category
// counts and per-category card counts are exact.

const REPO_ROOT = join(import.meta.dir, "../../..");
const FIX =
  "To fix: update the number in the named file (and the constant in packages/utils/src/constants.ts if needed).";

const read = (file: string): string => readFileSync(join(REPO_ROOT, file), "utf8");

const rules = [...loadAllRules().values()];
const liveTotal = rules.length;
const liveByCategory = new Map<string, number>();
for (const rule of rules) {
  liveByCategory.set(rule.meta.category, (liveByCategory.get(rule.meta.category) ?? 0) + 1);
}
const liveCategories = liveByCategory.size;

type Surface = { file: string; re: RegExp };

const TOTAL_SURFACES: Surface[] = [
  { file: "docs/rules/index.mdx", re: /\*\*(\d+)\+ rules\*\*/g },
  { file: "docs/index.mdx", re: /(\d+)\+ rules, \d+ categories/g },
  { file: "docs/index.mdx", re: /\*\*(\d+)\+ rules\*\*/g },
  { file: "docs/index.mdx", re: /\*\*Total: (\d+)\+ rules across \d+ categories\b/g },
  { file: "docs/agent-setup/index.mdx", re: /(\d+)\+ rules across SEO/g },
  { file: "README.md", re: /\*\*\[(\d+)\+ rules, \d+ categories\]/g },
  { file: "README.md", re: /\*\*Total: (\d+)\+ rules across \d+ categories\*\*/g },
];

const CATEGORY_SURFACES: Surface[] = [
  { file: "docs/rules/index.mdx", re: /\*\*(\d+) categories\*\*/g },
  { file: "docs/index.mdx", re: /\d+\+ rules, (\d+) categories/g },
  { file: "docs/index.mdx", re: /\*\*(\d+) categories\*\*/g },
  { file: "docs/index.mdx", re: /\*\*Total: \d+\+ rules across (\d+) categories\b/g },
  { file: "README.md", re: /\*\*\[\d+\+ rules, (\d+) categories\]/g },
  { file: "README.md", re: /\*\*Total: \d+\+ rules across (\d+) categories\*\*/g },
];

const numbersIn = (s: Surface): number[] =>
  [...read(s.file).matchAll(s.re)].map((m) => Number(m[1]));

describe("public rule counts match the registry (repo#2139)", () => {
  test("PUBLIC_RULE_COUNT_FLOOR is at most the live total and within 50 of it", () => {
    expect(PUBLIC_RULE_COUNT_FLOOR).toBeLessThanOrEqual(liveTotal);
    expect(liveTotal - PUBLIC_RULE_COUNT_FLOOR).toBeLessThan(50);
  });

  test("PUBLIC_CATEGORY_COUNT equals the live category count", () => {
    expect(PUBLIC_CATEGORY_COUNT).toBe(liveCategories);
  });

  for (const s of TOTAL_SURFACES) {
    test(`${s.file} ${s.re.source} states the rule floor`, () => {
      const found = numbersIn(s);
      if (found.length === 0)
        throw new Error(`${s.re} not found in ${s.file}: the copy moved; update this test.`);
      for (const n of found) {
        if (n !== PUBLIC_RULE_COUNT_FLOOR) {
          throw new Error(
            `${s.file} says ${n}+ rules, expected ${PUBLIC_RULE_COUNT_FLOOR}+ (live total ${liveTotal}). ${FIX}`,
          );
        }
      }
    });
  }

  for (const s of CATEGORY_SURFACES) {
    test(`${s.file} ${s.re.source} states the live category count`, () => {
      const found = numbersIn(s);
      if (found.length === 0)
        throw new Error(`${s.re} not found in ${s.file}: the copy moved; update this test.`);
      for (const n of found) {
        if (n !== liveCategories) {
          throw new Error(`${s.file} says ${n} categories, expected ${liveCategories}. ${FIX}`);
        }
      }
    });
  }
});

describe("docs category cards match the registry (repo#2139)", () => {
  const DIR = "docs/rules";
  // Cloud-only gap analysis has no local rules, so its card cannot be derived.
  const DOCS_ONLY = new Set(["gaps"]);
  const CARD_RE = /<Card\b[^>]*\bhref="\/rules\/([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/Card>/g;
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
    const documented = new Set(index?.cards.map((c) => normalizeCategoryCode(c.slug)));
    const owed = [...liveByCategory.keys()].filter((c) => !documented.has(c)).sort();
    expect(owed).toEqual([]);
  });

  for (const { file, cards } of pages) {
    for (const { slug, count } of cards) {
      test(`${file}: /rules/${slug} card count matches the registry`, () => {
        const code = normalizeCategoryCode(slug);
        if (count === undefined) {
          throw new Error(
            `/rules/${slug} card in ${file} has no "(N rules)" count: card format changed; update this test.`,
          );
        }
        if (DOCS_ONLY.has(code)) return;
        const live = liveByCategory.get(code);
        if (live === undefined) {
          throw new Error(
            `/rules/${slug} in ${file} maps to category "${code}" with no rules in loadAllRules(): renamed or removed category.`,
          );
        }
        if (Number(count) !== live) {
          throw new Error(
            `${file}: /rules/${slug} card says ${count} rules, registry has ${live}. ${FIX}`,
          );
        }
      });
    }
  }
});
