// #1599: `squirrel audit` runs rules from a plugin named in squirrel.toml, but only
// when the user's own ~/.squirrel/settings.json allowlists it. A project config
// alone never loads or runs a plugin file. Driven through the controller's runAudit
// with a stubbed site; the plugin file is a real file that is imported only when
// the allowlist says so.
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
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";
import { runAudit } from "@/controllers/audit";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { closeGlobalLinkCache } from "@/crawler/storage/link-cache";
import { getSettingsPath } from "@/self/paths";

import { fastCrawlConfig } from "../helpers/fast-crawl-config";
import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

const home = isolateSquirrelHome("squirrel-plugin-packs-1599");
const scratch = home.root;
const projectDir = join(scratch, "project");
const configPath = join(projectDir, "squirrel.toml");
// A fresh file per test: the runtime caches an imported module by path for the whole process.
let pluginPath = join(projectDir, "acme-pack-0.ts");
let pluginSeq = 0;
const markerPath = join(projectDir, "executed.marker");
const restores: (() => void)[] = [];

beforeAll(() => {
  mkdirSync(projectDir, { recursive: true });
  closeGlobalContentStore();
  closeGlobalLinkCache();
  const previousConfig = getGlobalConfigPath();
  setGlobalConfigPath(configPath);
  restores.push(() => setGlobalConfigPath(previousConfig));
});

afterAll(() => {
  closeGlobalContentStore();
  closeGlobalLinkCache();
  for (const restore of restores) restore();
});

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let stderr: string[] = [];
let restoreConsole: () => void = () => {};

