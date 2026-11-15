import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// #1409: adapter, streaming, page-features and site-fetch must not form a
// runtime (non-type-only) import cycle. Shared helpers live in site-fetch.ts.
const SRC = join(import.meta.dir, "..", "src");
const MODULES = ["adapter", "streaming", "page-features", "site-fetch"];

async function runtimeImports(name: string): Promise<string[]> {
  const text = await Bun.file(join(SRC, `${name}.ts`)).text();
  const out: string[] = [];
  const re = /^(import|export)\s+(type\s+)?([^;]*?)\s+from\s+"\.\/([^"]+)";/gms;
  for (const m of text.matchAll(re)) {
    if (m[2]) continue;
    const braces = m[3]!.match(/^\{([\s\S]*)\}$/);
    // `import { type A, type B }` is erased at runtime.
    if (braces) {
      const names = braces[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.every((n) => n.startsWith("type "))) continue;
    }
    out.push(m[4]!);
  }
  return out;
}

describe("audit-engine runtime import cycle (#1409)", () => {
  test("no runtime cycle among adapter, streaming, page-features, site-fetch", async () => {
    const graph = new Map<string, string[]>();
    for (const m of MODULES) graph.set(m, await runtimeImports(m));

    const visiting = new Set<string>();
    const done = new Set<string>();
    const cycles: string[] = [];
    const walk = (n: string, path: string[]) => {
      if (done.has(n)) return;
      if (visiting.has(n)) {
        cycles.push([...path, n].join(" -> "));
        return;
      }
      visiting.add(n);
      for (const d of graph.get(n) ?? []) if (MODULES.includes(d)) walk(d, [...path, n]);
      visiting.delete(n);
      done.add(n);
    };
    for (const m of MODULES) walk(m, []);
    expect(cycles).toEqual([]);
  });

  test("streaming and page-features take no value imports from adapter", async () => {
    expect(await runtimeImports("streaming")).not.toContain("adapter");
    expect(await runtimeImports("page-features")).not.toContain("adapter");
  });
});
