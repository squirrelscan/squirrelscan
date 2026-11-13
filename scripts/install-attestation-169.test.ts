// install.sh release provenance check (#169): `gh attestation verify` on the downloaded binary.
// gh present and matching installs, gh present and mismatching fails with nothing installed, gh absent
// (or too old, or logged out) warns and falls back to the sha256 check. Whole-installer runs use shims
// for curl, uname and gh in a throwaway HOME and TMPDIR; the absent case sources the function library
// with a PATH that holds no gh at all.

import { assertInstallerEnvCannotReachProduction, DEAD_ERROR_ENDPOINT } from "./install-test-env";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installer = new URL("../install.sh", import.meta.url).pathname;
const installerText = readFileSync(installer, "utf8");
const INSTALLER_BODY = installerText.slice(0, installerText.lastIndexOf('\nmain "$@"'));

const pending: string[] = [];
afterAll(() => {
  for (const root of pending) rmSync(root, { recursive: true, force: true });
});

const FAKE_BINARY = `#!/bin/sh
echo "ran" > "$HOME/ran.txt"
if [ "$1" = "self" ] && [ "$2" = "install" ]; then
  mkdir -p "$4"
  echo '#!/bin/sh' > "$4/squirrel"
  chmod 755 "$4/squirrel"
  exit 0
fi
echo "squirrel 9.9.9"
`;

const CURL_SHIM = `#!/bin/bash
out=""; prev=""; url=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  case "$a" in https://*) url="$a" ;; esac
  prev="$a"
done
case "$url" in
  */manifest.json) [ -n "$out" ] && cp "$SHIM_MANIFEST" "$out"; exit 0 ;;
  */squirrel-linux-x64) [ -n "$out" ] && cp "$SHIM_BINARY" "$out"; exit 0 ;;
  */error) exit 0 ;;
esac
exit 22
`;

// Answers per subcommand from GH_* env, and logs the argv of every call.
const GH_SHIM = `#!/bin/bash
{ for a in "$@"; do printf '%s\\0' "$a"; done; printf '\\036'; } >> "$GH_LOG"
label=verify
[ "$1" = "auth" ] && label=auth
[ "$1" = "attestation" ] && [ "$3" = "--help" ] && label=help
if [ "$label" = "$GH_HANG" ]; then exec sleep 30; fi
if [ "$1" = "auth" ]; then echo "$*" > "$GH_AUTH_ARGS"; exit "\${GH_AUTH_EXIT:-0}"; fi
if [ "$1" = "attestation" ] && [ "$2" = "verify" ]; then
  if [ "$3" = "--help" ]; then exit "\${GH_HELP_EXIT:-0}"; fi
  if [ "\${GH_VERIFY_EXIT:-0}" != 0 ]; then echo "verification failed: no attestation found for digest"; fi
  exit "\${GH_VERIFY_EXIT:-0}"
fi
exit 99
`;

interface Result {
  root: string;
  home: string;
  stdout: string;
  stderr: string;
  code: number;
  /** One entry per gh call, each the argv. */
  ghCalls: string[][];
}

async function install(ghEnv: Record<string, string> | null): Promise<Result> {
  const root = mkdtempSync(join(tmpdir(), "install-169-"));
  pending.push(root);
  const home = join(root, "home");
  const shims = join(root, "shims");
  const tmp = join(root, "tmp");
  for (const dir of [home, shims, tmp]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(shims, "curl"), CURL_SHIM, { mode: 0o755 });
  writeFileSync(
    join(shims, "mktemp"),
    `#!/bin/bash\nif [ "$1" = "-d" ] && [ -z "$2" ]; then exec /usr/bin/mktemp -d "$TMPDIR/tmp.XXXXXX"; fi\nexec /usr/bin/mktemp "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(shims, "uname"),
    `#!/bin/sh\ncase "$1" in -m) echo x86_64 ;; *) echo Linux ;; esac\n`,
    { mode: 0o755 },
  );
  if (ghEnv) writeFileSync(join(shims, "gh"), GH_SHIM, { mode: 0o755 });
  const binaryPath = join(root, "release-binary");
  writeFileSync(binaryPath, FAKE_BINARY);
  const manifestPath = join(root, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: "9.9.9",
      binaries: {
        "linux-x64": {
          filename: "squirrel-linux-x64",
          sha256: createHash("sha256").update(FAKE_BINARY).digest("hex"),
          size: Buffer.byteLength(FAKE_BINARY),
        },
      },
    }),
  );
  const ghLog = join(root, "gh.log");
  const env: Record<string, string> = {
    PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    TMPDIR: tmp,
    SHIM_MANIFEST: manifestPath,
    SHIM_BINARY: binaryPath,
    GH_LOG: ghLog,
    GH_AUTH_ARGS: join(root, "auth-args"),
    SQUIRREL_VERSION: "9.9.9",
    SQUIRREL_BIN_DIR: join(home, "bin"),
    SQUIRREL_NO_MODIFY_PATH: "1",
    CI: "true",
    LC_ALL: "C",
    SQUIRREL_ERROR_ENDPOINT: DEAD_ERROR_ENDPOINT,
    ...ghEnv,
  };
  assertInstallerEnvCannotReachProduction(env);
  const proc = Bun.spawn(["bash", installer], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const ghCalls = existsSync(ghLog)
    ? readFileSync(ghLog, "utf8")
        .split("\x1e")
        .filter((c) => c.length > 0)
        .map((c) => c.split("\0").filter((a) => a.length > 0))
    : [];
  return { root, home, stdout, stderr, code, ghCalls };
}

