#!/usr/bin/env bun
/**
 * WCAG success criteria, generated onto the accessibility rule pages (repo#3093).
 *
 * Every a11y rule declares `meta.wcag` (criterion number, level, WCAG version), so each page lists them
 * from that metadata and cannot drift from the code. `--write` adds or refreshes the section
 * `## WCAG success criteria` between the markers
 *
 *     {/* rule-wcag:start *\/}
 *     ...generated...
 *     {/* rule-wcag:end *\/}
 *
 * on `rules/a11y/<name>.mdx`, before `## Related rules` (else `## References`, else the end of the page).
 * Text outside the markers is never touched. `--check` (run by `make validate`) exits 1 with
 * `file: message` when an a11y rule has no page or a block is missing or out of date.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { wcagTitle } from "../../packages/core-contracts/src/wcag";
import { loadAllRules } from "../../packages/rules/src/loader";
import type { RuleMeta } from "../../packages/rules/src/types";

const DOCS = join(import.meta.dir, "..");
const START = "{/* rule-wcag:start */}";
const END = "{/* rule-wcag:end */}";
const HEADING = "## WCAG success criteria";

/** The generated block for a rule, markers included. */
export function renderBlock(meta: RuleMeta): string {
  const rows = (meta.wcag ?? []).map(
    (c) => `| ${c.sc} ${wcagTitle(c.sc) ?? ""} | ${c.level} | WCAG ${c.version} |`,
  );
  return [START, "", "| Criterion | Level | Introduced in |", "| --- | --- | --- |", ...rows, "", END].join("\n");
}

const SECTION_INTRO =
  "The WCAG success criteria this rule's findings map to. Run `squirrel audit --wcag-level AA` to keep only the accessibility rules with a criterion at Level A or AA.";

export function withBlock(text: string, meta: RuleMeta): string {
  const block = renderBlock(meta);
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start >= 0 && end > start) return text.slice(0, start) + block + text.slice(end + END.length);
  const section = `${HEADING}\n\n${SECTION_INTRO}\n\n${block}\n\n`;
  for (const anchor of ["## Related rules", "## References"]) {
    const at = text.indexOf(`\n${anchor}\n`);
    if (at >= 0) return `${text.slice(0, at + 1)}${section}${text.slice(at + 1)}`;
  }
  return `${text.replace(/\n*$/, "\n")}\n${section.replace(/\n+$/, "\n")}`;
}

export function pagePath(ruleId: string): string {
  const [category, name] = ruleId.split("/");
  return join(DOCS, "rules", category!, `${name}.mdx`);
}

function main(): number {
  const write = process.argv.includes("--write");
  const problems: string[] = [];
  for (const { meta } of loadAllRules().values()) {
    if (meta.category !== "a11y" || !meta.wcag) continue;
    const file = pagePath(meta.id);
    const rel = `rules/${meta.id}.mdx`;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      problems.push(`${rel}: no docs page for ${meta.id}`);
      continue;
    }
    const next = withBlock(text, meta);
    if (next === text) continue;
    if (write) writeFileSync(file, next);
    else problems.push(`${rel}: the WCAG block is missing or out of date (run: bun scripts/rule-wcag.ts --write)`);
  }
  for (const p of problems) console.error(p);
  return problems.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main());
