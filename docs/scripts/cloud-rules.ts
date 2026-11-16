#!/usr/bin/env bun
/**
 * Cloud-only rules on the docs, generated from `meta.cloud` (squirrelscan/repo#3097).
 *
 * Two generated pieces, each between markers so text around them is never touched:
 *
 *  - `cloud/rules.mdx`: a table of every rule that declares `meta.cloud`, with its service, unit and
 *    credit cost, between `{/* cloud-rules:start *\/}` and `{/* cloud-rules:end *\/}`.
 *  - each of those rules' pages: a "requires cloud" note between `{/* cloud-note:start *\/}` and
 *    `{/* cloud-note:end *\/}`, right after the frontmatter. A hand-written `<Note>**Cloud rule**` line there is
 *    replaced by the generated note on the first `--write`.
 *
 * `--write` refreshes both. `--check` (run by `make validate`) exits 1 with `file: message` when a cloud rule
 * is missing from the table, has no page or note, or any block differs from what `--write` produces, so a
 * new cloud rule cannot ship undocumented. Reads the rules from the workspace, so run it with dependencies installed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CREDIT_COSTS } from "../../packages/core-contracts/src/credits";
import { loadAllRules } from "../../packages/rules/src/loader";
import type { RuleMeta } from "../../packages/rules/src/types";

const DOCS = join(import.meta.dir, "..");
const TABLE_START = "{/* cloud-rules:start */}";
const TABLE_END = "{/* cloud-rules:end */}";
const NOTE_START = "{/* cloud-note:start */}";
const NOTE_END = "{/* cloud-note:end */}";
const HEADING = "## Every cloud rule";

type CloudMeta = RuleMeta & { cloud: NonNullable<RuleMeta["cloud"]> };

const UNIT_LABEL = { page: "page", site: "site", link: "external link" } as const;

/** What the rule's credit feature costs, in words. */
export function costText(meta: CloudMeta): string {
  // An audit's external link checks bill `external_link` per destination; `dead_links` is the unbilled no-run path.
  const price = meta.cloud.creditFeature === "dead_links" ? CREDIT_COSTS.external_link : CREDIT_COSTS[meta.cloud.creditFeature];
  if (price.cost === 0) return "included in the audit base charge";
  const per = price.per === 1 ? `${price.unit}` : `${price.per} ${price.unit}s`;
  return `${price.cost} ${price.cost === 1 ? "credit" : "credits"} per ${per}`;
}

export function cloudRules(): CloudMeta[] {
  return [...loadAllRules().values()]
    .map((r) => r.meta)
    .filter((m): m is CloudMeta => m.cloud !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function renderTable(rules: CloudMeta[]): string {
  const rows = rules.map(
    (m) =>
      `| [\`${m.id}\`](/rules/${m.id}) | \`${m.cloud.service}\` | ${UNIT_LABEL[m.cloud.unit]} | ${costText(m)}${m.optIn ? ", opt-in" : ""} |`,
  );
  return [TABLE_START, "", "| Rule | Service | Unit | Cost |", "| --- | --- | --- | --- |", ...rows, "", TABLE_END].join("\n");
}

export function renderNote(meta: CloudMeta): string {
  return `${NOTE_START}\n<Note>**Requires cloud.** This rule reads the \`${meta.cloud.service}\` cloud service (per ${UNIT_LABEL[meta.cloud.unit]}; ${costText(meta)}). An offline or signed-out audit skips it and lists it under Not checked. See [Cloud rules](/cloud/rules#what-offline-audits-skip) for the skip reasons and how to run it.</Note>\n${NOTE_END}`;
}

const SECTION_INTRO =
  "Generated from each rule's `meta.cloud`, so it cannot drift from the code. A signed-out or `--offline` audit skips every rule below. Costs are what the credit table charges for the rule's service; see [Credits and pricing](/cloud/credits).";

export function withTable(text: string, rules: CloudMeta[]): string {
  const block = renderTable(rules);
  const start = text.indexOf(TABLE_START);
  const end = text.indexOf(TABLE_END);
  if (start >= 0 && end > start) return text.slice(0, start) + block + text.slice(end + TABLE_END.length);
  const section = `${HEADING}\n\n${SECTION_INTRO}\n\n${block}\n\n`;
  const at = text.indexOf("\n## How they run\n");
  if (at >= 0) return `${text.slice(0, at + 1)}${section}${text.slice(at + 1)}`;
  return `${text.replace(/\n*$/, "\n")}\n${section.replace(/\n+$/, "\n")}`;
}

export function withNote(text: string, meta: CloudMeta): string {
  const block = renderNote(meta);
  const start = text.indexOf(NOTE_START);
  const end = text.indexOf(NOTE_END);
  if (start >= 0 && end > start) return text.slice(0, start) + block + text.slice(end + NOTE_END.length);
  const legacy = text.match(/^<Note>\*\*Cloud rule\*\*.*<\/Note>$/m);
  if (legacy?.index !== undefined) return text.slice(0, legacy.index) + block + text.slice(legacy.index + legacy[0].length);
  const fm = text.match(/^---\n[\s\S]*?\n---\n/);
  const at = fm ? fm[0].length : 0;
  return `${text.slice(0, at)}\n${block}\n${text.slice(at)}`;
}

function read(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return null;
  }
}

function main(): number {
  const write = process.argv.includes("--write");
  const problems: string[] = [];
  const rules = cloudRules();

  const tableRel = "cloud/rules.mdx";
  const tableFile = join(DOCS, tableRel);
  const tableText = read(tableFile);
  if (tableText === null) problems.push(`${tableRel}: page not found`);
  else {
    const next = withTable(tableText, rules);
    if (next !== tableText) {
      if (write) writeFileSync(tableFile, next);
      else problems.push(`${tableRel}: the cloud rules table is missing or out of date (run: bun scripts/cloud-rules.ts --write)`);
    }
  }

  for (const meta of rules) {
    const rel = `rules/${meta.id}.mdx`;
    const file = join(DOCS, rel);
    const text = read(file);
    if (text === null) {
      problems.push(`${rel}: no docs page for ${meta.id}, which is a cloud rule`);
      continue;
    }
    const next = withNote(text, meta);
    if (next === text) continue;
    if (write) writeFileSync(file, next);
    else problems.push(`${rel}: the requires-cloud note is missing or out of date (run: bun scripts/cloud-rules.ts --write)`);
  }
  for (const p of problems) console.error(p);
  return problems.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main());
