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
