// The CLI's own help screens: the home screen (bare `squirrel`), root and
// group help, per-command usage, and the friendly errors for a mistyped
// command or a missing argument. Replaces citty's flat renderer.
//
// The root listing is a static table so bare `squirrel` never has to load a
// command module (each one pulls in its own dependency graph). A test keeps the
// table in step with the subcommands index.ts registers.

import type { ArgsDef, CommandDef } from "citty";

import { type Theme, padVisible, visibleLength } from "./theme";

type AnyCommand = CommandDef<ArgsDef>;

export interface CommandGroup {
  title: string;
  commands: ReadonlyArray<readonly [name: string, description: string]>;
}

export const COMMAND_GROUPS: readonly CommandGroup[] = [
  {
    title: "Audits",
    commands: [
      ["audit", "Audit a website"],
      ["report", "List, view and export stored reports"],
      ["crawl", "Crawl a website without running the audit rules"],
      ["analyze", "Run the audit rules on a stored crawl"],
      ["entities", "Query the entity map of a stored audit"],
      ["init", "Create a squirrel.toml for this project"],
    ],
  },
  {
    title: "Agents",
    commands: [
      ["skills", "Install and update the squirrelscan agent skills"],
      ["mcp", "Run the local MCP server for Claude Code, Cursor and more"],
    ],
  },
  {
    title: "Cloud",
    commands: [
      ["auth", "Sign in, sign out and see who you are"],
      ["credits", "Your cloud credit balance and pricing"],
      ["keys", "Manage your org's API keys"],
    ],
  },
  {
    title: "Settings",
    commands: [
      ["setup", "Sign in, install the agent skills and pick your defaults"],
      ["config", "Show or edit squirrel.toml"],
      ["self", "Update, check and configure the squirrel CLI"],
      ["feedback", "Tell the squirrelscan team what you think"],
    ],
  },
];

/** The home-screen description of a top-level command. */
export function describeTopLevel(name: string): string | undefined {
  for (const group of COMMAND_GROUPS) {
    const hit = group.commands.find(([n]) => n === name);
    if (hit) return hit[1];
  }
  return undefined;
}

/** One runnable example per command path, shown in usage and missing-argument errors. */
export const EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  audit: [
    "squirrel audit https://example.com",
    "squirrel audit https://example.com --max-pages 50 --format llm",
  ],
  crawl: ["squirrel crawl https://example.com"],
  analyze: ["squirrel analyze"],
  report: ["squirrel report", "squirrel report --format markdown"],
  entities: ["squirrel entities --problem no-id"],
  setup: ["squirrel setup", "squirrel setup --yes"],
  "skills install": ["squirrel skills install"],
  "self completion": ["squirrel self completion zsh"],
  feedback: ['squirrel feedback "the audit missed my sitemap"'],
};

const DOCS_URL = "https://docs.squirrelscan.com";
const RULE_WIDTH = 64;

function section(t: Theme, title: string): string {
  const rule = t.dim(t.sym.rule.repeat(Math.max(3, RULE_WIDTH - title.length - 1)));
  return `${t.heading(title)} ${rule}`;
}

function rows(t: Theme, items: ReadonlyArray<readonly [string, string]>, indent = 2): string[] {
  const width = Math.max(...items.map(([name]) => visibleLength(name))) + 3;
  return items.map(([name, desc]) => `${" ".repeat(indent)}${padVisible(name, width)}${desc}`);
}

function groupLines(t: Theme): string[] {
  const width = Math.max(...COMMAND_GROUPS.flatMap((g) => g.commands.map(([n]) => n.length))) + 3;
  const out: string[] = [];
  for (const group of COMMAND_GROUPS) {
    out.push("", section(t, group.title));
    for (const [name, desc] of group.commands) {
      out.push(`  ${padVisible(t.command(name), width)}${desc}`);
    }
  }
  return out;
}

function footer(t: Theme): string[] {
  return [
    "",
    `Run ${t.command("squirrel <command> --help")} for a command's options.`,
    `${t.dim("Docs")}  ${DOCS_URL}`,
    "",
  ];
}

export interface HomeOptions {
  version: string;
  /** False until `squirrel setup` has completed once. */
  setupDone: boolean;
}

