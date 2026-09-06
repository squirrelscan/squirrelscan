import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shellInstaller = await Bun.file(new URL("../install.sh", import.meta.url)).text();
const powershellInstaller = await Bun.file(new URL("../install.ps1", import.meta.url)).text();
const npmPostinstall = await Bun.file(
  new URL("../npm/scripts/postinstall.js", import.meta.url),
).text();

// --- curl test double -----------------------------------------------------
// install.sh pins every curl to HTTPS (#165), so a plaintext loopback server
// can no longer stand in for an endpoint, and a TLS one would need a CA the
// child curl trusts — macOS ships a SecureTransport curl that does not read
// CURL_CA_BUNDLE, so that would pass in CI and fail on half the dev machines.
// Shim curl on PATH instead. Recording argv is also what proves the hardening
// flags reach a real invocation rather than merely appearing in the source.
const CURL_SHIM = `#!/bin/bash
for a in "$@"; do printf '%s\\0' "$a"; done >> "$SHIM_LOG"
printf '\\036' >> "$SHIM_LOG"

if [ -n "\${SHIM_FAIL_MATCH:-}" ]; then
  for a in "$@"; do
    case "$a" in *"$SHIM_FAIL_MATCH"*) exit 22 ;; esac
  done
fi

out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done

if [ -n "$out" ]; then
  printf '%s' "\${SHIM_BODY:-}" > "$out"
else
  printf '%s' "\${SHIM_BODY:-}"
fi
exit 0
`;

// Two sourceable cuts of the installer: everything above the EXIT trap (the
// reporting preamble), and everything above the final `main "$@"` (the whole
// script as a function library, which is what the download helpers need).
const INSTALLER_PREAMBLE = shellInstaller.slice(
  0,
  shellInstaller.indexOf("trap report_on_exit EXIT"),
);
const INSTALLER_BODY = shellInstaller.slice(0, shellInstaller.lastIndexOf('\nmain "$@"'));

type CurlShimRun = {
  /** argv of each curl invocation, in the order the script made them. */
  calls: string[][];
  stdout: string;
  stderr: string;
  code: number;
};

const parseCurlLog = (raw: string): string[][] =>
  raw
    .split("\u001e")
    .filter((record) => record.length > 0)
    // Every record is `arg\0arg\0…arg\0`, so the split leaves a trailing "".
    .map((record) => record.split("\u0000").slice(0, -1));

