import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shellInstaller = await Bun.file(new URL("../install.sh", import.meta.url)).text();
const powershellInstaller = await Bun.file(new URL("../install.ps1", import.meta.url)).text();
const npmPostinstall = await Bun.file(
  new URL("../npm/scripts/postinstall.js", import.meta.url),
).text();

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
    const preambleEnd = shellInstaller.indexOf("trap report_on_exit EXIT");
    const preamble = join(tmpdir(), `install-kill-report-${process.pid}.sh`);
    await Bun.write(preamble, shellInstaller.slice(0, preambleEnd));

    const received: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        received.push((await request.json()) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      },
    });

    try {
      const proc = Bun.spawn(
        [
          "bash",
          "-c",
          'source "$1"; report_error "$(self_install_step_for_code 137)" 137 "killed" ""; sleep 1',
          "--",
          preamble,
        ],
        {
          env: {
            ...process.env,
            NO_TELEMETRY: undefined,
            SQUIRREL_ERROR_ENDPOINT: `http://127.0.0.1:${server.port}/error`,
          } as Record<string, string>,
        },
      );
      await proc.exited;
      for (let i = 0; i < 100 && received.length === 0; i++) await Bun.sleep(50);

      expect(received).toHaveLength(1);
      // Distinct from "self_install", which is what makes Sentry fingerprint
      // OOM kills apart from real self-install failures.
      expect(received[0].step).toBe("self_install_killed");
      expect(received[0].exit_code).toBe(137);
    } finally {
      server.stop(true);
      rmSync(preamble, { force: true });
    }
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
    const preambleEnd = shellInstaller.indexOf("trap report_on_exit EXIT");
    expect(preambleEnd).toBeGreaterThan(0);
    const preamble = join(tmpdir(), `install-preamble-${process.pid}.sh`);
    await Bun.write(preamble, shellInstaller.slice(0, preambleEnd));

    const received: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        received.push((await request.json()) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      },
    });

    try {
      const home = process.env.HOME ?? "";
      const output = `${"noise ".repeat(400)}EPERM: operation not permitted, symlink -> ${home}/.local/bin/squirrel`;
      // The reporter POSTs from a detached subshell, so give it a beat to land.
      const proc = Bun.spawn(
        [
          "bash",
          "-c",
          'source "$1"; report_error self_install 1 "Self install failed with exit code 1" "$2"; sleep 1',
          "--",
          preamble,
          output,
        ],
        {
          env: {
            ...process.env,
            NO_TELEMETRY: undefined,
            SQUIRREL_ERROR_ENDPOINT: `http://127.0.0.1:${server.port}/error`,
          } as Record<string, string>,
        },
      );
      await proc.exited;
      for (let i = 0; i < 100 && received.length === 0; i++) await Bun.sleep(50);

      expect(received).toHaveLength(1);
      const report = received[0];
      expect(report.step).toBe("self_install");
      expect(report.script_version).toBe("2");
      const errorOutput = report.error_output as string;
      expect(errorOutput.length).toBe(1000); // bounded
      // Tail kept: the failure is at the END of a command's output.
      expect(errorOutput).toEndWith("~/.local/bin/squirrel");
      if (home) expect(errorOutput).not.toContain(home);
    } finally {
      server.stop(true);
      rmSync(preamble, { force: true });
    }
  }, 15_000);
});