/** Bare `squirrel`: who we are, how to start, and every command by group. */
export function renderHome(t: Theme, { version, setupDone }: HomeOptions): string {
  const quick: Array<[string, string]> = [];
  if (!setupDone) quick.push([t.command("squirrel setup"), "Sign in, add the agent skills, set defaults"]);
  quick.push(
    [t.command("squirrel audit https://example.com"), "Audit a website (free, runs locally)"],
    [t.command("squirrel report"), "Look at your latest report"]
  );
  const lines = ["", t.header({ version: `v${version}` }), ""];
  lines.push(section(t, "Quick start"), ...rows(t, quick), ...groupLines(t), ...footer(t));
  return lines.join("\n");
}

/** `squirrel --help`. */
export function renderRootHelp(t: Theme, version: string): string {
  const options: Array<[string, string]> = [
    [t.command("-c, --config-file <path>"), "Use this squirrel.toml instead of the nearest one"],
    [t.command("-v, --version"), "Print the version"],
    [t.command("-h, --help"), "Show help for any command"],
  ];
  return [
    "",
    t.header({ version: `v${version}` }),
    "",
    `${t.bold("Usage")}  squirrel ${t.dim("<command> [options]")}`,
    ...groupLines(t),
    "",
    section(t, "Options"),
    ...rows(t, options),
    ...footer(t),
  ].join("\n");
}

async function resolveMeta(cmd: AnyCommand): Promise<{ name?: string; description?: string }> {
  const meta = typeof cmd.meta === "function" ? await cmd.meta() : await cmd.meta;
  return meta ?? {};
}

async function resolveArgs(cmd: AnyCommand): Promise<ArgsDef> {
  const args = typeof cmd.args === "function" ? await cmd.args() : await cmd.args;
  return (args ?? {}) as ArgsDef;
}

async function resolveSubCommands(cmd: AnyCommand): Promise<Record<string, AnyCommand>> {
  const subs = typeof cmd.subCommands === "function" ? await cmd.subCommands() : await cmd.subCommands;
  const out: Record<string, AnyCommand> = {};
  for (const [name, sub] of Object.entries(subs ?? {})) {
    out[name] = (typeof sub === "function" ? await (sub as () => Promise<AnyCommand>)() : await sub) as AnyCommand;
  }
  return out;
}

/** Argument rows, the usage-line tokens and the positional names, citty-compatible. */
async function describeArgs(t: Theme, cmd: AnyCommand) {
  const args = await resolveArgs(cmd);
  const positionals: Array<[string, string]> = [];
  const options: Array<[string, string]> = [];
  const usage: string[] = [];
  for (const [name, raw] of Object.entries(args)) {
    const arg = raw as {
      type?: string;
      alias?: string | string[];
      description?: string;
      required?: boolean;
      default?: unknown;
      valueHint?: string;
    };
    if (arg.type === "positional") {
      const required = arg.required !== false && arg.default === undefined;
      const token = required ? `<${name}>` : `[${name}]`;
      usage.push(token);
      positionals.push([t.command(token), arg.description ?? ""]);
      continue;
    }
    const aliases = arg.alias === undefined ? [] : Array.isArray(arg.alias) ? arg.alias : [arg.alias];
    const flag =
      arg.type === "boolean" && arg.default === true
        ? `--no-${name}`
        : [...aliases.map((a) => `-${a}`), `--${name}`].join(", ");
    const value = arg.type === "string" ? ` <${arg.valueHint ?? "value"}>` : "";
    const def =
      arg.default !== undefined && arg.type === "string" ? t.dim(` (default: ${String(arg.default)})`) : "";
    options.push([t.command(flag + value), (arg.description ?? "") + def]);
  }
  return { positionals, options, usage };
}

/** Help for any command below the root: a group (with subcommands) or a leaf. */
export async function renderCommandHelp(t: Theme, cmd: AnyCommand, path: string[]): Promise<string> {
  const meta = await resolveMeta(cmd);
  const full = ["squirrel", ...path].join(" ");
  const subs = await resolveSubCommands(cmd);
  const { positionals, options, usage } = await describeArgs(t, cmd);
  const description = (path.length === 1 ? describeTopLevel(path[0]!) : undefined) ?? meta.description ?? "";
  const lines = ["", `${t.heading(full)}  ${description}`, ""];

  if (Object.keys(subs).length > 0) {
    lines.push(`${t.bold("Usage")}  ${full} ${t.dim("<command> [options]")}`, "", section(t, "Commands"));
    const items: Array<[string, string]> = [];
    for (const [name, sub] of Object.entries(subs)) {
      items.push([t.command(name), (await resolveMeta(sub)).description ?? ""]);
    }
    lines.push(...rows(t, items));
    if (options.length > 0) lines.push("", section(t, "Options"), ...rows(t, options));
    lines.push("", `Run ${t.command(`${full} <command> --help`)} for a command's options.`, "");
    return lines.join("\n");
  }

  const usageTail = [...usage, options.length > 0 ? "[options]" : ""].filter(Boolean).join(" ");
  lines.push(`${t.bold("Usage")}  ${full} ${t.dim(usageTail)}`);
  if (positionals.length > 0) lines.push("", section(t, "Arguments"), ...rows(t, positionals));
  if (options.length > 0) lines.push("", section(t, "Options"), ...rows(t, options));
  const examples = EXAMPLES[path.join(" ")];
  if (examples) lines.push("", section(t, "Examples"), ...examples.map((e) => `  ${t.command(e)}`));
  lines.push("");
  return lines.join("\n");
}

