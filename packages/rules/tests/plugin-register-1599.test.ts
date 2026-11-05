// #1599: `register` may be async and may fail. The loader awaits it before the
// snapshot is taken, and a throw or rejection becomes a load failure naming the
// plugin, never an unhandled rejection or a silently half-loaded pack.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPlugins, PluginLoadError } from "../src/plugins";
import type { Rule } from "../src/types";

const dir = mkdtempSync(join(tmpdir(), "squirrel-plugin-register-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The plugin sources below are constant strings: nothing computed (no id, no path) is spliced
// into the generated code. A scenario is chosen by name from a fixed table.
const PREFIX = `const rule = (id) => ({
  meta: { id, name: "n", description: "d", category: "content", scope: "page", severity: "warning", weight: 1 },
  run() { return { checks: [] }; },
});
export default { name: "p", version: "1", capabilities: ["rules"], `;
const SUFFIX = ` };
`;

const BODIES = {
  "async-ok": `async register(ctx) { await new Promise((r) => setTimeout(r, 20)); ctx.registerRule(rule("late/after-await")); }`,
  "async-reject": `async register() { await Promise.resolve(); throw new Error("boom in register"); }`,
  "sync-throw": `register() { throw new Error("sync boom"); }`,
  "async-clash": `async register(ctx) { await Promise.resolve(); ctx.registerRule(rule("core/meta-title")); }`,
  hooked: `register() { throw new Error("must not run"); }`,
} as const;

type Scenario = keyof typeof BODIES;

function pluginFile(name: Scenario): string {
  const path = join(dir, `${name}.ts`);
  writeFileSync(path, PREFIX + BODIES[name] + SUFFIX, { flag: "wx", mode: 0o600 });
  return path;
}

describe("plugin register() (#1599)", () => {
  test("an async register that registers after an await is in the snapshot", async () => {
    const entry = pluginFile("async-ok");
    const snapshot = await loadPlugins(
      [{ id: "async-ok", entry, allow: ["rules"] }],
      new Set(["async-ok"]),
    );
    expect(snapshot.rules.map((r) => r.meta.id)).toEqual(["late/after-await"]);
  });

  test("a rejecting async register fails the load naming the plugin", async () => {
    const entry = pluginFile("async-reject");
    const error = await loadPlugins(
      [{ id: "async-reject", entry, allow: ["rules"] }],
      new Set(["async-reject"]),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PluginLoadError);
    expect((error as Error).message).toContain('"async-reject"');
    expect((error as Error).message).toContain("boom in register");
  });

  test("a throwing sync register fails the load naming the plugin", async () => {
    const entry = pluginFile("sync-throw");
    const error = await loadPlugins(
      [{ id: "sync-throw", entry, allow: ["rules"] }],
      new Set(["sync-throw"]),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PluginLoadError);
    expect((error as Error).message).toContain('"sync-throw"');
    expect((error as Error).message).toContain("sync boom");
  });

  test("a registration refused after an await still names the rule and the plugin", async () => {
    const entry = pluginFile("async-clash");
    const error = await loadPlugins(
      [{ id: "async-clash", entry, allow: ["rules"] }],
      new Set(["async-clash"]),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PluginLoadError);
    expect((error as Error).message).toContain('"core/meta-title"');
  });

  test("a module that throws while it is evaluated fails the load naming the plugin", async () => {
    const path = join(dir, "eval-throw.ts");
    writeFileSync(path, `throw new Error("top-level boom");`, { flag: "wx", mode: 0o600 });
    const error = await loadPlugins(
      [{ id: "eval-throw", entry: path, allow: ["rules"] }],
      new Set(["eval-throw"]),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PluginLoadError);
    expect((error as Error).message).toContain('"eval-throw"');
    expect((error as Error).message).toContain("top-level boom");
  });

  test("an importPlugin hook replaces the default import", async () => {
    const entry = pluginFile("hooked");
    const rule = {
      meta: {
        id: "hook/ok",
        name: "n",
        description: "d",
        category: "content",
        scope: "page",
        severity: "warning",
        weight: 1,
      },
      run: () => ({ checks: [] }),
    } as unknown as Rule;
    const snapshot = await loadPlugins(
      [{ id: "hooked", entry, allow: ["rules"] }],
      new Set(["hooked"]),
      {
        importPlugin: async () => ({
          default: {
            name: "h",
            version: "1",
            capabilities: ["rules"],
            register: (ctx) => ctx.registerRule(rule),
          },
        }),
      },
    );
    expect(snapshot.rules.map((r) => r.meta.id)).toEqual(["hook/ok"]);
  });
});
