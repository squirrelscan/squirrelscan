// The local MCP audit tools resolve an audit level the same way `squirrel
// audit` does: the level's settings, the project config's choices over them,
// and the tool's own `maxPages` over those.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";
import { levelRunOptions } from "@/mcp/tools/audit-tools";

const scratch = mkdtempSync(join(tmpdir(), "squirrel-mcp-level-"));
const configPath = join(scratch, "squirrel.toml");
let previousConfig: string | undefined;

beforeAll(() => {
  previousConfig = getGlobalConfigPath();
  setGlobalConfigPath(configPath);
});

afterAll(() => {
  setGlobalConfigPath(previousConfig);
  rmSync(scratch, { recursive: true, force: true });
});

async function optionsFor(
  config: string,
  level: "quick" | "surface" | "full",
  maxPages?: number
) {
  writeFileSync(configPath, config);
  return levelRunOptions(level, maxPages);
}

describe("levelRunOptions", () => {
  test("surface with no config: the level's settings, rendering left opt-in", async () => {
    const options = await optionsFor("", "surface");
    expect(options).toMatchObject({
      coverageMode: "surface",
      maxPages: 100,
      externalLinksEnabled: true,
      probe: { level: "active", budgetMs: 30_000 },
      renderStrategy: "all",
    });
    expect(options.auditLevel?.level).toBe("surface");
    expect(options.cloudRendering).toBeUndefined();
  });

  test("quick: passive, no external links", async () => {
    const options = await optionsFor("", "quick");
    expect(options).toMatchObject({
      coverageMode: "quick",
      maxPages: 25,
      externalLinksEnabled: false,
      probe: { level: "passive", budgetMs: 0 },
    });
  });

  test("[crawler] max_pages is honoured, and the tool's maxPages beats it", async () => {
    const fromConfig = await optionsFor(
      "[crawler]\nmax_pages = 7\n",
      "surface"
    );
    expect(fromConfig.maxPages).toBe(7);
    expect(fromConfig.auditLevel).toMatchObject({
      level: "custom",
      changes: ["pages"],
    });
    const fromTool = await optionsFor(
      "[crawler]\nmax_pages = 7\n",
      "surface",
      3
    );
    expect(fromTool.maxPages).toBe(3);
  });

  test("the defaults `squirrel init` writes leave the level alone", async () => {
    const options = await optionsFor(
      "[crawler]\nmax_pages = 100\n\n[external_links]\nenabled = true\n",
      "quick"
    );
    expect(options.auditLevel?.level).toBe("quick");
    expect(options.maxPages).toBe(25);
  });

  test("a configured render setting is the fetch mode, so the report matches what ran", async () => {
    const off = await optionsFor(
      '[cloud]\nrender = "off"\nrendering = "browser"\n',
      "surface"
    );
    expect(off.cloudRendering).toBe("http");
    expect(off.auditLevel?.settings.render).toBe("off");
    const all = await optionsFor('[cloud]\nrender = "all"\n', "quick");
    expect(all.cloudRendering).toBe("browser");
    expect(all.renderStrategy).toBe("all");
  });
});
