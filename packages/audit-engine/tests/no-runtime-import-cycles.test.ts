// #1409: ./adapter, ./streaming and ./page-features used to import each other
// at runtime (adapter -> streaming -> adapter, page-features -> adapter). That
// only resolved because no module called the other at evaluation time, so an
// innocent top-level use (a const built from an import, a `class extends`)
// would hit a TDZ / undefined binding that depends on module load order.
// The shared helpers now live in ./site-fetch. This test keeps the whole
// package's src/ free of VALUE-level cycles; type-only edges are erased at
// build time and are ignored, as are the `.d.ts`-style `import type` forms.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../src");

/** Every .ts/.tsx file under src/, as an absolute path. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const FILES = new Set(sourceFiles(SRC));

/** Resolve a relative specifier to a file in src/, or null (a package or a missing file). */
function resolveSpecifier(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (FILES.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Value-level relative imports of `file`. `import type ...` and `export type ...`
 * are erased, and so is an import whose every specifier is `type X`.
 */
export function runtimeImports(source: string, file: string): string[] {
  const edges: string[] = [];
  const pattern = /^(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/gms;
  for (const match of source.matchAll(pattern)) {
    const [, , typeOnly, clause, specifier] = match;
    if (typeOnly) continue;
    const names = clause?.match(/^\{([^}]*)\}$/s)?.[1];
    if (names !== undefined) {
      const members = names
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      if (members.length > 0 && members.every((name) => name.startsWith("type "))) continue;
    }
    const target = resolveSpecifier(file, specifier!);
    if (target) edges.push(target);
  }
  return edges;
}

/** One strongly connected component of size > 1 (or a self-import) per entry. */
function findCycles(graph: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, index.get(next)!));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      const selfImport = component.length === 1 && (graph.get(node) ?? []).includes(node);
      if (component.length > 1 || selfImport) cycles.push(component);
    }
  };

  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return cycles;
}

describe("audit-engine has no runtime import cycles (#1409)", () => {
  test("src/ value imports form no cycle", () => {
    const graph = new Map<string, string[]>();
    for (const file of FILES) graph.set(file, runtimeImports(readFileSync(file, "utf8"), file));

    const cycles = findCycles(graph).map((component) =>
      component.map((file) => relative(SRC, file)).sort(),
    );
    expect(cycles).toEqual([]);
  });

  test("the detector sees a value cycle and ignores a type-only one", () => {
    const a = join(SRC, "a.ts");
    const b = join(SRC, "b.ts");
    const value = new Map<string, string[]>([
      [a, [b]],
      [b, [a]],
    ]);
    expect(findCycles(value)).toHaveLength(1);
    const noCycle = new Map<string, string[]>([
      [a, [b]],
      [b, []],
    ]);
    expect(findCycles(noCycle)).toEqual([]);
  });

  test("type-only import forms are not runtime edges", () => {
    const file = join(SRC, "adapter.ts");
    const source = [
      'import type { A } from "./streaming";',
      'import { type B, type C } from "./page-features";',
      'export type { D } from "./streaming";',
      'import { buildSiteContext } from "./site-fetch";',
    ].join("\n");
    expect(runtimeImports(source, file).map((f) => relative(SRC, f))).toEqual(["site-fetch.ts"]);
  });
});
