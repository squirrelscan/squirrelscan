// A sourced install.sh never reports a failure, and a report with no message says what died (squirrelscan/repo#5020).
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertInstallerEnvCannotReachProduction, DEAD_ERROR_ENDPOINT } from "./install-test-env";

const text = readFileSync(new URL("../install.sh", import.meta.url).pathname, "utf8");
// Everything before the banner: the preamble (reporting, traps) without running an install.
const preamble = text.slice(0, text.indexOf("# --- Banner"));
const TIMEOUT_MS = 30_000;

type Run = { stdout: string; posts: Record<string, unknown>[] };

/** Runs `script` after the preamble, behind a curl shim that logs each POST body instead of sending it. */
const run = async (
  script: string,
  mode: "source" | "file" | "stream",
  env: Record<string, string | undefined> = {},
): Promise<Run> => {
  const dir = mkdtempSync(join(tmpdir(), "install-5020-"));
  try {
    const log = join(dir, "posts");
    writeFileSync(log, "");
    // POSTs (the report) are logged and succeed; any other request exits with SHIM_GET_RC (default 0).
    writeFileSync(
      join(dir, "curl"),
      `#!/bin/sh\nprev=""; post=0\nfor a in "$@"; do if [ "$prev" = --data ]; then printf '%s\\n' "$a" >> "${log}"; post=1; fi; prev="$a"; done\n[ "$post" = 1 ] && exit 0\nexit "\${SHIM_GET_RC:-0}"\n`,
    );
    chmodSync(join(dir, "curl"), 0o755);
    const file = join(dir, "installer.sh");
    writeFileSync(file, `${preamble}\n${script}\n`);
    const spawnEnv = {
      ...process.env,
      NO_TELEMETRY: undefined,
      DO_NOT_TRACK: undefined,
      SQUIRREL_ERROR_ENDPOINT: DEAD_ERROR_ENDPOINT,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      ...env,
    } as Record<string, string>;
    assertInstallerEnvCannotReachProduction(spawnEnv);
    const argv =
      mode === "source" ? ["bash", "-c", 'source "$1"', "--", file] : mode === "file" ? ["bash", file] : ["bash"];
    const proc = Bun.spawn(argv, {
      env: spawnEnv,
      stdin: mode === "stream" ? new Blob([readFileSync(file)]) : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    // The report is POSTed from a detached subshell: give it a moment to land.
    await Bun.sleep(1500);
    const posts = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { stdout, posts };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("how install.sh was invoked (#5020)", () => {
  test("file, stream and sourced are told apart", async () => {
    const echo = 'echo "inv=$INSTALLER_INVOCATION"';
    expect((await run(echo, "file")).stdout).toContain("inv=file");
    expect((await run(echo, "stream")).stdout).toContain("inv=stream");
    expect((await run(echo, "source")).stdout).toContain("inv=sourced");
  }, TIMEOUT_MS);
});

describe("a sourced install.sh does not report", () => {
  test("the made-up (exit 7) || report_on_exit failure that reached production sends nothing", async () => {
    const r = await run("( (exit 7) || report_on_exit )", "source");
    expect(r.posts).toHaveLength(0);
  }, TIMEOUT_MS);

  test("SQUIRREL_REPORT_WHEN_SOURCED=1 turns it back on for the payload tests", async () => {
    const r = await run("( (exit 7) || report_on_exit )", "source", { SQUIRREL_REPORT_WHEN_SOURCED: "1" });
    expect(r.posts).toHaveLength(1);
  }, TIMEOUT_MS);

  test("an executed copy still reports", async () => {
    const r = await run("( (exit 7) || report_on_exit )", "file");
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]?.step).toBe("startup");
  }, TIMEOUT_MS);
});

describe("a report with no message says what failed", () => {
  test("exit 7 with no request and no failing command is not blamed on curl", async () => {
    const r = await run("( (exit 7) || report_on_exit )", "file");
    expect(r.posts[0]?.error_line).toMatch(/^exit 7: no failing command was recorded \(file, bash \d+\.\d+\)$/);
  }, TIMEOUT_MS);

  test("the command the ERR trap saw, its line and the exit code are named, without arguments or paths", async () => {
    const r = await run("/usr/bin/false --secret-flag /home/someone/file", "file");
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]?.exit_code).toBe(1);
    const line = String(r.posts[0]?.error_line);
    expect(line).toMatch(/^exit 1: 'false' failed at line \d+ \(file, bash \d+\.\d+\)$/);
    expect(line).not.toMatch(/secret|someone/);
  }, TIMEOUT_MS);

  test("a curl that failed is named as curl", async () => {
    const r = await run("curl -fsS https://x.example/a", "file", { SHIM_GET_RC: "7" });
    expect(r.posts[0]?.error_line).toBe("curl exit 7 reaching an unknown host (before the first request)");
  }, TIMEOUT_MS);
});
