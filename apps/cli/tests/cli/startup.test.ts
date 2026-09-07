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
