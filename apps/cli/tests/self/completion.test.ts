// Reconciles shell completions against the real citty command defs (#633).
// citty doesn't auto-generate completions, so completion.ts is a manual sync —
// this test fails when a flag or format list drifts.

import { describe, expect, test } from "bun:test";

import { audit } from "@/cli/commands/audit";
import { report } from "@/cli/commands/report";
import { skills } from "@/cli/commands/skills";
import { OUTPUT_FORMATS } from "@/constants";
import { generateCompletion, type Shell } from "@/self/completion";

interface ArgDef {
  type?: string;
  alias?: string | string[];
}

// citty matches camelCase arg names as kebab-case flags
const kebab = (name: string): string =>
  name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function commandFlags(cmd: { args?: unknown }): {
  flags: string[];
  aliases: Array<{ short: string; long: string }>;
} {
  // Both defs declare args as a plain object (citty's type also allows a
  // lazy/async Resolvable, which these commands don't use).
  const args = cmd.args as Record<string, ArgDef> | undefined;
  const flags: string[] = [];
  const aliases: Array<{ short: string; long: string }> = [];
  for (const [name, def] of Object.entries(args ?? {})) {
    if (def.type === "positional") continue;
    const long = kebab(name);
    flags.push(long);
    for (const a of [def.alias ?? []].flat()) {
      aliases.push({ short: a, long });
    }
  }
  return { flags, aliases };
}

const auditDef = commandFlags(audit);
const reportDef = commandFlags(report);

// Flags completion may offer beyond the def: citty's built-in --help, and
// auto-negation of boolean args (--no-incremental).
const ALLOWED_EXTRAS: Record<string, string[]> = {
  audit: ["help", "no-incremental"],
  report: ["help"],
};

const shells: Shell[] = ["bash", "zsh", "fish"];

function script(shell: Shell): string {
  const result = generateCompletion(shell);
  if (!result.ok) throw new Error(`generateCompletion(${shell}) failed`);
  return result.data;
}

// The next top-level case arm, which ends each command's bash block (the
// blocks contain nested `;;` from their prev-value cases).
const BASH_BLOCK_END: Record<string, string> = {
  audit: "crawl)",
  report: "feedback)",
};

/** Slice out the completion block for one command in a shell script. */
function commandBlock(shell: Shell, text: string, command: string): string {
  if (shell === "fish") {
    return text
      .split("\n")
      .filter((l) => l.includes(`__fish_seen_subcommand_from ${command}"`))
      .join("\n");
  }
  const start = text.indexOf(`${command})`);
  expect(start).toBeGreaterThan(-1);
  const end =
    shell === "bash"
      ? text.indexOf(BASH_BLOCK_END[command]!, start)
      : // zsh: the command's _arguments block ends at the next `;;`.
        text.indexOf(";;", start);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

/** Long flags offered by a block: `--name` in bash/zsh, `-l name` in fish. */
function longFlagsIn(shell: Shell, block: string): string[] {
  const pattern =
    shell === "fish" ? /-l ([a-z][a-z0-9-]*)/g : /--([a-z][a-z0-9-]*)/g;
  return [...new Set([...block.matchAll(pattern)].map((m) => m[1]!))];
}

function expectOffersFlag(shell: Shell, block: string, flag: string): void {
  if (shell === "fish") {
    expect(block).toMatch(new RegExp(`-l ${flag}(?![a-z0-9-])`));
  } else {
    expect(block).toMatch(new RegExp(`--${flag}(?![a-z0-9-])`));
  }
}

/** The value list a block's --format completion offers. */
function formatListIn(shell: Shell, block: string): string[] {
  let match: RegExpMatchArray | null = null;
  if (shell === "bash") {
    const start = block.indexOf("--format|-f)");
    expect(start).toBeGreaterThan(-1);
    match = block.slice(start).match(/compgen -W "([^"]+)"/);
  } else if (shell === "zsh") {
    match = block.match(/:format:\(([^)]+)\)/);
  } else {
    match = block.match(/-l format -a "([^"]+)"/);
  }
  expect(match).not.toBeNull();
  return match![1]!.split(" ");
}

describe.each(shells)("%s completion", (shell) => {
  const text = script(shell);

  describe.each([
    ["audit", auditDef],
    ["report", reportDef],
  ] as const)("%s", (command, def) => {
    const block = commandBlock(shell, text, command);

    test("every citty flag is offered", () => {
      for (const flag of def.flags) {
        expectOffersFlag(shell, block, flag);
      }
    });

    test("every citty alias is offered", () => {
      for (const { short, long } of def.aliases) {
        if (shell === "fish") {
          expect(block).toContain(`-s ${short} -l ${long}`);
        } else if (shell === "zsh") {
          expect(block).toContain(`{-${short},--${long}}`);
        } else {
          expect(block).toContain(` -${short} `);
        }
      }
    });

    test("every offered flag exists on the citty def", () => {
      const allowed = new Set([...def.flags, ...ALLOWED_EXTRAS[command]!]);
      for (const offered of longFlagsIn(shell, block)) {
        expect(allowed).toContain(offered);
      }
    });

    test("format list matches OUTPUT_FORMATS exactly", () => {
      expect(formatListIn(shell, block)).toEqual([...OUTPUT_FORMATS]);
    });
  });

  test("removed flags stay gone", () => {
    expect(text).not.toContain("storage-path");
    expect(text).not.toContain("sarif");
  });

  test("skills subcommand list matches the real citty subCommands (#783)", () => {
    const subCommands = skills.subCommands as Record<
      string,
      { meta?: { description?: string } }
    >;
    const names = Object.keys(subCommands);
    expect(names).toEqual(["install", "update"]);
    const expectedPairs = names.map((name) => {
      const description = subCommands[name]!.meta?.description;
      expect(description).toBeTruthy();
      return [name, description!] as const;
    });

    if (shell === "bash") {
      // The nested `case "${prev}" in ... skills)` arm — distinct from the
      // outer top-level `skills)` dispatch arm, which has no compgen call.
      const match = text.match(
        /skills\)\s*\n\s*COMPREPLY=\( \$\(compgen -W "([^"]+)"/
      );
      expect(match).not.toBeNull();
      expect(match![1]!.split(" ")).toEqual(names);
    } else if (shell === "zsh") {
      const start = text.indexOf("skills_commands=(");
      expect(start).toBeGreaterThan(-1);
      const block = text.slice(start, text.indexOf(")", start));
      // Full reconciliation, not just containment: an extra/stale entry
      // would slip past a `.toContain` per expected name.
      const pairs = [...block.matchAll(/'([a-z][a-z0-9-]*):([^']*)'/g)].map(
        (m) => [m[1], m[2]] as const
      );
      expect(pairs).toEqual(expectedPairs);
    } else {
      const pairs = [
        ...text.matchAll(
          /__fish_seen_subcommand_from skills;[^\n]*-a ([a-z][a-z0-9-]*) -d "([^"]*)"/g
        ),
      ].map((m) => [m[1], m[2]] as const);
      expect(pairs).toEqual(expectedPairs);
    }
  });
});
