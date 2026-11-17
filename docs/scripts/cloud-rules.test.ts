import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cloudRules, costText, withNote, withTable } from "./cloud-rules";

const DOCS = join(import.meta.dir, "..");

test("every cloud rule is in the cloud rules table and has a requires-cloud note", () => {
  const rules = cloudRules();
  expect(rules.length).toBeGreaterThan(0);
  const table = readFileSync(join(DOCS, "cloud/rules.mdx"), "utf8");
  for (const m of rules) {
    expect(table).toContain(`[\`${m.id}\`](/rules/${m.id})`);
    const page = readFileSync(join(DOCS, "rules", `${m.id}.mdx`), "utf8");
    expect(page).toContain("cloud-note:start");
    expect(withNote(page, m)).toBe(page);
  }
  expect(withTable(table, rules)).toBe(table);
});

test("a rule missing from the table is detected", () => {
  const rules = cloudRules();
  const table = readFileSync(join(DOCS, "cloud/rules.mdx"), "utf8");
  const fewer = withTable(table, rules.slice(1));
  expect(fewer).not.toBe(table);
});

test("dead-links is priced as an external link check", () => {
  const dead = cloudRules().find((m) => m.id === "links/dead-links")!;
  expect(costText(dead)).toBe("1 credit per url");
});

test("the opt-in paid gap rules are listed as opt-in, with an opt-in note", () => {
  const rules = cloudRules();
  const table = readFileSync(join(DOCS, "cloud/rules.mdx"), "utf8");
  for (const id of ["gaps/keywords", "gaps/content"]) {
    const m = rules.find((r) => r.id === id);
    expect(m?.optIn).toBe(true);
    expect(costText(m!)).toBe("25 credits per run");
    expect(table).toContain(`[\`${id}\`](/rules/${id}) |`);
    expect(table).toMatch(new RegExp(`/rules/${id}\\) .*25 credits per run, opt-in \\|`));
    const page = readFileSync(join(DOCS, "rules", `${id}.mdx`), "utf8");
    expect(page).toContain(`enable = ["*", "${id}"]`);
    expect(page).not.toContain("**Cloud rule, opt-in**");
  }
});
