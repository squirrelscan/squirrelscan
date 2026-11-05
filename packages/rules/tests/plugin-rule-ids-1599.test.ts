// #1599: a plugin rule id lives in a namespace of its own and can never replace
// or shadow a built-in rule. The checks run both for plugins loaded from a file
// and for an in-process snapshot an embedding host builds itself.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAllRuleIds, getBuiltInRuleIds, loadAllRules } from "../src/loader";
import { loadPlugins, pluginNamespaces, PluginLoadError } from "../src/plugins";
import type { Rule } from "../src/types";

const dir = mkdtempSync(join(tmpdir(), "squirrel-plugin-ids-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function rule(id: string): Rule {
  return {
    meta: {
      id,
      name: id,
      description: "plugin rule",
      category: "content",
      scope: "page",
      severity: "warning",
      weight: 1,
    },
    run: () => ({ checks: [] }),
  } as Rule;
}

function pluginFile(name: string, ids: string[]): string {
  const path = join(dir, `${name}.ts`);
  const regs = ids
    .map(
      (id) =>
        `ctx.registerRule({ meta: { id: ${JSON.stringify(id)}, name: "n", description: "d", category: "content", scope: "page", severity: "warning", weight: 1 }, run() { return { checks: [] }; } });`,
    )
    .join("\n");
  writeFileSync(
    path,
    `export default { name: "p", version: "1", capabilities: ["rules"], register(ctx) { ${regs} } };`,
  );
  return path;
}

describe("plugin rule ids (#1599)", () => {
  const builtIn = [...getBuiltInRuleIds()][0] as string;

  test("a loaded plugin rule clashing with a built-in id fails the load and names the id", async () => {
    const entry = pluginFile("clash", [builtIn]);
    await expect(
      loadPlugins([{ id: "clash", entry, allow: ["rules"] }], new Set(["clash"])),
    ).rejects.toThrow(`"${builtIn}"`);
  });

  test("a rule inside a built-in namespace is refused even when the name is new", async () => {
    const entry = pluginFile("ns", ["core/not-a-real-builtin"]);
    await expect(
      loadPlugins([{ id: "ns", entry, allow: ["rules"] }], new Set(["ns"])),
    ).rejects.toThrow(/built-in namespace "core"/);
  });

  test("a category code is not a free namespace", () => {
    for (const id of ["other/x", "a11y/x", "security/x"]) {
      expect(() => pluginNamespaces({ rules: [rule(id)] })).toThrow(PluginLoadError);
    }
  });

  test("an id without a namespace is refused", () => {
    expect(() => pluginNamespaces({ rules: [rule("noslash")] })).toThrow(PluginLoadError);
  });

  test("a rule registered without the rules capability throws instead of vanishing", async () => {
    const entry = pluginFile("nocap", ["acme/x"]);
    await expect(loadPlugins([{ id: "nocap", entry, allow: [] }], new Set(["nocap"]))).rejects.toThrow(
      /does not allow "rules"/,
    );
  });

  test("a relative entry is refused", async () => {
    await expect(
      loadPlugins([{ id: "rel", entry: "./plugin.ts", allow: ["rules"] }], new Set(["rel"])),
    ).rejects.toThrow(/absolute path/);
  });

  test("a duplicate id across a snapshot is refused", () => {
    expect(() => pluginNamespaces({ rules: [rule("acme/a"), rule("acme/a")] })).toThrow(/more than once/);
  });

  test("the loader never lets an additional namespace replace a built-in rule", () => {
    const original = loadAllRules().get(builtIn);
    expect(() => loadAllRules({ additionalNamespaces: [{ name: "evil", rules: [rule(builtIn)] }] })).toThrow(
      `"${builtIn}"`,
    );
    expect(loadAllRules().get(builtIn)).toBe(original as Rule);
  });

  test("plugin rules never reach the built-in counts", () => {
    const before = getAllRuleIds().length;
    const namespaces = pluginNamespaces({ rules: [rule("acme/a"), rule("acme/b"), rule("extra/c")] });
    expect(namespaces.map((n) => n.name)).toEqual(["acme", "extra"]);
    expect(getAllRuleIds().length).toBe(before);
    expect(loadAllRules().has("acme/a")).toBe(false);
    // Only a caller that passes the namespaces sees them.
    expect(loadAllRules({ additionalNamespaces: namespaces }).has("acme/a")).toBe(true);
  });
});
