// #1375: the plugin rule namespaces an audit runs with reach both the rule runner
// and `selectDiscoveryProbes`, so a plugin rule that reads a discovery probe keeps
// it under `--rule-exclude ax`. Driven through the controller's runAudit with a
// stubbed site; the assertions are on the requests that reached it.
import type { Rule } from "@squirrelscan/rules/types";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";
import { runAudit } from "@/controllers/audit";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { closeGlobalLinkCache } from "@/crawler/storage/link-cache";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

function closeGlobalStores(): void {
  closeGlobalContentStore();
  closeGlobalLinkCache();
}
const scratch = isolateSquirrelHome("squirrel-plugin-probes-1375").root;
const configPath = join(scratch, "squirrel.toml");
const restores: (() => void)[] = [];

beforeAll(() => {
  closeGlobalStores();
  const previousConfig = getGlobalConfigPath();
  setGlobalConfigPath(configPath);
  restores.push(() => setGlobalConfigPath(previousConfig));
});

afterAll(() => {
  closeGlobalStores();
  for (const restore of restores) restore();
});

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let requested: string[] = [];
let pluginRuleRuns = 0;
let restoreConsole: () => void = () => {};

beforeEach(() => {
  requested = [];
  pluginRuleRuns = 0;
  delete process.env.SQUIRREL_API_TOKEN;
  process.env.SQUIRREL_API_SERVER = "http://127.0.0.1:9";
  process.env.SQUIRREL_DISABLE_TELEMETRY = "1";
  process.env.SQUIRREL_NO_HOST_PINNING = "1";
  process.env.SQUIRREL_NO_UPDATE = "1";
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  restoreConsole = () => {
    log.mockRestore();
    error.mockRestore();
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    if (url.hostname === "example.com") requested.push(url.pathname);
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "<html><head><title>t</title></head><body><h1>h</h1></body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  restoreConsole();
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

const pluginRule: Rule = {
  meta: {
    id: "acme/openapi-owner",
    name: "OpenAPI owner",
    description: "Reads the OpenAPI probe.",
    category: "security",
    scope: "site",
    severity: "info",
    weight: 1,
    discoveryProbes: ["/openapi.json"],
  },
  run: () => {
    pluginRuleRuns++;
    return { checks: [] };
  },
};

async function audit(pluginNamespaces?: { name: string; rules: Rule[] }[]) {
  writeFileSync(configPath, "");
  await runAudit({
    url: "https://example.com/",
    maxPages: 1,
    coverageMode: "quick",
    offline: true,
    // parseRuleFilters turns `--rule-exclude ax` into `ax/*` before the controller.
    ruleExclude: ["ax/*"],
    configPath,
    ...(pluginNamespaces ? { pluginNamespaces } : {}),
  });
}

describe("plugin rule namespaces and discovery probes (#1375)", () => {
  test("control: with no plugins --rule-exclude ax keeps only the security.txt probes", async () => {
    await audit();
    expect(requested).toContain("/security.txt");
    expect(requested).not.toContain("/openapi.json");
  }, 30_000);

  test("a plugin rule that declares /openapi.json keeps it under --rule-exclude ax", async () => {
    await audit([{ name: "acme", rules: [pluginRule] }]);
    expect(requested).toContain("/openapi.json");
    expect(requested).toContain("/security.txt");
    expect(requested).not.toContain("/swagger.json");
    expect(requested).not.toContain("/AGENTS.md");
    // The same list reached the rule runner: the plugin rule ran.
    expect(pluginRuleRuns).toBe(1);
  }, 30_000);
});