describe("install.sh release attestation (#169)", () => {
  test("gh present and the attestation matches: verifies the downloaded file against the repo and installs", async () => {
    const r = await install({});
    expect(r.stderr).not.toContain("Error:");
    expect(r.code).toBe(0);
    const verify = r.ghCalls.find((c) => c[0] === "attestation" && c[1] === "verify" && c[2] !== "--help");
    expect(verify).toBeDefined();
    expect(verify![2]).toMatch(/\/squirrel$/);
    expect(verify!.slice(3)).toEqual([
      "--repo",
      "squirrelscan/squirrelscan",
      "--cert-identity",
      "https://github.com/squirrelscan/squirrelscan/.github/workflows/release.yml@refs/heads/main",
      "--deny-self-hosted-runners",
    ]);
    expect(r.stderr).toContain("Attestation verified");
    expect(existsSync(join(r.home, "bin", "squirrel"))).toBe(true);
  }, 60_000);

  test("gh present and the attestation does not match: fails and nothing is installed or run", async () => {
    const r = await install({ GH_VERIFY_EXIT: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Attestation verification failed");
    expect(r.stderr).toContain("verification failed: no attestation found");
    expect(r.stderr).toContain("Nothing was installed");
    expect(existsSync(join(r.home, "ran.txt"))).toBe(false);
    expect(existsSync(join(r.home, "bin", "squirrel"))).toBe(false);
  }, 60_000);

  test("gh present but not logged in: warns and falls back to sha256, never calls verify", async () => {
    const r = await install({ GH_AUTH_EXIT: "1", GH_VERIFY_EXIT: "1" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("gh is not logged in");
    expect(r.ghCalls.some((c) => c[0] === "attestation" && c[2] !== "--help")).toBe(false);
  }, 60_000);

  test("gh too old for the attestation command: warns and falls back", async () => {
    const r = await install({ GH_HELP_EXIT: "1", GH_VERIFY_EXIT: "1" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("too old");
  }, 60_000);

  test("auth status is pinned to github.com", async () => {
    const r = await install({});
    expect(readFileSync(join(r.root, "auth-args"), "utf8").trim()).toBe("auth status --hostname github.com");
  }, 60_000);

  test("a probe that hangs is killed: a warning, then the sha256 check decides", async () => {
    for (const hang of ["help", "auth"]) {
      const started = Date.now();
      const r = await install({ GH_HANG: hang, SQUIRREL_TEST_GH_TIMEOUT_SECS: "1" });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("timed out after");
      expect(r.stderr).toContain("skipping the release provenance check");
      expect(r.ghCalls.some((c) => c[0] === "attestation" && c[2] !== "--help")).toBe(false);
      expect(Date.now() - started).toBeLessThan(25_000);
    }
  }, 90_000);

  test("a verify that hangs fails closed and nothing is installed", async () => {
    const r = await install({ GH_HANG: "verify", SQUIRREL_TEST_GH_TIMEOUT_SECS: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("gh attestation verify timed out after");
    expect(r.stderr).toContain("nothing was installed");
    expect(existsSync(join(r.home, "ran.txt"))).toBe(false);
    expect(existsSync(join(r.home, "bin", "squirrel"))).toBe(false);
  }, 60_000);

  test("without timeout/gtimeout (macOS) the watchdog still kills a hung gh", async () => {
    const root = mkdtempSync(join(tmpdir(), "install-169-wd-"));
    pending.push(root);
    const lib = join(root, "installer-lib.sh");
    writeFileSync(lib, INSTALLER_BODY);
    // A PATH with gh and the few tools the function needs, and no timeout.
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const tool of ["sleep", "mktemp", "cat", "rm", "tail"]) {
      for (const dir of ["/usr/bin", "/bin"]) {
        if (existsSync(join(dir, tool))) {
          symlinkSync(join(dir, tool), join(bin, tool));
          break;
        }
      }
    }
    writeFileSync(join(bin, "gh"), "#!/bin/bash\nexec sleep 30\n", { mode: 0o755 });
    const started = Date.now();
    const proc = Bun.spawn(
      ["bash", "-c", 'source "$1"; PATH="$2"; rc=0; gh_bounded 15 "$3" attestation verify || rc=$?; echo "rc=$rc"', "--", lib, bin, join(root, "out")],
      {
        env: { HOME: root, TMPDIR: root, NO_TELEMETRY: "1", LC_ALL: "C", PATH: "/usr/bin:/bin", SQUIRREL_TEST_GH_TIMEOUT_SECS: "1" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(stdout).toContain("rc=124");
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);

  test("the attestation check runs after the checksum one", async () => {
    const r = await install({ GH_VERIFY_EXIT: "0" });
    expect(r.code).toBe(0);
    // The checksum line precedes the attestation line.
    expect(r.stderr.indexOf("Checksum verified")).toBeLessThan(r.stderr.indexOf("Attestation verified"));
  }, 60_000);

  test("gh absent: a visible warning, success, and the sha256 check still decides", async () => {
    const root = mkdtempSync(join(tmpdir(), "install-169-lib-"));
    pending.push(root);
    const lib = join(root, "installer-lib.sh");
    writeFileSync(lib, INSTALLER_BODY);
    const empty = join(root, "empty-path");
    mkdirSync(empty);
    const proc = Bun.spawn(
      ["bash", "-c", 'source "$1"; PATH="$2"; verify_attestation "$3"; echo "rc=$?"', "--", lib, empty, join(root, "bin")],
      {
        env: { HOME: root, TMPDIR: root, NO_TELEMETRY: "1", LC_ALL: "C", PATH: "/usr/bin:/bin" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stdout).toContain("rc=0");
    expect(stderr).toContain("GitHub CLI (gh) not found");
    expect(stderr).toContain("sha256 checksum only");
  }, 60_000);
});
