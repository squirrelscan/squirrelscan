// Shell rc-file targeting for `squirrel keys create --shell`. The CLI does not
// write to rc files anywhere else (self.ts's getShellConfig only PRINTS
// instructions) — this is the first auto-append, so it's append-only, never
// overwrites, and always shown + confirmed before writing (see cli/commands/keys.ts).

export type ShellKind = "zsh" | "bash" | "fish" | "sh";

export interface ShellRcTarget {
  shell: ShellKind;
  /** Path relative to $HOME — callers resolve the absolute path (keeps this
   * function testable without touching the real filesystem or $HOME; Bun
   * caches os.homedir() at process start, so a runtime $HOME swap in tests is
   * unreliable — see tests/self/settings.test.ts). */
  rcFile: string;
}

/**
 * Pick the rc file to append the export line to, given `$SHELL` and a
 * predicate for "does this home-relative file exist". Returns null on an
 * unsupported platform (win32 has no unix-style rc file — `--shell` isn't
 * offered there; callers fall back to printing manual instructions).
 */
export function detectShellRc(
  shellEnv: string,
  existingFiles: (relativePath: string) => boolean,
  platform: NodeJS.Platform = process.platform
): ShellRcTarget | null {
  if (platform === "win32") return null;

  if (shellEnv.includes("zsh")) {
    // .zshenv is sourced for EVERY zsh invocation (interactive or not) — the
    // right place for an exported env var. Prefer it when present; fall back
    // to .zshrc (interactive-only, but far more commonly the file that exists).
    return {
      shell: "zsh",
      rcFile: existingFiles(".zshenv") ? ".zshenv" : ".zshrc",
    };
  }
  if (shellEnv.includes("fish")) {
    return { shell: "fish", rcFile: ".config/fish/config.fish" };
  }
  if (shellEnv.includes("bash")) {
    return {
      shell: "bash",
      rcFile: existingFiles(".bashrc") ? ".bashrc" : ".bash_profile",
    };
  }
  return { shell: "sh", rcFile: ".profile" };
}

/** The trailing comment stamped on every line this command appends, so it's
 * identifiable (and greppable) later. */
export const SHELL_APPEND_MARKER = "# added by squirrel keys create";

/** Tokens are base62 today, but rc files are forever — single-quote anyway. */
function singleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Export-line for a shell rc file. Fish uses `set -gx`; everything else `export`. */
export function shellExportLine(
  shell: ShellKind,
  envVar: string,
  token: string
): string {
  const assignment =
    shell === "fish"
      ? `set -gx ${envVar} ${singleQuote(token)}`
      : `export ${envVar}=${singleQuote(token)}`;
  return `${assignment}  ${SHELL_APPEND_MARKER}`;
}

/**
 * True when the rc file already carries a line this command added (marker) or
 * any assignment of the env var — repeat `--shell` runs must not stack
 * duplicate exports, and a stale earlier export would silently win otherwise.
 */
export function rcAlreadyExports(rcContent: string, envVar: string): boolean {
  return (
    rcContent.includes(SHELL_APPEND_MARKER) ||
    rcContent.includes(`${envVar}=`) ||
    new RegExp(`set\\s+-gx\\s+${envVar}\\b`).test(rcContent)
  );
}
