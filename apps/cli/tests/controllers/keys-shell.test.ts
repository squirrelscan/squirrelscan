// `squirrel keys create --shell` rc-file targeting — a pure function so this
// is testable without touching the real filesystem or $HOME (see the fake-HOME
// gotcha in tests/self/settings.test.ts: os.homedir() is cached at Bun process
// start, so a runtime $HOME swap in a test is silently ignored).

import { describe, expect, test } from "bun:test";

import {
  detectShellRc,
  shellExportLine,
  SHELL_APPEND_MARKER,
} from "@/controllers/keys/shell";

const noFilesExist = () => false;

describe("detectShellRc", () => {
  test("returns null on win32 (no unix-style rc file to append to)", () => {
    expect(detectShellRc("", noFilesExist, "win32")).toBeNull();
  });

  test("zsh prefers .zshenv when it exists", () => {
    const target = detectShellRc(
      "/bin/zsh",
      (rel) => rel === ".zshenv",
      "darwin"
    );
    expect(target).toEqual({ shell: "zsh", rcFile: ".zshenv" });
  });

  test("zsh falls back to .zshrc when .zshenv doesn't exist", () => {
    const target = detectShellRc("/bin/zsh", noFilesExist, "darwin");
    expect(target).toEqual({ shell: "zsh", rcFile: ".zshrc" });
  });

  test("fish always targets the fish config path", () => {
    const target = detectShellRc("/usr/bin/fish", noFilesExist, "linux");
    expect(target).toEqual({
      shell: "fish",
      rcFile: ".config/fish/config.fish",
    });
  });

  test("bash prefers .bashrc when it exists", () => {
    const target = detectShellRc(
      "/bin/bash",
      (rel) => rel === ".bashrc",
      "linux"
    );
    expect(target).toEqual({ shell: "bash", rcFile: ".bashrc" });
  });

  test("bash falls back to .bash_profile when .bashrc doesn't exist", () => {
    const target = detectShellRc("/bin/bash", noFilesExist, "darwin");
    expect(target).toEqual({ shell: "bash", rcFile: ".bash_profile" });
  });

  test("unrecognized $SHELL falls back to POSIX sh / .profile", () => {
    const target = detectShellRc("/bin/dash", noFilesExist, "linux");
    expect(target).toEqual({ shell: "sh", rcFile: ".profile" });
  });

  test("empty $SHELL falls back to POSIX sh / .profile", () => {
    const target = detectShellRc("", noFilesExist, "linux");
    expect(target).toEqual({ shell: "sh", rcFile: ".profile" });
  });
});

describe("shellExportLine", () => {
  test("uses `export VAR=value` for non-fish shells, tagged with the marker", () => {
    const line = shellExportLine("bash", "SQUIRRELSCAN_API_KEY", "sq_abc123");
    expect(line).toBe(
      `export SQUIRRELSCAN_API_KEY='sq_abc123'  ${SHELL_APPEND_MARKER}`
    );
  });

  test("uses `set -gx VAR value` for fish", () => {
    const line = shellExportLine("fish", "SQUIRRELSCAN_API_KEY", "sq_abc123");
    expect(line).toBe(
      `set -gx SQUIRRELSCAN_API_KEY 'sq_abc123'  ${SHELL_APPEND_MARKER}`
    );
  });
});
