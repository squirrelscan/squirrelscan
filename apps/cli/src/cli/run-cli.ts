// The CLI's replacement for citty's runMain: the same dispatch (runCommand),
// with our own help screens and friendly errors in place of citty's flat usage
// dump and red "ERROR" line.
//
// - bare `squirrel`            → the home screen, exit 0
// - `--help` / `-h` anywhere   → themed help for that command, exit 0
// - a group with no command    → that group's help, exit 0 (`squirrel self`)
// - an unknown command         → "did you mean", exit 1
// - a missing argument         → the command's usage and an example, exit 1

import type { ArgsDef, CommandDef } from "citty";

import { runCommand } from "citty";

import {
  renderCommandHelp,
  renderHome,
  renderMissingArgument,
  renderRootHelp,
  renderUnknownCommand,
  resolveCommandPath,
} from "./help";
import { createTheme } from "./theme";

type AnyCommand = CommandDef<ArgsDef>;

export interface RunCliOptions {
  version: string;
  /** False until `squirrel setup` has completed once; drives the home-screen nudge. */
  setupDone: boolean;
  rawArgs?: string[];
}

/** stderr without console.error: Bun tints console.error output red when colour is forced. */
function writeErr(text: string): void {
  process.stderr.write(`${text}\n`);
}

interface CliErrorLike {
  name: string;
  code: string;
  message: string;
}

function isCliError(error: unknown): error is CliErrorLike {
  return error instanceof Error && error.name === "CLIError" && typeof (error as { code?: unknown }).code === "string";
}

async function printHelp(main: AnyCommand, rawArgs: string[], version: string): Promise<void> {
  const out = createTheme(process.stdout);
  const { cmd, path } = await resolveCommandPath(main, rawArgs.filter((a) => a !== "--help" && a !== "-h"));
  console.log(path.length === 0 ? renderRootHelp(out, version) : await renderCommandHelp(out, cmd, path));
}

export async function runCli<T extends ArgsDef>(
  command: CommandDef<T>,
  { version, setupDone, rawArgs = process.argv.slice(2) }: RunCliOptions
): Promise<void> {
  const main = command as unknown as AnyCommand;
  try {
    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      await printHelp(main, rawArgs, version);
      process.exit(0);
    }
    if (rawArgs.length === 1 && (rawArgs[0] === "--version" || rawArgs[0] === "-v")) {
      console.log(version);
      return;
    }
    // No command at all (flags such as -c alone included): the home screen.
    if (!rawArgs.some((a) => !a.startsWith("-"))) {
      console.log(renderHome(createTheme(process.stdout), { version, setupDone }));
      return;
    }
    await runCommand(main, { rawArgs });
  } catch (error) {
    if (!isCliError(error)) {
      // Same as citty's runMain: an unexpected error is printed whole and exits 1.
      console.error(error);
      process.exit(1);
    }
    const err = createTheme(process.stderr);
    const { cmd, path, rest } = await resolveCommandPath(main, rawArgs);

    if (error.code === "E_NO_COMMAND") {
      console.log(await renderCommandHelp(createTheme(process.stdout), cmd, path));
      process.exit(0);
    }
    if (error.code === "E_UNKNOWN_COMMAND") {
      const input = rest.find((a) => !a.startsWith("-")) ?? "";
      writeErr(await renderUnknownCommand(err, cmd, path, input));
      process.exit(1);
    }
    if (error.code === "EARG") {
      writeErr(await renderMissingArgument(err, cmd, path, error.message));
      process.exit(1);
    }
    writeErr(`\n${err.error(err.sym.error)} ${error.message}\n`);
    process.exit(1);
  }
}
