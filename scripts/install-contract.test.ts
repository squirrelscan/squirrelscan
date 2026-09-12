import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shellInstaller = await Bun.file(new URL("../install.sh", import.meta.url)).text();
const powershellInstaller = await Bun.file(new URL("../install.ps1", import.meta.url)).text();
const npmPostinstall = await Bun.file(
  new URL("../npm/scripts/postinstall.js", import.meta.url),
).text();
const ciWorkflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
const powershellContract = await Bun.file(
  new URL("../scripts/install-ps-contract.test.ps1", import.meta.url),
).text();

// --- curl test double -----------------------------------------------------
// install.sh pins every curl to HTTPS (#165), so a plaintext loopback server
// can no longer stand in for an endpoint, and a TLS one would need a CA the
// child curl trusts — macOS ships a SecureTransport curl that does not read
// CURL_CA_BUNDLE, so that would pass in CI and fail on half the dev machines.
// Shim curl on PATH instead. Recording argv is also what proves the hardening
// flags reach a real invocation rather than merely appearing in the source.
const CURL_SHIM = `#!/bin/bash
# One redirect for the whole record: a reader that sees the trailing separator
# knows the argv it is holding is complete.
{
  for a in "$@"; do printf '%s\\0' "$a"; done
  printf '\\036'
} >> "$SHIM_LOG"

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
        // Keep the ambient environment out of the recorded argv. A GITHUB_TOKEN
        // reaches get_latest_version's auth header, and a failing expect() on
        // that argv would print the token into a public CI log.
        GITHUB_TOKEN: undefined,
        SQUIRREL_CHANNEL: undefined,
        SQUIRREL_VERSION: undefined,
        SQUIRREL_ERROR_ENDPOINT: undefined,
        SQUIRREL_RELEASES_ENDPOINT: undefined,
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
    // Wait for a COMPLETE record, not merely a non-empty file: a half-written
    // one would parse into an argv with no --data and fail as a JSON error.
    let raw = await Bun.file(log).text();
    for (let waited = 0; waited < settleMs && !raw.endsWith("\u001e"); waited += 50) {
      await Bun.sleep(50);
      raw = await Bun.file(log).text();
    }
    return { calls: parseCurlLog(raw), stdout, stderr, code };
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
 * Every curl the script actually executes, as (1-based line, argument text).
 * Each hit's text starts AT its own curl and runs to the end of the folded
 * logical line, so a second curl on the line is judged on its own arguments
 * rather than borrowing the first one's.
 *
 * Skipped: whole-line comments, the `command -v curl` presence probes, and the
 * copy of the published one-liner inside user-facing hint text — a curl behind
 * an odd number of unescaped double quotes is in a string, not command
 * position. `curl_args=(…)` never matches: the bare word needs trailing space.
 * A path-qualified `/usr/bin/curl` does match, deliberately.
 */
const curlInvocations = (script: string): { line: number; text: string }[] => {
  const lines = script.split("\n");
  const found: { line: number; text: string }[] = [];
  for (const [index, line] of lines.entries()) {
    if (/^\s*#/.test(line)) continue;
    // Fold bash line continuations so the whole argument list is in view.
    let folded = line;
    for (let next = index; /\\$/.test(lines[next]) && next + 1 < lines.length; next += 1) {
      folded += `\n${lines[next + 1]}`;
    }
    for (const match of line.matchAll(/(?<![\w-])curl(?=\s)/g)) {
      const before = line.slice(0, match.index);
      if (/command\s+-v\s+$/.test(before)) continue;
      if ((before.replace(/\\"/g, "").match(/"/g) ?? []).length % 2 === 1) continue;
      found.push({ line: index + 1, text: folded.slice(match.index) });
    }
  }
  return found;
};

/** Quoting differs between the array literal and the sh re-exec; ignore it. */
const unquote = (text: string) => text.replace(/["']/g, "").replace(/\s+/g, " ");

const arrayRefs = (text: string): string[] =>
  [...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}/g)].map((match) => match[1]);

/**
 * Whether an argv array is seeded from CURL_TLS_ARGS, or spells the flags out.
 * EVERY assignment of the name has to qualify, since a later one that drops the
 * flags is the one that wins at the call site. A literal `)` inside an array
 * body (a `$(…)` substitution) truncates the match and reads as unhardened,
 * which fails loudly rather than passing something through.
 */
const arrayIsHardened = (script: string, name: string, seen: Set<string>): boolean => {
  if (name === "CURL_TLS_ARGS") return true;
  if (seen.has(name)) return false;
  seen.add(name);
  const definitions = [
    ...script.matchAll(new RegExp(`(?:^|\\s)(?:local\\s+)?${name}=\\(([^)]*)\\)`, "gm")),
  ];
  if (definitions.length === 0) return false;
  return definitions.every((definition) => {
    const flat = unquote(definition[1]);
    return (
      arrayRefs(flat).some((ref) => arrayIsHardened(script, ref, seen)) ||
      CURL_HARDENING.every((option) => flat.includes(option.join(" ")))
    );
  });
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

describe("PowerShell installer transport security", () => {
  test("enables TLS 1.2 before network calls without replacing newer protocols", () => {
    const tlsFloor = powershellInstaller.match(
      /\[Net\.ServicePointManager\]::SecurityProtocol\s*=\s*`\s*\n\s*\[Net\.ServicePointManager\]::SecurityProtocol\s+-bor\s+\[Net\.SecurityProtocolType\]::Tls12/,
    );
    expect(tlsFloor).not.toBeNull();

    const tlsFloorIndex = tlsFloor?.index ?? -1;
    const firstNetworkCall = Math.min(
      powershellInstaller.indexOf("Invoke-RestMethod"),
      powershellInstaller.indexOf("Invoke-WebRequest"),
    );

    expect(tlsFloorIndex).toBeGreaterThan(-1);
    expect(tlsFloorIndex).toBeLessThan(firstNetworkCall);
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
    // #2023: a killed self install is finished by hand; the headline and the
    // memory guidance still reach the user when even the file work fails.
    expect(shellInstaller).toContain(
      'install_by_hand_and_verify "$tmpdir/squirrel" "$version" "$bin_dir" "$rc"',
    );
    expect(shellInstaller).toContain(
      'error "$(self_install_kill_headline "$kill_rc")" "$(self_install_kill_guidance "$kill_rc")"',
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
    // The count is pinned only so a refactor that hides an EXISTING call site
    // from the scan fails instead of passing vacuously. It cannot notice a new
    // call site the scan is blind to; only the scan itself can. Five today:
    // the fetcher, both release-metadata fetches, the failure-report POST, and
    // the POSIX-sh re-exec.
    expect(invocations.map((found) => found.line)).toHaveLength(5);
    for (const { line, text } of invocations) {
      expect([line, missingHardening(shellInstaller, text)]).toEqual([line, []]);
    }
  });

  test.each([
    ["a path-qualified call", '/usr/bin/curl -fsSL http://evil.test/x'],
    ["a second call on the line", 'curl "${CURL_TLS_ARGS[@]}" "$u" || curl -fsSL http://evil.test'],
    ["a call after a probe", 'command -v curl >/dev/null && curl -fsSL http://evil.test'],
    ["a hardened array named elsewhere", 'echo "${CURL_TLS_ARGS[@]}"; curl -fsSL http://evil.test'],
  ])("the scan still catches %s", (_label, line) => {
    // Each of these slipped past an earlier draft of the scan. They are the
    // shapes a future edit is most likely to reintroduce, so they are pinned
    // here rather than left to the reviewer's eye.
    const invocations = curlInvocations(line);
    expect(invocations.length).toBeGreaterThan(0);
    expect(
      invocations.map((found) => missingHardening(shellInstaller, found.text)).flat(),
    ).not.toEqual([]);
  });

  test("the scan refuses an array whose later assignment drops the flags", () => {
    const script = [
      "CURL_TLS_ARGS=(--proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 3)",
      'local args=("${CURL_TLS_ARGS[@]}" -fsSL)',
      'args=(-fsSL --proxy "$P")',
      'curl "${args[@]}" "$url"',
    ].join("\n");
    const [invocation] = curlInvocations(script);
    expect(missingHardening(script, invocation.text)).toHaveLength(4);
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
    // Same detached-POST shape as the two payload tests, so the same budget:
    // the script sleeps 1s and the harness can wait 5s more on a loaded runner.
  }, 15_000);

  // Everything above this point shims curl, so it would pass just as happily
  // with `--tlsv.1.2` in the array. Nothing else pre-merge would catch that:
  // `bash -n` does not know curl's options, and the install-test workflow runs
  // only on release and fetches install.sh from main, not from the tree under
  // test. So hand the flag set to the real curl once. No network: port 1 is
  // closed, exit 7 means the options parsed, exit 2 means one did not.
  test("the real curl on this machine accepts the flag set", async () => {
    const curl = Bun.which("curl");
    expect(curl).not.toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "install-curl-flags-"));
    const sourced = join(dir, "installer.sh");
    await Bun.write(sourced, INSTALLER_BODY);
    try {
      const proc = Bun.spawn(
        [
          "bash",
          "-c",
          'source "$1"; curl "${CURL_TLS_ARGS[@]}" -sS -o /dev/null --max-time 5 https://127.0.0.1:1/x',
          "--",
          sourced,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;
      // The message names the offending option, so assert on it first: it is
      // the readable half of the failure. The exit code is the backstop.
      expect(stderr).not.toContain("is unknown");
      // 2 is curl's "failed to initialize", which is what a bad option exits.
      expect(code).not.toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

// A self install killed by a signal now finishes by hand: install.sh lays the
// release out itself (the binary never got to its trivial file work), then
// proves the installed binary runs. A binary that will not run reports under
// its own step with the paths already in place (#2023).
describe("by-hand install after a killed self install (#2023)", () => {
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "install-by-hand-"));
    return { dir, home: join(dir, "home"), bin: join(dir, "bin"), tmp: join(dir, "tmp") };
  };
  const fakeBinary = (dir: string, name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const versionOnly = 'if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi\nkill -9 $$';
  const alwaysKilled = "kill -9 $$";

  test("kill codes map to verify_binary_killed, everything else to verify_binary", async () => {
    const { stdout } = await runWithCurlShim(
      'for c in 137 143 0 1 126; do printf "%s=%s\\n" "$c" "$(verify_binary_step_for_code "$c")"; done',
      { cut: "preamble" },
    );
    expect(stdout.trim().split("\n")).toEqual([
      "137=verify_binary_killed",
      "143=verify_binary_killed",
      "0=verify_binary",
      "1=verify_binary",
      "126=verify_binary",
    ]);
  });

  test("place_release_by_hand lays the release out the way self install does", async () => {
    const { dir, home, bin } = scratch();
    try {
      mkdirSync(bin, { recursive: true });
      // A dangling link is what an upgrade over a pruned release leaves behind
      // (#132): it must be replaced, not tripped over.
      symlinkSync(join(dir, "gone"), join(bin, "squirrel"));
      const binary = fakeBinary(dir, "downloaded", versionOnly);
      const { stdout, code } = await runWithCurlShim(
        `place_release_by_hand "${binary}" v9.9.9 "${bin}"`,
        { cut: "preamble", env: { HOME: home } },
      );
      expect(code).toBe(0);
      const target = join(home, ".squirrel", "releases", "9.9.9", "squirrel");
      expect(stdout).toBe(target);
      expect(statSync(target).mode & 0o755).toBe(0o755);
      expect(readlinkSync(join(bin, "squirrel"))).toBe(target);
      const settings = JSON.parse(readFileSync(join(home, ".squirrel", "settings.json"), "utf8"));
      expect(settings).toEqual({ install_bin_dir: bin });
      expect(statSync(join(home, ".squirrel", "settings.json")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["without jq, value replaced", "false", '{\n  "channel": "beta",\n  "install_bin_dir": null\n}\n'],
    ["without jq, key inserted", "false", '{\n  "channel": "beta",\n  "telemetry": false\n}\n'],
    ["without jq, one-line file", "false", '{"channel":"beta","install_bin_dir":null}'],
    ["with jq", "true", '{"channel":"beta","install_bin_dir":"/old"}'],
  ])("record_install_bin_dir keeps existing settings (%s)", async (_name, useJq, existing) => {
    if (useJq === "true" && !Bun.which("jq")) return;
    const { dir, home } = scratch();
    // `&`, `#` and `$` are the characters a sed or ${var/../..} replacement
    // would give a meaning to (codex review); the recorded path must be verbatim.
    const bin = join(dir, "a&b#c$x");
    try {
      mkdirSync(join(home, ".squirrel"), { recursive: true });
      const settingsPath = join(home, ".squirrel", "settings.json");
      writeFileSync(settingsPath, existing);
      // Single-quoted for bash: the path carries a `$`.
      const { code, stderr } = await runWithCurlShim(
        `record_install_bin_dir "${settingsPath}" '${bin}'`,
        { cut: "preamble", env: { HOME: home, USE_JQ: useJq } },
      );
      expect(code).toBe(0);
      expect(stderr).not.toContain("Warning");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(settings.channel).toBe("beta");
      expect(settings.install_bin_dir).toBe(bin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without jq, an empty object gains the key with no trailing comma", async () => {
    const { dir, home, bin } = scratch();
    try {
      mkdirSync(join(home, ".squirrel"), { recursive: true });
      const settingsPath = join(home, ".squirrel", "settings.json");
      writeFileSync(settingsPath, "{}\n");
      const { code } = await runWithCurlShim(`record_install_bin_dir "${settingsPath}" "${bin}"`, {
        cut: "preamble",
        env: { HOME: home, USE_JQ: "false" },
      });
      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ install_bin_dir: bin });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without jq, a recorded directory is left byte-for-byte alone", async () => {
    const { dir, home, bin } = scratch();
    try {
      mkdirSync(join(home, ".squirrel"), { recursive: true });
      const settingsPath = join(home, ".squirrel", "settings.json");
      // An escaped quote inside the value is what a naive regex stops at.
      const existing = '{"install_bin_dir":"/old\\"name","telemetry":false}';
      writeFileSync(settingsPath, existing);
      const { code, stderr } = await runWithCurlShim(
        `record_install_bin_dir "${settingsPath}" "${bin}"`,
        { cut: "preamble", env: { HOME: home, USE_JQ: "false" } },
      );
      expect(code).toBe(0);
      expect(stderr).toContain("already records an install directory");
      expect(readFileSync(settingsPath, "utf8")).toBe(existing);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a path that cannot be a plain JSON string is left unrecorded, not mangled", async () => {
    const { dir, home } = scratch();
    try {
      const settingsPath = join(home, ".squirrel", "settings.json");
      const { code, stderr } = await runWithCurlShim(
        `record_install_bin_dir "${settingsPath}" '${join(dir, 'we"ird')}'`,
        { cut: "preamble", env: { HOME: home } },
      );
      expect(code).toBe(0);
      expect(stderr).toContain("Not recording");
      expect(existsSync(settingsPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a binary that runs after the kill completes the install", async () => {
    const { dir, home, bin, tmp } = scratch();
    try {
      mkdirSync(tmp, { recursive: true });
      const binary = fakeBinary(dir, "downloaded", versionOnly);
      const { code, stdout, stderr, calls } = await runWithCurlShim(
        `TMPDIR_TO_CLEAN="${tmp}"; install_by_hand_and_verify "${binary}" v9.9.9 "${bin}" 137`,
        { env: { HOME: home } },
      );
      expect(code).toBe(0);
      expect(stdout).toContain("9.9.9");
      expect(stderr).toContain("killed by the system (exit 137, SIGKILL)");
      expect(stderr).toContain("Installed by hand");
      expect(readlinkSync(join(bin, "squirrel"))).toBe(
        join(home, ".squirrel", "releases", "9.9.9", "squirrel"),
      );
      // A completed install is not a failure: nothing is reported.
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a binary that cannot run reports under verify_binary_killed with the paths in place", async () => {
    const { dir, home, bin, tmp } = scratch();
    try {
      mkdirSync(tmp, { recursive: true });
      const binary = fakeBinary(dir, "downloaded", alwaysKilled);
      const { code, stderr, calls } = await runWithCurlShim(
        `TMPDIR_TO_CLEAN="${tmp}"; install_by_hand_and_verify "${binary}" v9.9.9 "${bin}" 137`,
        { env: { HOME: home, NO_TELEMETRY: undefined }, settleMs: 5000 },
      );
      expect(code).toBe(1);
      const target = join(home, ".squirrel", "releases", "9.9.9", "squirrel");
      // The files ARE installed; the message says where, and what to do that
      // is not "retry".
      expect(existsSync(target)).toBe(true);
      expect(stderr).toContain(`Binary: ${target}`);
      expect(stderr).toContain("squirrel --version");
      expect(stderr).toContain("https://app.squirrelscan.com");
      expect(stderr).not.toContain("Re-run this installer");
      expect(calls).toHaveLength(1);
      const report = JSON.parse(curlDataArg(calls[0])) as Record<string, unknown>;
      expect(report.step).toBe("verify_binary_killed");
      expect(report.exit_code).toBe(137);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

// --- the mirror fallback (#2064) ------------------------------------------
// GitHub release-asset URLs redirect to release-assets.githubusercontent.com,
// which some networks cannot reach. Every asset now has a second source at
// install.squirrelscan.com/dl.
describe("release asset download falls back to the mirror (#2064)", () => {
  const GITHUB_ASSET =
    "https://github.com/squirrelscan/squirrelscan/releases/download/v1.2.3/squirrel-1.2.3-linux-x64";
  const MIRROR_ASSET =
    "https://install.squirrelscan.com/dl/v1.2.3/squirrel-1.2.3-linux-x64";
  const fetchAsset =
    'out=$(mktemp); fetch_release_asset v1.2.3 squirrel-1.2.3-linux-x64 "$out" binary; rc=$?; cat "$out"; rm -f "$out"; exit $rc';

  test("GitHub is tried first and the mirror is not touched when it answers", async () => {
    const { calls, code, stdout } = await runWithCurlShim(fetchAsset, { body: "BYTES" });
    expect(code).toBe(0);
    expect(stdout).toContain("BYTES");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(GITHUB_ASSET);
  });

  test("a blocked github.com is followed by the mirror, and the bytes still arrive", async () => {
    const { calls, code, stdout, stderr } = await runWithCurlShim(fetchAsset, {
      body: "BYTES",
      failMatch: "github.com",
    });
    expect(code).toBe(0);
    expect(stdout).toContain("BYTES");
    // Three attempts at GitHub (fetch_with_retry), then the mirror answers.
    expect(calls.filter((argv) => argv.some((a) => a.includes(GITHUB_ASSET)))).toHaveLength(3);
    expect(calls[calls.length - 1]).toContain(MIRROR_ASSET);
    expect(stderr).toContain("trying install.squirrelscan.com");
  }, 30_000);

  test("the mirror leg is hardened like every other curl", async () => {
    const { calls } = await runWithCurlShim(fetchAsset, {
      body: "BYTES",
      failMatch: "github.com",
    });
    expect(calls.map(missingFromArgv)).toEqual(calls.map(() => []));
  }, 30_000);

  test("SQUIRREL_FORCE_MIRROR skips github.com entirely", async () => {
    const { calls, code } = await runWithCurlShim(fetchAsset, {
      body: "BYTES",
      env: { SQUIRREL_FORCE_MIRROR: "1" },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(MIRROR_ASSET);
    // The exact URL, not a "github.com" substring: fetch_release_asset builds
    // only this one GitHub URL, so its absence is the whole claim, and a
    // substring host test is the shape of a real sanitiser bug elsewhere.
    expect(calls.flat()).not.toContain(GITHUB_ASSET);
  });

  test.each([
    ["", false],
    ["0", false],
    ["false", false],
    ["FALSE", false],
    ["  ", false],
    ["1", true],
    ["true", true],
    ["yes", true],
  ])("SQUIRREL_FORCE_MIRROR=%p enables the mirror-only path: %p", async (value, expected) => {
    // Value semantics, not presence: a stray empty assignment in a profile must
    // not silently reroute every install (SQUIRREL_NO_UPDATE reads the same).
    const { code } = await runWithCurlShim("force_mirror_enabled", {
      env: { SQUIRREL_FORCE_MIRROR: value },
    });
    expect(code === 0).toBe(expected);
  });

  test("SQUIRREL_DOWNLOAD_ENDPOINT redirects the mirror leg", async () => {
    const { calls } = await runWithCurlShim(fetchAsset, {
      body: "BYTES",
      env: {
        SQUIRREL_FORCE_MIRROR: "1",
        SQUIRREL_DOWNLOAD_ENDPOINT: "https://mirror.test/dl",
      },
    });
    expect(calls[0]).toContain("https://mirror.test/dl/v1.2.3/squirrel-1.2.3-linux-x64");
  });

  test("both sources failing leaves both URLs for the report", async () => {
    const { code, stdout } = await runWithCurlShim(
      'out=$(mktemp); fetch_release_asset v1.2.3 squirrel-1.2.3-linux-x64 "$out" binary || true; rm -f "$out"; download_failure_output',
      { body: "BYTES", failMatch: "http" },
    );
    expect(code).toBe(0);
    expect(stdout).toContain(`tried ${GITHUB_ASSET} (failed)`);
    expect(stdout).toContain(`tried ${MIRROR_ASSET} (failed)`);
  }, 30_000);

  test("a secret anywhere in the mirror URL is gone before it is shown or reported", async () => {
    // SQUIRREL_DOWNLOAD_ENDPOINT is user-supplied and a token can hide in the
    // userinfo, the query or the fragment. The report scrubber strips home
    // paths and clamps length; it knows nothing about URL structure.
    const { stdout } = await runWithCurlShim(
      'DOWNLOAD_URL_GITHUB="https://github.com/x/y"; DOWNLOAD_URL_MIRROR="https://alice:dummy-secret@mirror.test/dl/a?token=querysecret#fragsecret"; download_failure_output; download_failure_guidance a binary /tmp/bin',  // pragma: allowlist secret -- a synthetic credential is the input under test
    );
    for (const secret of ["dummy-secret", "querysecret", "fragsecret"]) {
      expect(stdout).not.toContain(secret);
    }
    // Still enough to tell which host was tried, which is why we carry it.
    expect(stdout).toContain("https://mirror.test/dl/a");
  });

  test("the telemetry payload itself carries no part of a credentialed endpoint", async () => {
    // The helper being clean is not the claim; what leaves the machine is.
    const { calls } = await runWithCurlShim(
      'CURRENT_STEP=download_binary; DOWNLOAD_URL_GITHUB="https://github.com/x/y"; DOWNLOAD_URL_MIRROR="https://u:pw@host/x?token=y#z"; report_error download_binary 1 "$(download_failure_report_line binary)" "$(download_failure_output)"; sleep 1',  // pragma: allowlist secret -- a synthetic credential is the input under test
      { env: { NO_TELEMETRY: undefined }, settleMs: 5000 },
    );
    const payload = calls[0]?.[calls[0].indexOf("--data") + 1] ?? "";
    expect(payload).not.toBe("");
    for (const secret of ["pw@", "token=y", "#z"]) {
      expect(payload).not.toContain(secret);
    }
    expect(payload).toContain("https://host/x");
    expect(JSON.parse(payload).step).toBe("download_binary");
  }, 15_000);

  test("redaction leaves an ordinary URL and an @ in the path alone", async () => {
    const { stdout } = await runWithCurlShim(
      'redact_url "https://install.squirrelscan.com/dl/v1/a"; echo; redact_url "https://host/p@th/a"',
    );
    expect(stdout.trim().split("\n")).toEqual([
      "https://install.squirrelscan.com/dl/v1/a",
      "https://host/p@th/a",
    ]);
  });

  test("the printed recipe survives a bin dir with a space, a quote and a dollar", async () => {
    // The recipe is meant to be copy-pasted, so it has to be valid shell for
    // the path this run actually resolved.
    const { stdout } = await runWithCurlShim(
      `download_failure_guidance asset binary "/tmp/Test User/it's \\$weird/bin"`,
    );
    const recipe = stdout.split("\n").find((l) => l.includes("mv asset")) ?? "";
    expect(recipe).toContain(`mkdir -p '/tmp/Test User/it'\\''s $weird/bin'`);
    // Round-trip it: eval must reproduce exactly one argument.
    const check = await runWithCurlShim(
      `set -- ${recipe.slice(recipe.indexOf("mv asset") + "mv asset ".length)}; echo "$#"; echo "$1"`,
    );
    expect(check.stdout.trim().split("\n")).toEqual([
      "1",
      "/tmp/Test User/it's $weird/bin/squirrel",
    ]);
  });

  test("a skipped GitHub leg is reported as skipped, not failed", async () => {
    const { stdout } = await runWithCurlShim(
      'DOWNLOAD_URL_GITHUB="https://github.com/x/y"; DOWNLOAD_URL_MIRROR="https://m.test/dl/a"; download_failure_output',
      { env: { SQUIRREL_FORCE_MIRROR: "1" } },
    );
    expect(stdout).toContain("skipped https://github.com/x/y (SQUIRREL_FORCE_MIRROR)");
    expect(stdout).toContain("tried https://m.test/dl/a (failed)");
    expect(stdout).not.toContain("tried https://github.com/x/y (failed)");
  });

  test("the reported line names the escape hatch, and changes when it is already set", async () => {
    const normal = await runWithCurlShim("download_failure_report_line binary");
    expect(normal.stdout).toContain("SQUIRREL_FORCE_MIRROR=1");
    const forced = await runWithCurlShim("download_failure_report_line binary", {
      env: { SQUIRREL_FORCE_MIRROR: "1" },
    });
    expect(forced.stdout).toContain("github.com was skipped");
    expect(forced.stdout).not.toContain("retry with SQUIRREL_FORCE_MIRROR=1");
  });

  test("the reported line names both hosts and stays inside ERROR_LINE_MAX", async () => {
    // Two full asset URLs are ~170 chars and would be truncated out of
    // error_line, so the hosts go there and the URLs ride in error_output.
    const { stdout } = await runWithCurlShim(
      'download_failure_report_line binary; echo "MAX=$ERROR_LINE_MAX"',
    );
    const [line, max] = stdout.trim().split("\n");
    expect(line).toContain("github.com");
    expect(line).toContain("install.squirrelscan.com");
    expect(line.length).toBeLessThanOrEqual(Number(max.replace("MAX=", "")));
  });

  test("the retry recipe puts the flag on the bash side of the pipe", async () => {
    // `VAR=1 curl … | bash` sets VAR for curl, not for the bash that runs the
    // script, so the recipe would be a no-op written that way.
    const { stdout } = await runWithCurlShim(
      'download_failure_guidance squirrel-1.2.3-linux-x64 binary /home/u/.local/bin',
    );
    expect(stdout).toContain(
      "curl -fsSL https://install.squirrelscan.com | SQUIRREL_FORCE_MIRROR=1 bash",
    );
    expect(stdout).not.toMatch(/SQUIRREL_FORCE_MIRROR=1\s+curl/);
  });

  test("the by-hand recipe is offered for a binary and withheld for a manifest", async () => {
    // Telling someone to mv a manifest.json to <bin>/squirrel is worse than
    // saying nothing.
    const binary = await runWithCurlShim(
      'download_failure_guidance squirrel-1.2.3-linux-x64 binary /home/u/.local/bin',
    );
    expect(binary.stdout).toContain(
      "mv squirrel-1.2.3-linux-x64 '/home/u/.local/bin/squirrel'",
    );

    const manifest = await runWithCurlShim(
      'download_failure_guidance manifest.json manifest /home/u/.local/bin',
    );
    expect(manifest.stdout).not.toContain("mv manifest.json");
    expect(manifest.stdout).toContain("Allowlist github.com or install.squirrelscan.com");
  });

  test("guidance says github was skipped rather than printing a URL it never tried", async () => {
    const { stdout } = await runWithCurlShim(
      'download_failure_guidance squirrel-1.2.3-linux-x64 binary /home/u/.local/bin',
      { env: { SQUIRREL_FORCE_MIRROR: "1" } },
    );
    expect(stdout).toContain("skipped (SQUIRREL_FORCE_MIRROR is set)");
    expect(stdout).not.toContain("If github.com is blocked on this network");
  });

  test("both download steps go through the two-source helper, not a bare GitHub URL", () => {
    // A call site that reconstructs the GitHub URL by hand would silently lose
    // the fallback, and nothing else here would notice.
    expect(shellInstaller).toContain(
      'fetch_release_asset "$version" "manifest.json" "$tmpdir/manifest.json" "manifest"',
    );
    expect(shellInstaller).toContain(
      'fetch_release_asset "$version" "$filename" "$tmpdir/squirrel" "binary"',
    );
    const downloadUrls = shellInstaller.match(/https:\/\/github\.com\/\$\{REPO\}\/releases\/download/g);
    expect(downloadUrls).toHaveLength(1); // only the one inside fetch_release_asset
  });

  test("a 200 carrying HTML is a failed source, not a manifest", async () => {
    // A captive portal, a proxy error page and an index-for-every-path bucket
    // all return HTML with a 200. Before this, that reached jq, which died, and
    // `set -e` took the script down with an empty report: exit 5, no message,
    // no URLs.
    const html = "<!DOCTYPE html><html><body>Sign in to continue</body></html>";
    const { code, stderr } = await runWithCurlShim(
      'USE_JQ=true; out=$(mktemp); fetch_release_asset v1.2.3 manifest.json "$out" manifest manifest_looks_valid; rc=$?; rm -f "$out"; exit $rc',
      { body: html },
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain("returned something that is not a manifest");
  }, 30_000);

  test.each([
    ["an HTML page", "<!DOCTYPE html><html><body>hi</body></html>", false],
    ["an empty body", "", false],
    ["valid JSON that is not a manifest", '{"message":"Not Found"}', false],
    ["a JSON array", "[]", false],
    ["a real manifest", '{"version":"1.2.3","binaries":{"linux-x64":{"filename":"f","sha256":"s"}}}', true],
  ])("manifest_looks_valid rejects %s", async (_name, body, expected) => {
    const { code } = await runWithCurlShim(
      `USE_JQ=true; f=$(mktemp); printf '%s' ${JSON.stringify(body)} > "$f"; manifest_looks_valid "$f"; rc=$?; rm -f "$f"; exit $rc`,
    );
    expect(code === 0).toBe(expected);
  });

  test("manifest_looks_valid agrees with itself without jq", async () => {
    // The grep fallback is the path a machine without jq takes, and it is the
    // one nobody exercises by hand.
    const real = '{"version":"1.2.3","binaries":{"linux-x64":{"filename":"f","sha256":"s"}}}';
    const html = "<!DOCTYPE html><html><body>hi</body></html>";
    const run = (body: string) =>
      runWithCurlShim(
        `USE_JQ=false; f=$(mktemp); printf '%s' ${JSON.stringify(body)} > "$f"; manifest_looks_valid "$f"; rc=$?; rm -f "$f"; exit $rc`,
      );
    expect((await run(real)).code).toBe(0);
    expect((await run(html)).code).not.toBe(0);
  });

  test("a GitHub HTML manifest falls through to the mirror instead of failing", async () => {
    // The recovery half: one bad source must not end the install.
    const { calls, code } = await runWithCurlShim(
      'USE_JQ=true; out=$(mktemp); fetch_release_asset v1.2.3 manifest.json "$out" manifest manifest_looks_valid; rc=$?; cat "$out"; rm -f "$out"; exit $rc',
      {
        // The shim answers every URL with the same body, so drive the GitHub leg
        // to fail outright and assert the mirror leg is what validates.
        body: '{"version":"1.2.3","binaries":{"linux-x64":{"filename":"f","sha256":"s"}}}',
        failMatch: "github.com",
      },
    );
    expect(code).toBe(0);
    expect(calls[calls.length - 1]).toContain(
      "https://install.squirrelscan.com/dl/v1.2.3/manifest.json",
    );
  }, 30_000);

  test("the GitHub path prints nothing new, so its output stays byte-identical", async () => {
    // Only a mirror download announces where it came from. Almost every install
    // takes the GitHub path and must look exactly as it did before.
    const { stdout, stderr } = await runWithCurlShim(
      'download_and_install_source_line() { :; }; fetch_release_asset v1.2.3 f "$(mktemp)" binary; echo "SOURCE=$DOWNLOAD_SOURCE"',
      { body: "BYTES" },
    );
    expect(`${stdout}${stderr}`).toContain("SOURCE=github.com");
    expect(`${stdout}${stderr}`).not.toContain("Downloaded from");
  });

  test("the source line is emitted only for the mirror", () => {
    // Guard the call site itself: the announcement lives behind the condition.
    expect(shellInstaller).toContain('if [ "$DOWNLOAD_SOURCE" != "github.com" ]; then');
    const announce = shellInstaller.match(/info "Downloaded from \$\{DOWNLOAD_SOURCE\}"/g);
    expect(announce).toHaveLength(1);
    expect(powershellInstaller).toContain('if ($script:DownloadSource -ne "github.com") {');
  });

  test("CI probes for pwsh instead of declaring it as the shell", () => {
    // `shell: pwsh` is resolved before the step's command runs, so on a runner
    // without pwsh the step dies with a shell-not-found error that reads like an
    // installer bug. Probing from bash degrades to a skip.
    expect(ciWorkflow).not.toContain("shell: pwsh\n");
    expect(ciWorkflow).toContain("if ! command -v pwsh > /dev/null 2>&1; then");
    expect(ciWorkflow).toContain("::notice::pwsh is not available on this runner");
    expect(ciWorkflow).toContain("pwsh -NoProfile -File ./scripts/install-ps-contract.test.ps1");
  });

  test("the ps1 contract script parses the whole installer, not just the part it runs", () => {
    // It dot-sources only the text above `Main`, so a syntax error past that
    // point would otherwise ship unseen.
    expect(powershellContract).toContain("Parser]::ParseFile(");
    expect(powershellContract).toContain("$parseErrors");
  });

  test("both installers ship the same mirror env vars", () => {
    for (const script of [shellInstaller, powershellInstaller]) {
      expect(script).toContain("SQUIRREL_FORCE_MIRROR");
      expect(script).toContain("SQUIRREL_DOWNLOAD_ENDPOINT");
      expect(script).toContain("https://install.squirrelscan.com/dl");
    }
  });

  test("ps1 routes both downloads through the two-source helpers", () => {
    expect(powershellInstaller).toContain(
      'Get-ReleaseAssetJson -Version $Version -Asset "manifest.json" -Label "manifest"',
    );
    expect(powershellInstaller).toContain(
      'Get-ReleaseAsset -Version $Version -Asset $filename -OutFile $binaryPath -Label "binary"',
    );
    // No call site may rebuild a GitHub download URL outside Get-DownloadSources.
    const downloadUrls = powershellInstaller.match(
      /"https:\/\/github\.com\/\$Repo\/releases\/download/g,
    );
    expect(downloadUrls).toHaveLength(1);
  });

  test("ps1 guards the script-scope bin dir against a missing LOCALAPPDATA", () => {
    // Join-Path throws on a null Path, and at script scope under
    // $ErrorActionPreference = "Stop" that kills the installer on line one,
    // before the banner, in any environment without LOCALAPPDATA.
    expect(powershellInstaller).toContain("$script:InstallBinDir = if ($env:LOCALAPPDATA) {");
    expect(powershellInstaller).not.toMatch(
      /\$script:InstallBinDir = Join-Path \$env:LOCALAPPDATA/,
    );
  });

  test("ps1 deletes a partial download before trying the next source", () => {
    // Invoke-WebRequest -OutFile leaves the partial file behind, and the mirror
    // leg would then be asked to overwrite it.
    expect(powershellInstaller).toContain(
      "if (Test-Path $OutFile) { Remove-Item -Path $OutFile -Force -ErrorAction SilentlyContinue }",
    );
  });
});
