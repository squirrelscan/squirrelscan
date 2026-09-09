// #170: the startup extras — including the one-time "✓ auto-updated" notice —
// belong to the RUN, not to `audit`/`crawl`. This pins which invocations get
// them, since that is what decides whether an applied update is ever announced.

import { describe, expect, test } from "bun:test";

import { shouldRunBackgroundTasks } from "@/cli/index";

describe("shouldRunBackgroundTasks (#170)", () => {
  test.each([
    ["audit", ["audit", "https://example.com"]],
    ["crawl", ["crawl", "https://example.com"]],
    // The commands the notice used to be invisible for.
    ["analyze", ["analyze"]],
    ["auth", ["auth", "status"]],
    ["config", ["config", "get", "channel"]],
    ["credits", ["credits"]],
    ["report", ["report"]],
    ["keys", ["keys", "list"]],
    ["skills", ["skills", "install"]],
    ["self doctor", ["self", "doctor"]],
    ["self version", ["self", "version"]],
  ])("%s runs them (so an applied update is announced)", (_name, args) => {
    expect(shouldRunBackgroundTasks(args)).toBe(true);
  });

  test.each([
    ["no arguments", []],
    ["--version", ["--version"]],
    ["-v", ["-v"]],
    ["--help", ["--help"]],
    ["-h", ["audit", "-h"]],
    // JSON-RPC on stdout: nothing may pollute the stream.
    ["mcp", ["mcp"]],
    // self install resets settings; self update IS the updater.
    ["self install", ["self", "install"]],
    ["self update", ["self", "update", "--auto"]],
    ["self uninstall", ["self", "uninstall"]],
    // --offline promises zero network.
    ["--offline", ["audit", "https://example.com", "--offline"]],
  ])("%s skips them", (_name, args) => {
    expect(shouldRunBackgroundTasks(args)).toBe(false);
  });

  test("self disk is excluded: it measures what the maintenance deletes (#1912)", () => {
    // Log rotation compresses and deletes logs, and `self disk` reports the
    // size of the logs directory. Left in, the command changes the number it is
    // about to print.
    expect(shouldRunBackgroundTasks(["self", "disk"])).toBe(false);
    expect(shouldRunBackgroundTasks(["self", "disk", "--json"])).toBe(false);
    // Its siblings are unaffected.
    expect(shouldRunBackgroundTasks(["self", "doctor"])).toBe(true);
  });
});

// #2023: every invocation used to evaluate the whole CLI graph (the audit
// engine and every rule package included) before citty had even parsed argv,
// which put `squirrel self install` at ~140 MB resident and got it OOM-killed
// at the last step of install.sh. The entry now loads subcommands and the
// startup extras on demand, and the standalone build splits them into chunks
// that are neither parsed nor evaluated until imported. Both halves are
// source-level contracts: a static import quietly puts the module back on the
// hot path, and a build without --splitting still parses every chunk up front.
describe("light startup path (#2023)", () => {
  const entry = new URL("../../src/cli/index.ts", import.meta.url);
  const entrySource = () => Bun.file(entry).text();

  test("the entry imports no command statically", async () => {
    const source = await entrySource();
    const staticImports = source
      .split("\n")
      .filter((line) => /^import\b/.test(line) || line.startsWith('} from "'))
      .join("\n");
    expect(staticImports).not.toMatch(/from "\.\/commands\//);
    expect(staticImports).not.toMatch(/from "@\/cli\/commands\//);
    // The extras (updater, telemetry, registration, banner, config) ride on
    // ./startup, which is only imported when shouldRunBackgroundTasks says so.
    expect(staticImports).not.toMatch(
      /@\/self\/updater|@\/self\/telemetry|@\/self\/register-install|@\/cli\/banner|@\/config"/
    );
    expect(source).toContain('import("./startup")');
  });

  test("every subcommand is a lazy resolver", async () => {
    const source = await entrySource();
    for (const name of [
      "audit",
      "auth",
      "crawl",
      "credits",
      "analyze",
      "init",
      "config",
      "report",
      "feedback",
      "keys",
      "mcp",
      "self",
      "skills",
    ]) {
      expect(source).toContain(`${name}: () => import("./commands/${name}")`);
    }
  });

  test("the standalone build splits chunks", async () => {
    const pkg = (await Bun.file(
      new URL("../../package.json", import.meta.url)
    ).json()) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toContain("--compile --splitting");
    const makefile = await Bun.file(
      new URL("../../../../Makefile", import.meta.url)
    ).text();
    expect(makefile).toContain("--compile --splitting --minify");
  });
});
