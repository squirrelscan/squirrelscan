// #2367: grouped help, the home screen and the friendly errors.

import { describe, expect, test } from "bun:test";

import {
  COMMAND_GROUPS,
  editDistance,
  renderHome,
  renderMissingArgument,
  renderUnknownCommand,
  resolveCommandPath,
  suggestCommand,
} from "@/cli/help";
import { main } from "@/cli/index";
import { createTheme, detectColorLevel } from "@/cli/theme";

const plain = createTheme({ isTTY: false }, { LANG: "en_US.UTF-8" });

describe("COMMAND_GROUPS", () => {
  test("lists every registered top-level command exactly once", async () => {
    const subs =
      typeof main.subCommands === "function"
        ? await main.subCommands()
        : await main.subCommands;
    const registered = Object.keys(subs ?? {}).toSorted();
    const listed = COMMAND_GROUPS.flatMap((g) =>
      g.commands.map(([name]) => name)
    );
    expect(listed.toSorted()).toEqual(registered);
    expect(new Set(listed).size).toBe(listed.length);
  });
});

describe("renderHome", () => {
  test("quick start leads with setup until it has run", () => {
    const fresh = renderHome(plain, { version: "1.0.0", setupDone: false });
    const done = renderHome(plain, { version: "1.0.0", setupDone: true });
    expect(fresh).toContain("squirrel setup ");
    expect(fresh.indexOf("squirrel setup")).toBeLessThan(
      fresh.indexOf("squirrel audit https://example.com")
    );
    expect(done.split("Quick start")[1]!.split("Audits")[0]).not.toContain(
      "squirrel setup"
    );
  });

  test("uncoloured output carries no escapes", () => {
    expect(
      renderHome(plain, { version: "1.0.0", setupDone: false })
    ).not.toContain("\u001b[");
  });
});

describe("suggestCommand", () => {
  const names = ["audit", "auth", "crawl", "report", "skills", "setup", "self"];
  test.each([
    ["audti", "audit"],
    ["crwal", "crawl"],
    ["reprot", "report"],
    ["skill", "skills"],
    ["setpu", "setup"],
  ])("%s → %s", (input, expected) => {
    expect(suggestCommand(input, names)).toBe(expected);
  });

  test("nothing close enough → no suggestion", () => {
    expect(suggestCommand("deploy", names)).toBeUndefined();
  });

  test("transposition counts as one edit", () => {
    expect(editDistance("audti", "audit")).toBe(1);
  });
});

describe("errors", () => {
  test("an unknown nested command suggests the full path", async () => {
    const { cmd, path } = await resolveCommandPath(main as never, [
      "skills",
      "instal",
    ]);
    expect(path).toEqual(["skills"]);
    const out = await renderUnknownCommand(plain, cmd, path, "instal");
    expect(out).toContain(
      'Unknown command "instal". Did you mean squirrel skills install?'
    );
    expect(out).toContain("squirrel skills --help");
  });

  test("a missing URL shows usage and an example", async () => {
    const { cmd, path } = await resolveCommandPath(main as never, ["audit"]);
    const out = await renderMissingArgument(
      plain,
      cmd,
      path,
      "Missing required positional argument: URL"
    );
    expect(out).toContain("squirrel audit needs a URL.");
    expect(out).toContain("Usage    squirrel audit <url> [options]");
    expect(out).toContain("Example  squirrel audit https://example.com");
  });
});

describe("detectColorLevel", () => {
  test.each([
    [
      "NO_COLOR wins over everything",
      { NO_COLOR: "1", FORCE_COLOR: "3", COLORTERM: "truecolor" },
      true,
      0,
    ],
    ["not a TTY", {}, false, 0],
    ["FORCE_COLOR=3 without a TTY", { FORCE_COLOR: "3" }, false, 3],
    [
      "FORCE_COLOR=0 on a TTY",
      { FORCE_COLOR: "0", COLORTERM: "truecolor" },
      true,
      0,
    ],
    ["COLORTERM=truecolor", { COLORTERM: "truecolor" }, true, 3],
    ["xterm-256color", { TERM: "xterm-256color" }, true, 2],
    ["dumb terminal", { TERM: "dumb" }, true, 0],
    ["plain xterm", { TERM: "xterm" }, true, 1],
  ] as const)("%s", (_name, env, isTTY, level) => {
    expect(detectColorLevel({ isTTY }, env as NodeJS.ProcessEnv)).toBe(level);
  });
});
