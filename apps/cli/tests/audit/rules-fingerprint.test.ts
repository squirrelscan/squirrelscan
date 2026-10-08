import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fingerprintRuleSources } from "../../src/audit/rules-fingerprint";
import { RULES_VERSION } from "../../src/audit/rules-version";

const SOURCES = ["packages/rules/src", "bun.lock"];

let roots: string[] = [];

/** A throwaway tree holding a rule file and a lockfile. */
function tree(rule: string, lock = "lock-1"): string {
  const root = mkdtempSync(join(tmpdir(), "rules-fp-"));
  roots.push(root);
  mkdirSync(join(root, "packages/rules/src/content"), { recursive: true });
  writeFileSync(join(root, "packages/rules/src/content/rule.ts"), rule);
  writeFileSync(join(root, "bun.lock"), lock);
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("rules version", () => {
  test("is the same for the same rule code", () => {
    const a = fingerprintRuleSources(tree("export const x = 1;"), SOURCES);
    const b = fingerprintRuleSources(tree("export const x = 1;"), SOURCES);
    expect(a).toBe(b);
  });

  // The case behind the fix: the rule set changed and nothing else did, so the
  // cached results for unchanged pages must stop replaying.
  test("moves when a rule's code changes", () => {
    const before = fingerprintRuleSources(tree("export const x = 1;"), SOURCES);
    const after = fingerprintRuleSources(tree("export const x = 2;"), SOURCES);
    expect(after).not.toBe(before);
  });

  test("moves when a rule file is added", () => {
    const root = tree("export const x = 1;");
    const before = fingerprintRuleSources(root, SOURCES);
    writeFileSync(join(root, "packages/rules/src/content/new-rule.ts"), "");
    expect(fingerprintRuleSources(root, SOURCES)).not.toBe(before);
  });

  test("moves when a dependency changes in the lockfile", () => {
    const before = fingerprintRuleSources(
      tree("export const x = 1;", "lock-1"),
      SOURCES
    );
    const after = fingerprintRuleSources(
      tree("export const x = 1;", "lock-2"),
      SOURCES
    );
    expect(after).not.toBe(before);
  });

  test("ignores test files under a source", () => {
    const root = tree("export const x = 1;");
    const before = fingerprintRuleSources(root, SOURCES);
    writeFileSync(join(root, "packages/rules/src/content/rule.test.ts"), "x");
    expect(fingerprintRuleSources(root, SOURCES)).toBe(before);
  });

  test("strict mode throws on a missing source", () => {
    const root = tree("export const x = 1;");
    expect(() =>
      fingerprintRuleSources(root, [...SOURCES, "packages/parser/src"], {
        strict: true,
      })
    ).toThrow(/source not found/);
    expect(() =>
      fingerprintRuleSources(root, SOURCES, { strict: true })
    ).not.toThrow();
  });

  test("is inlined as a sha-256 of this checkout", () => {
    expect(RULES_VERSION).toMatch(/^[0-9a-f]{64}$/);
    expect(RULES_VERSION).toBe(
      fingerprintRuleSources(join(import.meta.dir, "../../../.."))
    );
  });
});