const runWithCurlShim = async (
  script: string,
  {
    cut = "body",
    body = "",
    failMatch = "",
    env = {},
    settleMs = 0,
  }: {
    cut?: "body" | "preamble";
    /** What the shim answers with: written to `-o <file>` when given, else stdout. */
    body?: string;
    /** The shim exits 22 (curl's HTTP-error code) when any argv contains this. */
    failMatch?: string;
    env?: Record<string, string | undefined>;
    /** How long to wait for a detached (backgrounded) curl to log its argv. */
    settleMs?: number;
  } = {},
): Promise<CurlShimRun> => {
  const dir = mkdtempSync(join(tmpdir(), "install-curl-shim-"));
  const log = join(dir, "curl-calls");
  const shim = join(dir, "curl");
  const sourced = join(dir, "installer.sh");
  await Bun.write(shim, CURL_SHIM);
  chmodSync(shim, 0o755);
  await Bun.write(sourced, cut === "body" ? INSTALLER_BODY : INSTALLER_PREAMBLE);
  await Bun.write(log, "");

  try {
    const proc = Bun.spawn(["bash", "-c", `source "$1"; ${script}`, "--", sourced], {
      env: {
        ...process.env,
        NO_TELEMETRY: "1",
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        SHIM_LOG: log,
        SHIM_BODY: body,
        SHIM_FAIL_MATCH: failMatch,
        ...env,
      } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    for (let waited = 0; waited < settleMs; waited += 50) {
      if ((await Bun.file(log).text()) !== "") break;
      await Bun.sleep(50);
    }
    return { calls: parseCurlLog(await Bun.file(log).text()), stdout, stderr, code };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// --- curl transport hardening (#165) --------------------------------------
// curl's defaults follow a redirect from https straight to plain http and
// negotiate whatever TLS version the local build still allows.
const CURL_HARDENING = [
  ["--proto", "=https"],
  ["--proto-redir", "=https"],
  ["--tlsv1.2"],
  ["--max-redirs", "3"],
];

/** Which hardening options are absent from a recorded argv, as adjacent pairs. */
const missingFromArgv = (argv: string[]): string[] => {
  const joined = `\u0000${argv.join("\u0000")}\u0000`;
  return CURL_HARDENING.filter(
    (option) => !joined.includes(`\u0000${option.join("\u0000")}\u0000`),
  ).map((option) => option.join(" "));
};

/** The `--data` payload of a recorded argv. */
const curlDataArg = (argv: string[]): string => argv[argv.indexOf("--data") + 1] ?? "";

/**
 * Every curl the script actually executes, as (1-based line, folded logical
 * line). Skips comments, the `command -v curl` presence checks, and the copy
 * of the one-liner inside user-facing hint text — a curl preceded by an odd
 * number of double quotes on its line is inside a string, not in command
 * position. `curl_args=(…)` is not matched: the name is not the bare word.
 */
const curlInvocations = (script: string): { line: number; text: string }[] => {
  const lines = script.split("\n");
  const found: { line: number; text: string }[] = [];
  for (const [index, line] of lines.entries()) {
    if (/^\s*#/.test(line)) continue;
    const match = /(?<![\w./-])curl(?=\s)/.exec(line);
    if (!match) continue;
    if (/command\s+-v\s+curl/.test(line)) continue;
    if ((line.slice(0, match.index).match(/"/g) ?? []).length % 2 === 1) continue;
    // Fold bash line continuations so the whole argument list is in view.
    let text = line;
    for (let next = index; /\\$/.test(lines[next]) && next + 1 < lines.length; next += 1) {
      text += `\n${lines[next + 1]}`;
    }
    found.push({ line: index + 1, text });
  }
  return found;
};

/** Quoting differs between the array literal and the sh re-exec; ignore it. */
const unquote = (text: string) => text.replace(/["']/g, "").replace(/\s+/g, " ");

const arrayRefs = (text: string): string[] =>
  [...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}/g)].map((match) => match[1]);

/** Whether an argv array is seeded from CURL_TLS_ARGS, or spells the flags out. */
const arrayIsHardened = (script: string, name: string, seen: Set<string>): boolean => {
  if (name === "CURL_TLS_ARGS") return true;
  if (seen.has(name)) return false;
  seen.add(name);
  const definition = new RegExp(`(?:^|\\s)(?:local\\s+)?${name}=\\(([^)]*)\\)`, "m").exec(script);
  if (!definition) return false;
  const flat = unquote(definition[1]);
  return (
    arrayRefs(flat).some((ref) => arrayIsHardened(script, ref, seen)) ||
    CURL_HARDENING.every((option) => flat.includes(option.join(" ")))
  );
};

/** Which hardening options a call site neither spells out nor inherits. */
const missingHardening = (script: string, invocation: string): string[] => {
  const flat = unquote(invocation);
  if (arrayRefs(flat).some((ref) => arrayIsHardened(script, ref, new Set()))) return [];
  return CURL_HARDENING.filter((option) => !flat.includes(option.join(" "))).map((option) =>
    option.join(" "),
  );
};

describe("installer privacy and supply-chain contracts", () => {
  test("NO_TELEMETRY uses presence semantics in both standalone installers", () => {
    expect(shellInstaller).toContain('[ "${NO_TELEMETRY+x}" = x ]');
    expect(powershellInstaller).toContain("Test-Path Env:NO_TELEMETRY");
  });

  test("npm postinstall does not invoke package runners or install global tools", () => {
    expect(npmPostinstall).not.toContain("npxCmd");
    expect(npmPostinstall).not.toContain('["skills", "add"');
    expect(npmPostinstall).not.toContain('"-g"');
  });
});

// A `self install` failure used to report an exit code and nothing else, which
// made a real Windows break undiagnosable (#1538). Both installers now capture
// the command's own output and carry a bounded, scrubbed tail of it.
describe("self install failure reporting", () => {
  test("both installers send error_output at report version 2", () => {
    expect(shellInstaller).toContain('INSTALLER_REPORT_VERSION="2"');
    expect(shellInstaller).toContain('"error_output":"%s"');
    expect(powershellInstaller).toContain('$InstallerReportVersion = "2"');
    expect(powershellInstaller).toContain("error_output   = $scrubbedOutput");
  });

  test("sh runs self install under tee and reports the binary's own exit code", () => {
    expect(shellInstaller).toContain(
      'self install --bin-dir "$bin_dir" 2>&1 | tee "$self_install_log"',
    );
    // tee's status is not the binary's — PIPESTATUS[0] is.
    expect(shellInstaller).toContain("local rc=${PIPESTATUS[0]}");
    expect(shellInstaller).toContain('LAST_ERROR_CODE="$rc"');
  });

  test("ps1 captures self install output instead of running it bare", () => {
    expect(powershellInstaller).toContain(
      'Invoke-CapturedCommand -FilePath $binaryPath -Arguments @("self", "install")',
    );
    expect(powershellInstaller).not.toContain("& $binaryPath self install\n");
    // Native stderr under $ErrorActionPreference = "Stop" would otherwise blow
    // up as a NativeCommandError before the exit code could be read.
    expect(powershellInstaller).toContain('$ErrorActionPreference = "Continue"');
  });

  test("captured output is bounded and home paths are scrubbed before sending", () => {
    expect(shellInstaller).toContain("ERROR_OUTPUT_MAX=1000");
    expect(shellInstaller).toContain('scrubbed=${scrubbed//"$HOME"/$tilde}');
    expect(powershellInstaller).toContain("$ErrorOutputMax = 1000");
    expect(powershellInstaller).toContain(
      '$scrubbed.Replace($env:USERPROFILE, "~")',
    );
  });
});

// A self install killed by the kernel (137 = SIGKILL, in the field the OOM
// killer on a small VPS) produces no output at all, so it used to surface as a
// bare "failed with exit code 137" and report under the same step as a genuine
// self-install bug (#1654).
describe("self install killed by a signal", () => {
  // Everything under test lives in the sourceable preamble, above the EXIT trap.
  const sourcePreamble = async (script: string, env: Record<string, string> = {}) => {
    const preambleEnd = shellInstaller.indexOf("trap report_on_exit EXIT");
    expect(preambleEnd).toBeGreaterThan(0);
    const preamble = join(tmpdir(), `install-kill-${process.pid}-${Math.random()}.sh`);
    await Bun.write(preamble, shellInstaller.slice(0, preambleEnd));
    try {
      const proc = Bun.spawn(["bash", "-c", `source "$1"; ${script}`, "--", preamble], {
        env: { ...process.env, NO_TELEMETRY: "1", ...env } as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { stdout, stderr, code: await proc.exited };
    } finally {
      rmSync(preamble, { force: true });
    }
  };

  test("137 and 143 report under their own step; every other code does not", async () => {
    const { stdout } = await sourcePreamble(
      'for c in 137 143 0 1 2 126 127 255; do printf "%s=%s\\n" "$c" "$(self_install_step_for_code "$c")"; done',
    );
    expect(stdout.trim().split("\n")).toEqual([
      "137=self_install_killed",
      "143=self_install_killed",
      // Criterion: non-signal failures keep reporting exactly as before.
      "0=self_install",
      "1=self_install",
      "2=self_install",
      "126=self_install",
      "127=self_install",
      "255=self_install",
    ]);
  });

  test("the killed step is what report_error actually POSTs", async () => {
    const { calls } = await runWithCurlShim(
      'report_error "$(self_install_step_for_code 137)" 137 "killed" ""; sleep 1',
      { cut: "preamble", env: { NO_TELEMETRY: undefined }, settleMs: 5000 },
    );

    expect(calls).toHaveLength(1);
    const report = JSON.parse(curlDataArg(calls[0])) as Record<string, unknown>;
    // Distinct from "self_install", which is what makes Sentry fingerprint
    // OOM kills apart from real self-install failures.
    expect(report.step).toBe("self_install_killed");
    expect(report.exit_code).toBe(137);
  }, 15_000);

  test("only SIGKILL claims memory; SIGTERM stays non-committal", async () => {
    const { stdout } = await sourcePreamble(
      'self_install_kill_headline 137; printf "\\n"; self_install_kill_headline 143',
    );
    const [sigkill, sigterm] = stdout.split("\n");
    expect(sigkill).toBe(
      "Self install was killed by the system (exit 137, SIGKILL), most likely out of memory",
    );
    // SIGTERM also arrives from timeout wrappers and cancelled CI jobs.
    expect(sigterm).toBe(
      "Self install was stopped by a signal before it finished (exit 143, SIGTERM)",
    );
    expect(sigterm).not.toContain("memory");
  });

  test("SIGKILL guidance names the cause and the ways out of it", async () => {
    const { stdout } = await sourcePreamble("self_install_kill_guidance 137");
    expect(stdout).toContain("out-of-memory killer");
    expect(stdout).toContain("mkswap /swapfile");
    // The direct-download escape hatch for a machine that cannot grow.
    expect(stdout).toContain("https://github.com/squirrelscan/squirrelscan/releases");
    // No em-dashes in user-facing copy.
    expect(stdout).not.toContain("—");
  });

  test("SIGTERM guidance does not send the user off to add swap", async () => {
    const { stdout } = await sourcePreamble("self_install_kill_guidance 143");
    // The headline already declines to blame memory; the detail must agree.
    expect(stdout).not.toContain("out-of-memory killer");
    expect(stdout).not.toContain("swapon");
    expect(stdout).toContain("timeout wrapper");
    expect(stdout).toContain("https://github.com/squirrelscan/squirrelscan/releases");
    expect(stdout).not.toContain("—");
  });

  test("error() prints detail to the user but keeps it out of the report line", async () => {
    // error() exits, so it runs in a subshell here and the message is read back
    // from the file it persists to for exactly that reason.
    const { stderr, stdout } = await sourcePreamble(
      '( error "short line" "long detail block" ) || true; cat "$ERROR_MSG_FILE"',
    );
    expect(stderr).toContain("short line");
    expect(stderr).toContain("long detail block");
    // Only the short line rides along in the report.
    expect(stdout).toBe("short line");
  });

  // Cap sizes are compared as digit strings because a cgroup limit routinely
  // exceeds what bash arithmetic can hold.
  describe("uint_gt", () => {
    const compare = async (pairs: [string, string][]) => {
      const script = pairs
        .map(([a, b]) => `if uint_gt "${a}" "${b}"; then echo true; else echo false; fi`)
        .join("; ");
      const { stdout } = await sourcePreamble(script);
      return stdout.trim().split("\n");
    };

    test("orders equal-length values, the branch that needs the locale pin", async () => {
      expect(
        await compare([
          ["268435456", "234881024"],
          ["234881024", "268435456"],
          ["268435456", "268435456"],
          ["1099511627777", "1099511627776"],
        ]),
      ).toEqual(["true", "false", "false", "true"]);
    });

    test("orders values too large for bash arithmetic", async () => {
      expect(
        await compare([
          // UINT64_MAX and PAGE_COUNTER_MAX: both wrap a signed compare.
          ["18446744073709551615", "1099511627776"],
          ["9223372036854771712", "1099511627776"],
          ["99999999999999999999999999", "1099511627776"],
          ["268435456", "1099511627776"],
        ]),
      ).toEqual(["true", "true", "true", "false"]);
    });

    test("normalizes leading zeros instead of comparing them as length", async () => {
      expect(
        await compare([
          ["0000000009", "10"],
          ["010", "9"],
          ["000", "0"],
        ]),
      ).toEqual(["false", "true", "false"]);
    });
  });

  describe("memory probe", () => {
    // The probe reads the kernel through indirected paths, so the container
    // cases it exists for are testable against fixtures.
    const withFixture = async (files: Record<string, string>) => {
      const root = join(tmpdir(), `install-cg-${process.pid}-${Math.random()}`);
      for (const [path, body] of Object.entries(files)) {
        await Bun.write(join(root, path), body);
      }
      try {
        return await sourcePreamble("available_memory_mib", {
          SQUIRREL_CGROUP_ROOT: join(root, "cgroup"),
          SQUIRREL_PROC_SELF_CGROUP: join(root, "self-cgroup"),
          SQUIRREL_PROC_MEMINFO: join(root, "meminfo"),
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    // 8GB free on the host. Inside a capped container this must never win.
    const HOST_MEMINFO = "MemTotal: 16000000 kB\nMemAvailable: 8388608 kB\n";

    test("reports headroom under a cgroup v2 cap, not the host's memory", async () => {
      const { stdout } = await withFixture({
        "self-cgroup": "0::/\n",
        "cgroup/memory.max": "268435456\n", // 256MB cap
        "cgroup/memory.current": "234881024\n", // 224MB used
        meminfo: HOST_MEMINFO,
      });
      expect(stdout).toBe("32");
    });

    test("resolves a nested v2 cgroup rather than the hierarchy root", async () => {
      const { stdout } = await withFixture({
        "self-cgroup": "0::/docker/abc123\n",
        "cgroup/memory.max": "max\n", // the root is uncapped
        "cgroup/docker/abc123/memory.max": "134217728\n", // 128MB
        "cgroup/docker/abc123/memory.current": "67108864\n", // 64MB
        meminfo: HOST_MEMINFO,
      });
      expect(stdout).toBe("64");
    });

    test("reports zero, not a negative, when usage is at the cap", async () => {
      const { stdout } = await withFixture({
        "self-cgroup": "0::/\n",
        "cgroup/memory.max": "268435456",
        "cgroup/memory.current": "300000000", // over the cap, as at an OOM kill
        meminfo: HOST_MEMINFO,
      });
      expect(stdout).toBe("0");
    });

    test("reads a cgroup v1 memory controller", async () => {
      const { stdout } = await withFixture({
        "self-cgroup": "9:memory:/docker/abc123\n8:cpu:/docker/abc123\n",
        "cgroup/memory/docker/abc123/memory.limit_in_bytes": "268435456\n",
        "cgroup/memory/docker/abc123/memory.usage_in_bytes": "134217728\n",
        meminfo: HOST_MEMINFO,
      });
      expect(stdout).toBe("128");
    });

    test("honours a capped ancestor when the leaf itself is uncapped", async () => {
      // systemd sets MemoryMax on a slice and leaves the unit below it at
      // "max"; the ancestor's limit binds just as hard.
      const { stdout } = await withFixture({
        "self-cgroup": "0::/system.slice/squirrel.service\n",
        "cgroup/system.slice/squirrel.service/memory.max": "max\n",
        "cgroup/system.slice/memory.max": "268435456\n", // 256MB on the slice
        "cgroup/system.slice/memory.current": "234881024\n", // 224MB used
        "cgroup/memory.max": "max\n",
        meminfo: HOST_MEMINFO,
      });
      expect(stdout).toBe("32");
    });

    test("takes the tightest cap when several ancestors are capped", async () => {
      const { stdout } = await withFixture({
        "self-cgroup": "0::/a/b\n",
        "cgroup/a/b/memory.max": "1073741824\n", // 1GB, 512MB free
        "cgroup/a/b/memory.current": "536870912\n",
        "cgroup/a/memory.max": "268435456\n", // 256MB, 32MB free: tighter
        "cgroup/a/memory.current": "234881024\n",
        "cgroup/memory.max": "max\n",
        meminfo: HOST_MEMINFO,
      });
      expect(stdout).toBe("32");
    });

    test("a UINT64_MAX limit reads as uncapped, not an exabyte cap", async () => {
      // Bash compares signed, so this value wraps: without a string-wise guard
      // it passes the sanity bound and yields a garbage headroom figure.
      const { stdout } = await withFixture({
        "self-cgroup": "9:memory:/\n",
        "cgroup/memory/memory.limit_in_bytes": "18446744073709551615\n",
        "cgroup/memory/memory.usage_in_bytes": "134217728\n",
        meminfo: HOST_MEMINFO,
      });
      expect(stdout).toBe("8192");
    });

    test("treats a v1 PAGE_COUNTER_MAX sentinel as uncapped", async () => {
      const { stdout } = await withFixture({
        "self-cgroup": "9:memory:/\n",
        "cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
        "cgroup/memory/memory.usage_in_bytes": "134217728\n",
        meminfo: HOST_MEMINFO,
      });
      expect(stdout).toBe("8192"); // the host figure is the honest one here
    });

    test("stays silent when a cap exists but its usage cannot be read", async () => {
      const { stdout } = await withFixture({
        "self-cgroup": "0::/\n",
        "cgroup/memory.max": "268435456\n",
        // memory.current missing: quoting the host's 8GB here would be a lie.
        meminfo: HOST_MEMINFO,
      });
      expect(stdout).toBe("");
    });

    test("falls back to the host only when demonstrably uncapped", async () => {
      const { stdout } = await withFixture({
        "self-cgroup": "0::/\n",
        "cgroup/memory.max": "max\n",
        meminfo: HOST_MEMINFO,
      });
      expect(stdout).toBe("8192");
    });

    test.each([
      ["a", "relative, and never shortens under ${rel%/*}"],
      ["a/b", "relative, shortens to a then stalls"],
      ["/../../etc", "escapes the cgroup root"],
      ["/a/./b", "un-normalized"],
      ["//a", "empty component"],
    ])("refuses the malformed cgroup path %p (%s)", async (rel) => {
      // The old walk had no termination guard: a path that never shortens hung
      // the installer on the failure path, which is worse than the bug it is
      // there to explain. The suite timeout is the real assertion.
      const { stdout } = await withFixture({
        "self-cgroup": `0::${rel}\n`,
        "cgroup/memory.max": "268435456\n",
        "cgroup/memory.current": "234881024\n",
        meminfo: HOST_MEMINFO,
      });
      // Falls through to the host figure rather than following the path.
      expect(stdout).toBe("8192");
    }, 10_000);

    // The cases above are refused by is_safe_cgroup_rel before they reach the
    // walk, so they would still pass with the loop guard removed. Drive the
    // walk directly to cover the guard on its own.
    test.each(["a", "a/b", "", "/", "/a", "/a/b/c"])(
      "the walk itself terminates on rel %p",
      async (rel) => {
        const { stdout, code } = await sourcePreamble(
          `cgroup_tree_headroom_mib /nonexistent memory.max memory.current "${rel}"`,
        );
        expect(code).toBe(0);
        expect(stdout).toBe("");
      },
      10_000,
    );

    test("emits nothing rather than a guess when no interface is readable", async () => {
      const { stdout } = await withFixture({ "self-cgroup": "" });
      expect(stdout).toBe("");
    });

    test("never emits a non-numeric figure on the real machine", async () => {
      // Empty when it cannot tell (macOS has no /proc); digits only otherwise.
      const { stdout } = await sourcePreamble("available_memory_mib");
      expect(stdout).toMatch(/^\d*$/);
    });
  });

  test("the self install branch routes the killed codes through both helpers", () => {
    // The branch itself sits below the sourceable preamble, so pin the wiring.
    expect(shellInstaller).toContain('CURRENT_STEP=$(self_install_step_for_code "$rc")');
    expect(shellInstaller).toContain('if [ "$CURRENT_STEP" = "$SELF_INSTALL_KILLED_STEP" ]; then');
    expect(shellInstaller).toContain(
      'error "$(self_install_kill_headline "$rc")" "$(self_install_kill_guidance "$rc")"',
    );
    // Unchanged fallback for every non-signal failure.
    expect(shellInstaller).toContain('error "Self install failed with exit code $rc"');
  });
});

// Behavioural, not textual: source the shell installer's reporting preamble and
// watch what report_error actually POSTs.
describe("install.sh report_error payload", () => {
  test("carries a scrubbed, tail-truncated error_output as valid JSON", async () => {
    expect(INSTALLER_PREAMBLE.length).toBeGreaterThan(0);
    const home = process.env.HOME ?? "";
    const output = `${"noise ".repeat(400)}EPERM: operation not permitted, symlink -> ${home}/.local/bin/squirrel`;

    // The reporter POSTs from a detached subshell, so give it a beat to land.
    const { calls } = await runWithCurlShim(
      'report_error self_install 1 "Self install failed with exit code 1" "$REPORT_OUTPUT"; sleep 1',
      {
        cut: "preamble",
        env: { NO_TELEMETRY: undefined, REPORT_OUTPUT: output },
        settleMs: 5000,
      },
    );

    expect(calls).toHaveLength(1);
    const report = JSON.parse(curlDataArg(calls[0])) as Record<string, unknown>;
    expect(report.step).toBe("self_install");
    expect(report.script_version).toBe("2");
    const errorOutput = report.error_output as string;
    expect(errorOutput.length).toBe(1000); // bounded
    // Tail kept: the failure is at the END of a command's output.
    expect(errorOutput).toEndWith("~/.local/bin/squirrel");
    if (home) expect(errorOutput).not.toContain(home);
  }, 15_000);
});

// curl follows a redirect from https to plain http by default and negotiates
// whatever TLS the local build still allows. The binary is checksum-verified
// against the manifest, but the metadata fetches and the bash re-exec have
// nothing but the transport behind them (#165).
describe("install.sh curl transport hardening", () => {
  test("the flag set is defined once, with all four options", () => {
    expect(shellInstaller).toContain(
      "CURL_TLS_ARGS=(--proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 3)",
    );
  });

  test("the POSIX-sh re-exec hardens its curl inline, above the array", () => {
    // This one runs under /bin/sh before the bash-only preamble that defines
    // CURL_TLS_ARGS, so it cannot use it and has to repeat the flags.
    expect(shellInstaller).toContain(
      `exec bash -c 'curl -fsSL --proto "=https" --proto-redir "=https" --tlsv1.2 --max-redirs 3 https://install.squirrelscan.com/install.sh | bash'`,
    );
  });

  test("every curl the script executes is hardened, and none escapes the scan", () => {
    const invocations = curlInvocations(shellInstaller);
    // Pinned so a refactor that hides a call site from the scan fails loudly
    // instead of passing vacuously: the fetcher, both release-metadata
    // fetches, the failure-report POST, and the POSIX-sh re-exec.
    expect(invocations.map((found) => found.line)).toHaveLength(5);
    for (const { line, text } of invocations) {
      expect([line, missingHardening(shellInstaller, text)]).toEqual([line, []]);
    }
  });

  test("fetch_with_retry passes the flags to the real command", async () => {
    const { calls, code } = await runWithCurlShim(
      'out=$(mktemp); fetch_with_retry "https://example.test/manifest.json" "$out"; rm -f "$out"',
      { body: "{}" },
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(missingFromArgv(calls[0])).toEqual([]);
    expect(calls[0]).toContain("https://example.test/manifest.json");
  });

  test("get_latest_version passes the flags on the release-metadata fetch", async () => {
    const { calls, stdout } = await runWithCurlShim("USE_JQ=false; get_latest_version stable", {
      body: '{"version": "1.2.3"}',
    });
    expect(stdout.trim()).toBe("v1.2.3");
    expect(calls).toHaveLength(1);
    expect(missingFromArgv(calls[0])).toEqual([]);
    expect(calls[0]).toContain("https://install.squirrelscan.com/releases/stable");
  });

  test("get_latest_version passes the flags on the GitHub API fallback too", async () => {
    // The fallback is the branch a corporate NAT hitting the R2 endpoint takes,
    // so it is the one least likely to be exercised by hand.
    const { calls, stdout } = await runWithCurlShim("USE_JQ=false; get_latest_version stable", {
      body: '[{"tag_name": "v1.2.3", "prerelease": false}]',
      failMatch: "/releases/stable",
    });
    expect(stdout.trim()).toBe("v1.2.3");
    expect(calls).toHaveLength(2);
    expect(calls.map(missingFromArgv)).toEqual([[], []]);
    expect(calls[1]).toContain(
      "https://api.github.com/repos/squirrelscan/squirrelscan/releases",
    );
  });

  test("the failure-report POST passes the flags from its detached subshell", async () => {
    const { calls } = await runWithCurlShim('report_error fetch_releases 1 "boom" ""; sleep 1', {
      cut: "preamble",
      env: { NO_TELEMETRY: undefined },
      settleMs: 5000,
    });
    expect(calls).toHaveLength(1);
    expect(missingFromArgv(calls[0])).toEqual([]);
    expect(calls[0]).toContain("https://install.squirrelscan.com/error");
  });
});
