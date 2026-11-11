#!/usr/bin/env bun
/**
 * Rule check names by outcome class, generated onto the docs rule pages (squirrelscan/squirrelscan#1747).
 *
 * A rule declares the check names it can emit in `meta.checks`, each a `problem`, a `clean` (which names the
 * problem checks it supersedes) or a `skipped` outcome (#1741). That is what a consumer comparing two audits
 * reads to tell "fixed" from "not checked", so each declared rule's page lists it, generated from the
 * metadata so the page cannot drift from the code. A rule that has not declared its checks yet has no block.
 *
 * `--write` adds or refreshes the section `## Check names by outcome` between the markers
 *
 *     {/* rule-checks:start *\/}
 *     ...generated...
 *     {/* rule-checks:end *\/}
 *
 * on `rules/<category>/<name>.mdx`, before `## Related rules` (else `## References`, else the end of the
 * page). Text outside the markers is never touched. `--check` (run by `make validate`) exits 1 with
 * `file: message` when a declared rule has no page, a block is missing, or a block differs from what
 * `--write` produces.
 *
 * Reads the rules from the workspace (`packages/rules`), so run it from a checkout with dependencies installed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadAllRules } from "../../packages/rules/src/loader";
import type { RuleMeta } from "../../packages/rules/src/types";

const DOCS = join(import.meta.dir, "..");
const START = "{/* rule-checks:start */}";
const END = "{/* rule-checks:end */}";
const HEADING = "## Check names by outcome";

const OUTCOME_LABEL = { problem: "Problem", clean: "Clean", skipped: "Not checked" } as const;

/** The generated block for a rule, markers included. */
export function renderBlock(meta: RuleMeta): string {
  const checks = meta.checks ?? [];
  const rows = checks.map((c) => {
    const clears = c.clears?.length ? c.clears.map((n) => `\`${n}\``).join(", ") : "";
    return `| \`${c.name}\` | ${OUTCOME_LABEL[c.outcome]} | ${clears} |`;
  });
  const retired = Object.entries(meta.supersededChecks ?? {}).map(
    ([old, next]) => `- \`${old}\` is replaced by ${next.map((n) => `\`${n}\``).join(" and ")}.`,
  );
  return [
    START,
    "",
    "| Check name | Outcome | Clears |",
    "| --- | --- | --- |",
    ...rows,
    ...(retired.length > 0 ? ["", "Retired check names:", "", ...retired] : []),
    "",
    END,
  ].join("\n");
}

const SECTION_INTRO =
  "Each check name this rule can emit, by what it means to a tool comparing two audits. A **problem** check is a finding. A **clean** check says the rule ran over what it covers and found nothing; it clears the problem checks listed beside it, so a finding is fixed when the rule ran over the same scope and a clean check took its place. A **not checked** check says the rule did not evaluate, and never clears a finding.";

/** The page with its block added or refreshed. */
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
    if (!meta.checks) continue;
    const file = pagePath(meta.id);
    const rel = `rules/${meta.id}.mdx`;
    if (!existsSync(file)) {
      problems.push(`${rel}: no docs page for ${meta.id}, which declares its check names`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    const next = withBlock(text, meta);
    if (next === text) continue;
    if (write) writeFileSync(file, next);
    else problems.push(`${rel}: the check names block is missing or out of date (run: bun scripts/rule-checks.ts --write)`);
  }
  for (const p of problems) console.error(p);
  return problems.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main());
