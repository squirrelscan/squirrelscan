#!/usr/bin/env bun
/**
 * WCAG success criteria, generated onto the rule pages of every rule that declares them (repo#3093, repo#3094).
 *
 * Every a11y rule declares either `meta.wcag` (criterion number, level, WCAG version) or `meta.wcagNone` (why it
 * maps to no criterion), so each page says which from that metadata and cannot drift from the code. `--write`
 * adds or refreshes the section `## WCAG success criteria`: the intro and the table (or the no-criterion line)
 * sit between the markers
 *
 *     {/* rule-wcag:start *\/}
 *     ...generated...
 *     {/* rule-wcag:end *\/}
 *
 * on `rules/<category>/<name>.mdx`, before `## Related rules` (else `## References`, else the end of the page).
 * The section's heading and the generated block are rewritten together; any other text is never touched.
 * `--check` (run by `make validate`) exits 1 with `file: message` when a declaring rule has no page or a block is
 * missing or out of date. Accessibility rules all declare one; images/alt-text cites 1.1.1 too.
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

const SECTION_INTRO =
  "The WCAG success criteria this rule's findings map to. These automated checks cover part of WCAG; passing them does not mean a site conforms. Run `squirrel audit --wcag-level AA` to keep only the accessibility rules mapped to a criterion at Level A or AA.";

/** The W3C Understanding page for a criterion: the slug is its title lower-cased, punctuation dropped, spaces hyphenated. */
function wcagUnderstandingUrl(sc: string): string {
  const slug = (wcagTitle(sc) ?? sc).toLowerCase().replace(/[^a-z0-9 ]/g, "").trim().replace(/ +/g, "-");
  return `https://www.w3.org/WAI/WCAG22/Understanding/${slug}.html`;
}

/** The generated block for a rule, markers included. */
export function renderBlock(meta: RuleMeta): string {
  if (meta.wcagNone !== undefined) {
    const line = `No WCAG success criterion: ${meta.wcagNone.trim()} A run narrowed with \`--wcag-level\` leaves this rule out.`;
    const related = (meta.wcagRelated ?? []).map(
      (c) => `[${c.sc} ${wcagTitle(c.sc) ?? ""}](${wcagUnderstandingUrl(c.sc)})`,
    );
    const lines = related.length > 0 ? [line, "", `Related (not tested): ${related.join(", ")}.`] : [line];
    return [START, "", ...lines, "", END].join("\n");
  }
  const rows = (meta.wcag ?? []).map(
    (c) => `| ${c.sc} ${wcagTitle(c.sc) ?? ""} | ${c.level} | WCAG ${c.version} |`,
  );
  return [START, "", SECTION_INTRO, "", "| Criterion | Level | Introduced in |", "| --- | --- | --- |", ...rows, "", END].join(
    "\n",
  );
}

export function withBlock(text: string, meta: RuleMeta): string {
  const block = renderBlock(meta);
  const section = `${HEADING}\n\n${block}`;
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start >= 0 && end > start) {
    // The heading through the end marker is generated, so a block written before the intro moved inside the
    // markers (an intro line between the heading and the start marker) is rewritten whole.
    const heading = text.lastIndexOf(`\n${HEADING}\n`, start);
    const from = heading >= 0 ? heading + 1 : start;
    const replacement = heading >= 0 ? section : block;
    return text.slice(0, from) + replacement + text.slice(end + END.length);
  }
  for (const anchor of ["## Related rules", "## References"]) {
    const at = text.indexOf(`\n${anchor}\n`);
    if (at >= 0) return `${text.slice(0, at + 1)}${section}\n\n${text.slice(at + 1)}`;
  }
  return `${text.replace(/\n*$/, "\n")}\n${section}\n`;
}

export function pagePath(ruleId: string): string {
  const [category, name] = ruleId.split("/");
  return join(DOCS, "rules", category!, `${name}.mdx`);
}

/** The rules whose page carries the block: every rule, in any category, that declares `wcag` or `wcagNone`. */
export function rulesWithWcagBlock(metas: Iterable<RuleMeta>): RuleMeta[] {
  return [...metas].filter((meta) => meta.wcag !== undefined || meta.wcagNone !== undefined);
}

function main(): number {
  const write = process.argv.includes("--write");
  const problems: string[] = [];
  for (const meta of rulesWithWcagBlock([...loadAllRules().values()].map((r) => r.meta))) {
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
