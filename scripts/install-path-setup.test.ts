// install.sh PATH setup: pick a writable directory that is already on PATH,
// otherwise append one marked line to the shell's startup file, and print a
// closing message whose first command works in the current shell.
//
// SAFETY: every run uses a fresh temp HOME (plus ZDOTDIR / XDG_CONFIG_HOME
// pinned inside it) and an explicit PATH. Nothing here may touch the real
// profile files of whoever runs the suite.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shellInstaller = await Bun.file(new URL("../install.sh", import.meta.url)).text();
const powershellInstaller = await Bun.file(new URL("../install.ps1", import.meta.url)).text();
const INSTALLER_BODY = shellInstaller.slice(0, shellInstaller.lastIndexOf('\nmain "$@"'));

type Run = { stdout: string; stderr: string; code: number; home: string };

/** Runs `script` after sourcing install.sh as a library, in a throwaway HOME. */
async function run(
  script: string,
  {
    env = {},
    uname = "Linux",
    setup,
  }: {
    env?: Record<string, string | undefined>;
    uname?: "Linux" | "Darwin";
    /** Prepare the temp HOME before the script runs. */
    setup?: (home: string) => void;
  } = {},
): Promise<Run> {
  const root = mkdtempSync(join(tmpdir(), "install-path-setup-"));
  const home = join(root, "home");
  const shims = join(root, "shims");
  mkdirSync(home, { recursive: true });
  mkdirSync(shims, { recursive: true });
  const unameShim = join(shims, "uname");
  writeFileSync(unameShim, `#!/bin/sh\necho ${uname}\n`, { mode: 0o755 });
  const sourced = join(root, "installer.sh");
  writeFileSync(sourced, INSTALLER_BODY);
  setup?.(home);

  try {
    const proc = Bun.spawn(["bash", "-c", `source "$1"; ${script}`, "--", sourced], {
      // Explicit, minimal env: nothing from the real shell leaks in.
      env: {
        HOME: home,
        ZDOTDIR: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        PATH: `${shims}:/usr/bin:/bin`,
        NO_TELEMETRY: "1",
        LC_ALL: "C",
        ...env,
      } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { stdout, stderr, code: await proc.exited, home };
  } finally {
    pending.push(root);
  }
}

const pending: string[] = [];
const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

afterAll(() => {
  for (const root of pending) rmSync(root, { recursive: true, force: true });
});

const MARKED = '# squirrel\nexport PATH="$HOME/.local/bin:$PATH"\n';

describe("find_bin_dir keeps its directory choice", () => {
  test("a writable non-standard $HOME dir on PATH is NOT picked; falls back to ~/.local/bin", async () => {
    const r = await run(
      'mkdir -p "$HOME/.mybin" "$HOME/.cargo/bin"; PATH="$HOME/.mybin:$HOME/.cargo/bin:$PATH"; d=$(find_bin_dir) || true; echo "DIR=$d"; setup_path "$d"; echo "SETUP=$PATH_SETUP"',
      { env: { SHELL: "/bin/zsh" } },
    );
    expect(r.stdout).toContain(`DIR=${r.home}/.local/bin\n`);
    // ...and that directory is what gets added to PATH.
    expect(r.stdout).toContain("SETUP=added");
    expect(read(join(r.home, ".zshrc"))).toBe(`\n${MARKED}`);
  });

  test("a common dir already on PATH and writable still wins", async () => {
    const r = await run('mkdir -p "$HOME/bin"; PATH="$HOME/bin:$PATH"; echo "DIR=$(find_bin_dir)"');
    expect(r.stdout).toContain(`DIR=${r.home}/bin\n`);
  });

  test("SQUIRREL_BIN_DIR still wins", async () => {
    const dir = join(tmpdir(), `sq-bin-override-${process.pid}`);
    const r = await run('mkdir -p "$HOME/bin"; PATH="$HOME/bin:$PATH"; echo "DIR=$(find_bin_dir)"', {
      env: { SQUIRREL_BIN_DIR: dir },
    });
    expect(r.stdout).toContain(`DIR=${dir}\n`);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("setup_path writes the shell's startup file", () => {
  const add = 'setup_path "$HOME/.local/bin"; echo "SETUP=$PATH_SETUP"';

  test("zsh: one marked line in ~/.zshrc, created if needed, and says so", async () => {
    const r = await run(add, { env: { SHELL: "/bin/zsh" } });
    expect(read(join(r.home, ".zshrc"))).toBe(`\n${MARKED}`);
    expect(r.stdout).toContain("SETUP=added");
    expect(r.stderr).toContain("Added ~/.local/bin to PATH in ~/.zshrc.");
  });

  test("zsh respects ZDOTDIR", async () => {
    // The harness pins ZDOTDIR to HOME; point it at a subdirectory instead.
    const r = await run('mkdir -p "$HOME/zd"; ZDOTDIR="$HOME/zd"; ' + add, {
      env: { SHELL: "/bin/zsh" },
    });
    expect(read(join(r.home, "zd", ".zshrc"))).toBe(`\n${MARKED}`);
    expect(existsSync(join(r.home, ".zshrc"))).toBe(false);
  });

  test("running twice leaves exactly one marked line", async () => {
    const r = await run(`${add}; ${add}`, { env: { SHELL: "/bin/zsh" } });
    const body = read(join(r.home, ".zshrc"));
    expect(body.match(/# squirrel/g)).toHaveLength(1);
    expect(body.match(/\.local\/bin/g)).toHaveLength(1);
  });

  test("a file that already puts ~/.local/bin on PATH gets no line, existing content is untouched", async () => {
    const existing = '# mine\nexport PATH="$HOME/.local/bin:$PATH"\nalias ll="ls -l"\n';
    const r = await run(add, {
      env: { SHELL: "/bin/zsh" },
      setup: (home) => writeFileSync(join(home, ".zshrc"), existing),
    });
    expect(read(join(r.home, ".zshrc"))).toBe(existing);
    // Nothing was written, so it is not reported as added.
    expect(r.stdout).toContain("SETUP=on_path");
  });

  test("a comment that merely mentions .local/bin does not count as configured", async () => {
    const existing = "# remember to add .local/bin one day\n";
    const r = await run(add, {
      env: { SHELL: "/bin/zsh" },
      setup: (home) => writeFileSync(join(home, ".zshrc"), existing),
    });
    expect(read(join(r.home, ".zshrc"))).toBe(`${existing}\n${MARKED}`);
  });

  test("an alias or function that only mentions .local/bin does not count as configured", async () => {
    const existing = "alias sq=~/.local/bin/squirrel\n";
    const r = await run(add, {
      env: { SHELL: "/bin/zsh" },
      setup: (home) => writeFileSync(join(home, ".zshrc"), existing),
    });
    expect(read(join(r.home, ".zshrc"))).toBe(`${existing}\n${MARKED}`);
  });

  test("PATH=$PATH:~/.local/bin/other is not the directory itself", async () => {
    const existing = "PATH=$PATH:~/.local/bin/other\n";
    const r = await run(add, {
      env: { SHELL: "/bin/zsh" },
      setup: (home) => writeFileSync(join(home, ".zshrc"), existing),
    });
    expect(read(join(r.home, ".zshrc"))).toBe(`${existing}\n${MARKED}`);
  });

  test("a fish_add_path line naming it counts as configured", async () => {
    const existing = "fish_add_path $HOME/.local/bin\n";
    const r = await run(add, {
      env: { SHELL: "/usr/bin/fish" },
      setup: (home) => {
        mkdirSync(join(home, ".config/fish/conf.d"), { recursive: true });
        writeFileSync(join(home, ".config/fish/conf.d/squirrel.fish"), existing);
      },
    });
    expect(read(join(r.home, ".config/fish/conf.d/squirrel.fish"))).toBe(existing);
  });

  test("existing content is appended to, never rewritten", async () => {
    const existing = "export FOO=1\nsetopt autocd";
    const r = await run(add, {
      env: { SHELL: "/bin/zsh" },
      setup: (home) => writeFileSync(join(home, ".zshrc"), existing),
    });
    expect(read(join(r.home, ".zshrc")).startsWith(existing)).toBe(true);
  });

  test("bash on macOS writes ~/.bash_profile", async () => {
    const r = await run(add, { env: { SHELL: "/bin/bash" }, uname: "Darwin" });
    expect(read(join(r.home, ".bash_profile"))).toBe(`\n${MARKED}`);
    expect(existsSync(join(r.home, ".bashrc"))).toBe(false);
  });

  test("bash on Linux writes ~/.bashrc", async () => {
    const r = await run(add, { env: { SHELL: "/usr/bin/bash" }, uname: "Linux" });
    expect(read(join(r.home, ".bashrc"))).toBe(`\n${MARKED}`);
    expect(existsSync(join(r.home, ".bash_profile"))).toBe(false);
  });

  test("fish writes conf.d/squirrel.fish with fish_add_path", async () => {
    const r = await run(add, { env: { SHELL: "/usr/bin/fish" } });
    expect(read(join(r.home, ".config/fish/conf.d/squirrel.fish"))).toBe(
      "\n# squirrel\nfish_add_path $HOME/.local/bin\n",
    );
  });

  test("an unknown shell and sh write ~/.profile", async () => {
    for (const shell of ["/opt/weird/xonsh", "/bin/sh"]) {
      const r = await run(add, { env: { SHELL: shell } });
      expect(read(join(r.home, ".profile"))).toBe(`\n${MARKED}`);
    }
  });

  test("SQUIRREL_NO_MODIFY_PATH=1 writes nothing and the manual instructions print", async () => {
    const r = await run(`${add}; print_path_instructions "$HOME/.local/bin"`, {
      env: { SHELL: "/bin/zsh", SQUIRREL_NO_MODIFY_PATH: "1" },
    });
    expect(r.stdout).toContain("SETUP=opted_out");
    expect(existsSync(join(r.home, ".zshrc"))).toBe(false);
    expect(r.stderr).toContain("is not in your PATH");
    expect(r.stdout).toContain('export PATH="');
  });

  test("SQUIRREL_NO_MODIFY_PATH=0 and empty do not opt out", async () => {
    for (const v of ["0", "false", ""]) {
      const r = await run(add, { env: { SHELL: "/bin/zsh", SQUIRREL_NO_MODIFY_PATH: v } });
      expect(r.stdout).toContain("SETUP=added");
    }
  });

  test("CI=true writes no rc file; GITHUB_PATH gets the dir", async () => {
    const r = await run(`${add}; cat "$GITHUB_PATH"`, {
      env: { SHELL: "/bin/zsh", CI: "true", GITHUB_PATH: "/dev/null" },
    });
    expect(r.stdout).toContain("SETUP=ci");
    expect(existsSync(join(r.home, ".zshrc"))).toBe(false);

    const r2 = await run(
      `: > "$HOME/gh_path"; GITHUB_PATH="$HOME/gh_path"; ${add}; cat "$HOME/gh_path"`,
      { env: { SHELL: "/bin/zsh", CI: "true" } },
    );
    expect(r2.stdout).toContain(`${r2.home}/.local/bin\n`);
    expect(existsSync(join(r2.home, ".zshrc"))).toBe(false);
  });

  test("an unwritable profile reports failed, not added", async () => {
    const r = await run(`mkdir "$HOME/.zshrc"; ${add}`, { env: { SHELL: "/bin/zsh" } });
    expect(r.stdout).toContain("SETUP=failed");
  });

  test("a custom bin dir off PATH is left for the user (no rc write)", async () => {
    const r = await run('setup_path "$HOME/custom/bin"; echo "SETUP=$PATH_SETUP"', {
      env: { SHELL: "/bin/zsh" },
    });
    expect(r.stdout).toContain("SETUP=opted_out");
    expect(existsSync(join(r.home, ".zshrc"))).toBe(false);
  });
});

describe("print_epilogue", () => {
  const OLD_TAIL =
    "\nRun your first audit (crawls the site, scores it, lists exact fixes):\n\n" +
    "  squirrel audit https://your-site.com\n\n" +
    "Then set up sign-in, agent skills and defaults:  squirrel setup\n" +
    "Docs: https://docs.squirrelscan.com\n\n";

  test("squirrel on PATH: the epilogue is unchanged", async () => {
    const r = await run(
      'mkdir -p "$HOME/.mybin"; PATH="$HOME/.mybin:$PATH"; PATH_SETUP=on_path; print_epilogue 1.2.3 "$HOME/.mybin"',
    );
    expect(r.stdout).toBe(`\nv squirrel 1.2.3 installed\n${OLD_TAIL}`);
    // ...and with no bin dir argument at all, as before.
    const r2 = await run("print_epilogue 1.2.3");
    expect(r2.stdout).toBe(r.stdout);
  });

  test("just added: the reload hint and a full-path command come first", async () => {
    const r = await run(
      'PATH_SETUP=added; PATH_SETUP_RC="$HOME/.zshrc"; print_epilogue 1.2.3 "$HOME/.local/bin"',
    );
    const lines = r.stdout.split("\n");
    expect(lines.slice(0, 7)).toEqual([
      "",
      "v squirrel 1.2.3 installed",
      "",
      "Open a new terminal, or run:  source ~/.zshrc",
      "Then:  squirrel audit https://your-site.com",
      "(or right now:  ~/.local/bin/squirrel audit https://your-site.com)",
      "",
    ]);
    expect(r.stdout).toContain("squirrel setup");
  });

  test("opted out: says squirrel is not on PATH before any command, full path first", async () => {
    const r = await run('PATH_SETUP=opted_out; print_epilogue 1.2.3 "$HOME/.local/bin"');
    const text = r.stdout;
    expect(text.indexOf("not on your PATH")).toBeGreaterThan(-1);
    expect(text.indexOf("not on your PATH")).toBeLessThan(text.indexOf("squirrel audit"));
    expect(text).toContain("  ~/.local/bin/squirrel audit https://your-site.com");
    expect(text).not.toContain("source ~");
  });
});

describe("main wiring", () => {
  test("setup_path runs before self install and its outcome reaches the CLI", () => {
    expect(shellInstaller).toContain('setup_path "$bin_dir"');
    expect(shellInstaller.indexOf('setup_path "$bin_dir"')).toBeLessThan(
      shellInstaller.indexOf('download_and_install "$version"'),
    );
    expect(shellInstaller).toContain('SQUIRREL_PATH_SETUP="$PATH_SETUP"');
  });

  test("a successful GITHUB_PATH append suppresses the profile instructions", () => {
    expect(shellInstaller).toContain("PATH_SETUP_GITHUB=1");
    expect(shellInstaller).toContain('if [ "$PATH_SETUP_GITHUB" != 1 ]; then');
  });

  test("manual instructions print after the epilogue, only when no profile was written", () => {
    const main = shellInstaller.slice(shellInstaller.lastIndexOf("\nmain() {"));
    expect(main.indexOf('print_epilogue "$version" "$bin_dir"')).toBeLessThan(
      main.indexOf("print_path_instructions"),
    );
    expect(main).toContain("opted_out|ci|failed)");
  });
});

describe("install.ps1 PATH setup", () => {
  test("adds the dir to the User Path only, once, and to the session", () => {
    expect(powershellInstaller).toContain(
      '[Environment]::SetEnvironmentVariable("Path", $newPath, "User")',
    );
    expect(powershellInstaller).not.toMatch(/SetEnvironmentVariable\([^)]*"Machine"\)/);
    expect(powershellInstaller).toContain("$env:Path = ");
    expect(powershellInstaller).toContain("SQUIRREL_NO_MODIFY_PATH");
  });

  test("stamps the outcome for self install, same five values as the shell installer", () => {
    expect(powershellInstaller).toContain("$env:SQUIRREL_PATH_SETUP = $script:PathSetup");
    for (const v of ["on_path", "added", "opted_out", "ci", "failed"]) {
      expect(powershellInstaller).toContain(`"${v}"`);
      expect(shellInstaller).toContain(v);
    }
  });
});