beforeEach(() => {
  stderr = [];
  delete process.env.SQUIRREL_API_TOKEN;
  process.env.SQUIRREL_API_SERVER = "http://127.0.0.1:9";
  process.env.SQUIRREL_DISABLE_TELEMETRY = "1";
  process.env.SQUIRREL_NO_HOST_PINNING = "1";
  process.env.SQUIRREL_NO_UPDATE = "1";
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => {
      stderr.push(args.join(" "));
    }
  );
  restoreConsole = () => {
    log.mockRestore();
    error.mockRestore();
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "<html><head><title>t</title></head><body><h1>h</h1></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
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

/** The plugin fixture, with a line that leaves a marker file when the module is evaluated. */
function installPlugin(): void {
  pluginPath = join(projectDir, `acme-pack-${++pluginSeq}.ts`);
  copyFileSync(
    join(import.meta.dir, "../fixtures/plugins/acme-pack.ts"),
    pluginPath
  );
  const src = readFileSync(pluginPath, "utf8");
  writeFileSync(
    pluginPath,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "ran");\n${src}`
  );
}

function writeConfig(extra = ""): void {
  writeFileSync(
    configPath,
    fastCrawlConfig(
      `[plugins]\nenabled = true\n\n[[plugins.items]]\nid = "acme-pack"\nentry = "./${basename(pluginPath)}"\nallow = ["rules"]\n\n${extra}`
    )
  );
}

/** The allowlist entry that pins the current plugin file: path and content hash. */
function pin(): { id: string; entry: string; sha256: string } {
  return {
    id: "acme-pack",
    entry: realpathSync(pluginPath),
    sha256: createHash("sha256").update(readFileSync(pluginPath)).digest("hex"),
  };
}

function writeSettings(body: Record<string, unknown> | null): void {
  const path = getSettingsPath();
  if (body === null) {
    writeFileSync(path, "{}");
  } else {
    writeFileSync(path, JSON.stringify(body));
  }
}

const markerExists = () => {
  try {
    readFileSync(markerPath);
    return true;
  } catch {
    return false;
  }
};

async function audit(ruleExclude?: string[]) {
  return runAudit({
    url: "https://example.com/",
    maxPages: 1,
    coverageMode: "quick",
    offline: true,
    ruleExclude,
    configPath,
  });
}

type Report = NonNullable<
  Awaited<ReturnType<typeof runAudit>> extends infer R
    ? R extends { ok: true; data: infer D }
      ? D
      : never
    : never
>;

const pluginRule = (report: Report, id: string) =>
  (
    report.ruleResults as Record<
      string,
      {
        meta: { category: string };
        checks: { status: string; pageUrl?: string; items?: unknown[] }[];
      }
    >
  )[id];

async function okAudit(ruleExclude?: string[]): Promise<Report> {
  const result = await audit(ruleExclude);
  if (!result.ok) throw new Error(`audit failed: ${result.error.message}`);
  return result.data as Report;
}

describe("plugin rule packs through squirrel audit (#1599)", () => {
  beforeEach(() => {
    rmSync(markerPath, { force: true });
  });

  test("named in squirrel.toml and allowlisted in settings.json: the page and the site rule both report, under their own namespace", async () => {
    installPlugin();
    writeConfig();
    writeSettings({ plugin_allowlist: [pin()] });
    const report = await okAudit();
    expect(markerExists()).toBe(true);
    const page = pluginRule(report, "acme/page-title-note");
    expect(page?.meta.category).toBe("content");
    expect(
      page?.checks.some(
        (c) => c.status === "warn" && c.pageUrl === "https://example.com/"
      )
    ).toBe(true);
    const site = pluginRule(report, "acme/site-note");
    expect(site?.checks.some((c) => c.status === "warn")).toBe(true);
    // Reconstruction knew the rules: no fallback "not in the registry" meta.
    expect(stderr.join("\n")).not.toContain("not allowlisted");
  }, 60_000);

  test("the same config without the allowlist entry never imports the file and says why", async () => {
    installPlugin();
    writeConfig();
    writeSettings(null);
    const report = await okAudit();
    expect(markerExists()).toBe(false);
    expect(pluginRule(report, "acme/page-title-note")).toBeUndefined();
    expect(pluginRule(report, "acme/site-note")).toBeUndefined();
    const said = stderr.join("\n");
    expect(said).toContain('"acme-pack"');
    expect(said).toContain("not allowlisted");
    expect(said).toContain("plugin_allowlist");
  }, 60_000);

  test("a project-level .squirrel/settings.json cannot approve a plugin", async () => {
    installPlugin();
    writeConfig();
    writeSettings(null);
    mkdirSync(join(projectDir, ".squirrel"), { recursive: true });
    writeFileSync(
      join(projectDir, ".squirrel", "settings.json"),
      JSON.stringify({ plugin_allowlist: [pin()] })
    );
    const report = await okAudit();
    expect(markerExists()).toBe(false);
    expect(pluginRule(report, "acme/page-title-note")).toBeUndefined();
  }, 60_000);

  test("an allowlist entry pinned to another file does not approve this entry", async () => {
    installPlugin();
    writeConfig();
    const elsewhere = join(scratch, "elsewhere.ts");
    writeFileSync(elsewhere, "export default {};");
    writeSettings({
      plugin_allowlist: [{ ...pin(), entry: elsewhere }],
    });
    const report = await okAudit();
    expect(markerExists()).toBe(false);
    expect(pluginRule(report, "acme/page-title-note")).toBeUndefined();
    expect(stderr.join("\n")).toContain("different file");
  }, 60_000);

  test("an allowlist entry pinned to this file and hash loads it", async () => {
    installPlugin();
    writeConfig();
    writeSettings({ plugin_allowlist: [pin()] });
    const report = await okAudit();
    expect(pluginRule(report, "acme/page-title-note")).toBeDefined();
  }, 60_000);

  test("a bare id in the allowlist approves nothing: the file is not imported and the audit says how to approve", async () => {
    installPlugin();
    writeConfig();
    writeSettings({ plugin_allowlist: ["acme-pack"] });
    const report = await okAudit();
    expect(markerExists()).toBe(false);
    expect(pluginRule(report, "acme/page-title-note")).toBeUndefined();
    const said = stderr.join("\n");
    expect(said).toContain("bare id");
    expect(said).toContain("shasum -a 256");
  }, 60_000);

  test("the cloned-repo exploit: the user pinned the good file, the project config names ./evil.ts under the same id", async () => {
    installPlugin();
    const goodPin = pin();
    const evilPath = join(projectDir, "evil.ts");
    writeFileSync(
      evilPath,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "pwned");\nexport default { name: "e", version: "1", capabilities: [], register() {} };\n`
    );
    writeFileSync(
      configPath,
      `[plugins]\nenabled = true\n\n[[plugins.items]]\nid = "acme-pack"\nentry = "./evil.ts"\nallow = ["rules"]\n`
    );
    writeSettings({ plugin_allowlist: [goodPin] });
    const report = await okAudit();
    expect(markerExists()).toBe(false);
    expect(pluginRule(report, "acme/page-title-note")).toBeUndefined();
    expect(stderr.join("\n")).toContain("different file");
  }, 60_000);

  test("[plugins] enabled = false loads nothing even when allowlisted, and says so", async () => {
    installPlugin();
    writeConfig();
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(
        "enabled = true",
        "enabled = false"
      )
    );
    writeSettings({ plugin_allowlist: ["acme-pack"] });
    const report = await okAudit();
    expect(markerExists()).toBe(false);
    expect(pluginRule(report, "acme/site-note")).toBeUndefined();
    expect(stderr.join("\n")).toContain("enabled is not true");
  }, 60_000);

  test("a plugin rule id that clashes with a built-in id fails the audit naming the id", async () => {
    installPlugin();
    const src = readFileSync(pluginPath, "utf8").replace(
      "acme/site-note",
      "core/meta-title"
    );
    writeFileSync(pluginPath, src);
    writeConfig();
    writeSettings({ plugin_allowlist: [pin()] });
    const result = await audit();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('"core/meta-title"');
    expect(result.error.message).toContain("clashes with a built-in rule");
  }, 60_000);

  test("--rule-exclude of the plugin namespace suppresses its findings", async () => {
    installPlugin();
    writeConfig();
    writeSettings({ plugin_allowlist: [pin()] });
    const report = await okAudit(["acme/*"]);
    expect(pluginRule(report, "acme/page-title-note")).toBeUndefined();
    expect(pluginRule(report, "acme/site-note")).toBeUndefined();
  }, 60_000);

  test("an [[ignore]] entry waives plugin items like a built-in rule's", async () => {
    installPlugin();
    writeConfig(
      '[[ignore]]\nrule = "acme/page-title-note"\nitems = ["alpha", "beta"]\nreason = "accepted"\n'
    );
    writeSettings({ plugin_allowlist: [pin()] });
    const report = await okAudit();
    const page = pluginRule(report, "acme/page-title-note");
    expect(page?.checks.length).toBeGreaterThan(0);
    expect(page?.checks.every((c) => c.status === "pass")).toBe(true);
  }, 60_000);
});
