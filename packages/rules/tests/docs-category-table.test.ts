// #172 — docs/configuration/rules.mdx lists every rule category with its
// pattern. It drifted to 18 categories once while the loader had 22; this keeps
// the table, its link targets and the stated count in step with the loader.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadAllRules } from "../src/loader";

const DOCS = join(import.meta.dir, "../../../docs");
const page = readFileSync(join(DOCS, "configuration/rules.mdx"), "utf8");
// | [Crawlability](/rules/crawl) | `crawl/*` | ... |
const ROW = /^\| \[[^\]]+\]\(\/rules\/([a-z0-9-]+)\) \| `([a-z0-9]+)\/\*` \|/gm;
const rows = [...page.matchAll(ROW)].map((m) => ({ page: m[1]!, category: m[2]! }));
const categories = new Set([...loadAllRules().values()].map((rule) => rule.meta.category));

describe("configuration/rules.mdx category table (#172)", () => {
  test("lists each loaded category once", () => {
    const listed = rows.map((r) => r.category);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...categories].sort());
  });

  test("states the category count", () => {
    expect(page).toContain(`**${categories.size} categories**`);
  });

  test("links each category to a rules page that exists", () => {
    for (const row of rows) expect(existsSync(join(DOCS, "rules", row.page, "index.mdx"))).toBe(true);
  });
});
