// Every rule has a docs page and every docs rule page has a rule. Rule pages are
// hand-written (there is no generator), so a new rule can ship without a page and
// a renamed or removed rule can leave its page behind. A rule page declares its id
// in the metadata table: `| **Rule ID** | `crawl/robots-txt` |`. The page must
// live at docs/rules/<rule id>.mdx, because the MCP server, the dashboard and the
// blog link to docs.squirrelscan.com/rules/<rule id>.
//
// The rule set is loadKnownRules(), not loadAllRules(): disabled rules (the
// opt-in gaps/* rules, for example) are still configurable and documented.
// Category index pages and other pages without a Rule ID line are not rule pages.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadKnownRules } from "../src/loader";

interface RulePage {
  /** Path relative to the docs root, e.g. `rules/crawl/robots-txt.mdx`. */
  file: string;
  ruleId: string;
}

const DOCS = join(import.meta.dir, "../../../docs");
const RULES_DIR = join(DOCS, "rules");
// | **Rule ID** | `crawl/robots-txt` |
const RULE_ID_ROW = /^\| \*\*Rule ID\*\* \| `([^`]+)` \|\s*$/;

const ruleIds: string[] = [...loadKnownRules().keys()].sort();
const knownIds: Set<string> = new Set(ruleIds);

const rulePages: RulePage[] = [];
/** `file:line: text` for a `**Rule ID**` line the row pattern cannot read. */
const malformed: string[] = [];
/** Pages that declare more than one Rule ID. */
const multiple: string[] = [];

for (const path of [...new Bun.Glob("**/*.mdx").scanSync({ cwd: RULES_DIR })].sort()) {
  const file = `rules/${path}`;
  const lines: string[] = readFileSync(join(RULES_DIR, path), "utf8").split("\n");
  const ids: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.includes("**Rule ID**")) continue;
    const match = RULE_ID_ROW.exec(line);
    if (match) ids.push(match[1]!);
    else malformed.push(`docs/${file}:${index + 1}: ${line.trim()}`);
  }
  if (ids.length > 1) multiple.push(`docs/${file}: ${ids.join(", ")}`);
  for (const ruleId of ids) rulePages.push({ file, ruleId });
}

const pagesById: Map<string, RulePage[]> = new Map();
for (const page of rulePages) {
  pagesById.set(page.ruleId, [...(pagesById.get(page.ruleId) ?? []), page]);
}

describe("docs rule pages match the rule loader", () => {
  test("every loaded rule has a docs page with its Rule ID", () => {
    const missing: string[] = ruleIds
      .filter((id) => !pagesById.has(id))
      .map(
        (id) =>
          `${id}: no page under docs/rules declares **Rule ID** \`${id}\` (expected docs/rules/${id}.mdx)`,
      );
    expect(missing).toEqual([]);
  });

  test("every docs rule page names a rule the loader has", () => {
    const orphans: string[] = rulePages
      .filter((page) => !knownIds.has(page.ruleId))
      .map((page) => `docs/${page.file}: **Rule ID** \`${page.ruleId}\` is not a loaded rule`);
    expect(orphans).toEqual([]);
  });

  test("each rule page lives at docs/rules/<rule id>.mdx", () => {
    const misplaced: string[] = rulePages
      .filter((page) => page.file !== `rules/${page.ruleId}.mdx`)
      .map(
        (page) =>
          `docs/${page.file}: declares \`${page.ruleId}\`, expected docs/rules/${page.ruleId}.mdx`,
      );
    expect(misplaced).toEqual([]);
  });

  test("each Rule ID is declared by one page, once", () => {
    const duplicated: string[] = [...pagesById.entries()]
      .filter(([, pages]) => pages.length > 1)
      .map(([id, pages]) => `${id}: ${pages.map((page) => `docs/${page.file}`).join(", ")}`);
    expect(duplicated).toEqual([]);
    expect(multiple).toEqual([]);
  });

  test("every **Rule ID** line is a readable table row", () => {
    expect(malformed).toEqual([]);
  });

  test("rule pages and loaded rules are one to one", () => {
    expect(rulePages.length).toBeGreaterThan(0);
    expect(rulePages.length).toBe(ruleIds.length);
  });
});
