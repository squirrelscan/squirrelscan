import { loadPlugins } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";

describe("plugin manager", () => {
  test("loads allowlisted plugin and registers rules/listeners", async () => {
    const snapshot = await loadPlugins(
      [
        {
          id: "example-plugin",
          entry: new URL(
            "../fixtures/plugins/example-plugin.ts",
            import.meta.url
          ).href,
          allow: ["rules", "listeners"],
        },
      ],
      new Set(["example-plugin"])
    );

    expect(snapshot.rules.length).toBe(1);
    expect(snapshot.rules[0]?.meta.id).toBe("custom/example-rule");
    expect(snapshot.listeners.get("audit:started")?.length).toBe(1);
  });

  test("skips plugins not in allowlist", async () => {
    const snapshot = await loadPlugins(
      [
        {
          id: "example-plugin",
          entry: new URL(
            "../fixtures/plugins/example-plugin.ts",
            import.meta.url
          ).href,
          allow: ["rules", "listeners"],
        },
      ],
      new Set()
    );

    expect(snapshot.rules.length).toBe(0);
    expect(snapshot.listeners.size).toBe(0);
  });
});
