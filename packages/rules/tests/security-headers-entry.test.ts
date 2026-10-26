// @squirrelscan/rules/security-headers must stay loadable without the rules
// barrel: the web security headers checker imports it into a Worker, where
// linkedom, the runner and the other rules would blow the bundle. Its runtime
// import closure is the entry and the six header rule files, nothing else.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  SECURITY_HEADER_RULES,
  gradeResponseHeaders,
  hstsRule,
} from "../src/security-headers";
import { getAllRuleIds } from "../src/loader";

const SRC = join(import.meta.dir, "..", "src");
const ENTRY = join(SRC, "security-headers.ts");

/** Relative specifiers a file loads at runtime (type-only imports are erased). */
function runtimeImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  const pattern = /^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gms;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  for (const match of source.matchAll(/^import\s+"([^"]+)"/gm)) specifiers.push(match[1]!);
  return specifiers;
}

function closure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of runtimeImports(file)) {
      if (!spec.startsWith(".")) {
        throw new Error(`${relative(SRC, file)} loads ${spec} at runtime`);
      }
      queue.push(resolve(dirname(file), spec.endsWith(".ts") ? spec : `${spec}.ts`));
    }
  }
  return [...seen].map((f) => relative(SRC, f)).sort();
}

describe("@squirrelscan/rules/security-headers", () => {
  test("loads only the six header rule files at runtime", () => {
    expect(closure(ENTRY)).toEqual([
      "security-headers.ts",
      "security/csp.ts",
      "security/hsts.ts",
      "security/permissions-policy.ts",
      "security/referrer-policy.ts",
      "security/x-content-type.ts",
      "security/x-frame-options.ts",
    ]);
  });

  test("lists every header rule, each a site rule the default selection runs", () => {
    const ids = SECURITY_HEADER_RULES.map((r) => r.meta.id);
    expect(ids).toEqual([
      "security/csp",
      "security/hsts",
      "security/x-frame-options",
      "security/x-content-type",
      "security/referrer-policy",
      "security/permissions-policy",
    ]);
    const all = new Set(getAllRuleIds());
    for (const rule of SECURITY_HEADER_RULES) {
      expect([rule.meta.id, rule.meta.scope, all.has(rule.meta.id)]).toEqual([
        rule.meta.id,
        "site",
        true,
      ]);
    }
  });

  test("grades one response as the rule grades an audit's first page", () => {
    expect(
      gradeResponseHeaders(hstsRule, "https://example.com/", {
        "strict-transport-security": "max-age=31536000",
      }),
    ).toEqual(
      hstsRule.run({
        site: {
          pages: [
            {
              url: "https://example.com/",
              headers: { "strict-transport-security": "max-age=31536000" },
            },
          ],
        },
      } as never).checks,
    );
    expect(gradeResponseHeaders(hstsRule, "http://example.com/", {})[0]?.status).toBe("info");
  });
});