/** Walk argv's positional tokens down the command tree. */
export async function resolveCommandPath(
  main: AnyCommand,
  rawArgs: string[]
): Promise<{ cmd: AnyCommand; path: string[]; rest: string[] }> {
  let cmd = main;
  const path: string[] = [];
  let rest = rawArgs;
  for (;;) {
    const subs = typeof cmd.subCommands === "function" ? await cmd.subCommands() : await cmd.subCommands;
    if (!subs || Object.keys(subs).length === 0) break;
    const index = rest.findIndex((a) => !a.startsWith("-"));
    const name = rest[index];
    if (index < 0 || name === undefined || !(name in subs)) break;
    const sub = (subs as Record<string, unknown>)[name];
    cmd = (typeof sub === "function" ? await (sub as () => Promise<AnyCommand>)() : await sub) as AnyCommand;
    path.push(name);
    rest = rest.slice(index + 1);
  }
  return { cmd, path, rest };
}

/** Optimal string alignment distance: Levenshtein plus adjacent transpositions ("audti" → "audit" = 1). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[a.length]![b.length]!;
}

/** The closest command name, if any is close enough to be a typo. */
export function suggestCommand(input: string, names: readonly string[]): string | undefined {
  const lower = input.toLowerCase();
  const prefix = names.filter((n) => n.startsWith(lower) && lower.length >= 2);
  if (prefix.length === 1) return prefix[0];
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const name of names) {
    const score = editDistance(lower, name);
    if (score < bestScore) {
      best = name;
      bestScore = score;
    }
  }
  const limit = Math.max(1, Math.floor(Math.max(lower.length, 3) / 3));
  return bestScore <= limit ? best : undefined;
}

export async function renderUnknownCommand(
  t: Theme,
  parent: AnyCommand,
  parentPath: string[],
  input: string
): Promise<string> {
  const subs = typeof parent.subCommands === "function" ? await parent.subCommands() : await parent.subCommands;
  const names = Object.keys(subs ?? {});
  const suggestion = suggestCommand(input, names);
  const scope = ["squirrel", ...parentPath].join(" ");
  const lines = [
    "",
    `${t.error(t.sym.error)} ${t.bold(`Unknown command "${input}".`)}${suggestion ? ` Did you mean ${t.command(`${scope} ${suggestion}`)}?` : ""}`,
    `  Run ${t.command(`${scope} --help`)} to see every command.`,
    "",
  ];
  return lines.join("\n");
}

export async function renderMissingArgument(
  t: Theme,
  cmd: AnyCommand,
  path: string[],
  message: string
): Promise<string> {
  const full = ["squirrel", ...path].join(" ");
  const { usage, options } = await describeArgs(t, cmd);
  // citty says "Missing required positional argument: URL" / "Missing required argument: --name".
  const what = message.replace(/^Missing required (positional )?argument:\s*/i, "").trim();
  const noun = /^(url|id|api)$/i.test(what) ? what.toUpperCase() : what.toLowerCase();
  const wanted = what.startsWith("--") ? `the ${what} option` : `${/^[aeiou]/i.test(noun) && noun !== "URL" ? "an" : "a"} ${noun}`;
  const usageTail = [...usage, options.length > 0 ? "[options]" : ""].filter(Boolean).join(" ");
  const lines = ["", `${t.error(t.sym.error)} ${t.bold(`${full} needs ${wanted}.`)}`, "", `  ${t.bold("Usage")}    ${full} ${t.dim(usageTail)}`];
  const example = EXAMPLES[path.join(" ")]?.[0];
  if (example) lines.push(`  ${t.bold("Example")}  ${t.command(example)}`);
  lines.push("", `Run ${t.command(`${full} --help`)} for every option.`, "");
  return lines.join("\n");
}
