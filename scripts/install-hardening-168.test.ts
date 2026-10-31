// install.sh runtime hardening (#168): umask, size check, signal traps, bin dir and HOME guards,
// noexec temp dirs. Each test runs the WHOLE installer (bash install.sh) against a shimmed curl and
// uname and a fake release binary, in a throwaway HOME and TMPDIR, never touching the real ones.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installer = new URL("../install.sh", import.meta.url).pathname;
const installerText = readFileSync(installer, "utf8");
/** install.sh as a function library: everything above the final `main "$@"`. */
const INSTALLER_BODY = installerText.slice(0, installerText.lastIndexOf('\nmain "$@"'));

const pending: string[] = [];
afterAll(() => {
  for (const root of pending) rmSync(root, { recursive: true, force: true });
});

/** A fake release binary: records its own umask and where it ran from, and "installs" a file. */
const FAKE_BINARY = `#!/bin/sh
echo "ran-from=$0" > "$HOME/ran.txt"
echo "umask=$(umask)" >> "$HOME/ran.txt"
if [ "$1" = "self" ] && [ "$2" = "install" ]; then
  mkdir -p "$4"
  echo '#!/bin/sh' > "$4/squirrel"
  chmod 755 "$4/squirrel"
  echo "self install ok"
  exit 0
fi
echo "squirrel 9.9.9"
`;

// The curl shim answers the manifest and the binary from files, can stall on the binary (so a
// signal can arrive mid download), and logs every call, the failure report included.
const CURL_SHIM = `#!/bin/bash
{ for a in "$@"; do printf '%s\\0' "$a"; done; printf '\\036'; } >> "$SHIM_LOG"
out=""; prev=""; url=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  case "$a" in https://*) url="$a" ;; esac
  prev="$a"
done
case "$url" in
  */manifest.json) [ -n "$out" ] && cp "$SHIM_MANIFEST" "$out"; exit 0 ;;
  */squirrel-linux-x64)
    if [ -n "\${SHIM_STALL:-}" ]; then touch "$SHIM_STALL_MARK"; sleep 30 >/dev/null 2>&1; fi
    [ -n "$out" ] && cp "$SHIM_BINARY" "$out"; exit 0 ;;
  */error) exit 0 ;;
esac
exit 22
`;

// BSD mktemp ignores TMPDIR, so the installer's temp directory would escape the throwaway one.
const MKTEMP_SHIM = `#!/bin/bash
if [ "$1" = "-d" ] && [ -z "$2" ]; then exec /usr/bin/mktemp -d "$TMPDIR/tmp.XXXXXX"; fi
if [ -z "$1" ]; then exec /usr/bin/mktemp "$TMPDIR/tmp.XXXXXX"; fi
exec /usr/bin/mktemp "$@"
`;

// Models a noexec mount: a chmod +x on a file under SHIM_NOEXEC_DIR does nothing, so running it
// fails with the shell's own "Permission denied" (exit 126), and the same file chmod'ed anywhere
// else runs. SHIM_NOEXEC_ALL makes every chmod +x a no-op (both staging places are noexec).
const CHMOD_SHIM = `#!/bin/bash
if [ "$1" = "+x" ]; then
  case "$2" in
    "\${SHIM_NOEXEC_DIR:-/nonexistent}"/*) exit 0 ;;
  esac
  [ -n "\${SHIM_NOEXEC_ALL:-}" ] && exit 0
fi
exec /bin/chmod "$@"
`;

interface Options {
  env?: Record<string, string | undefined>;
  /** Replaces the binary the release serves. */
  binary?: string;
  /** Manifest overrides merged into the platform entry. */
  manifest?: Record<string, unknown>;
  unsetHome?: boolean;
  home?: (home: string) => void;
  stall?: boolean;
  /** `tmp`: the system temp dir is noexec, the staging dir is not. `all`: both are. */
  noexec?: "tmp" | "all";
  umask?: string;
  /** Run `fn` while the installer is running, with the paths in hand; resolves when it is done. */
  during?: (paths: Paths, proc: ReturnType<typeof Bun.spawn>) => Promise<void>;
}
interface Paths {
  root: string;
  home: string;
  tmp: string;
  shimLog: string;
  stallMark: string;
}
interface Result extends Paths {
  stdout: string;
  stderr: string;
  code: number;
}

async function install(options: Options = {}): Promise<Result> {
  const root = mkdtempSync(join(tmpdir(), "install-168-"));
  pending.push(root);
  const home = join(root, "home");
  const shims = join(root, "shims");
  const tmp = join(root, "tmp");
  for (const dir of [home, shims, tmp]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(shims, "curl"), CURL_SHIM, { mode: 0o755 });
  writeFileSync(join(shims, "mktemp"), MKTEMP_SHIM, { mode: 0o755 });
  writeFileSync(join(shims, "chmod"), CHMOD_SHIM, { mode: 0o755 });
  writeFileSync(
    join(shims, "uname"),
    `#!/bin/sh\ncase "$1" in -m) echo x86_64 ;; *) echo Linux ;; esac\n`,
    { mode: 0o755 },
  );
  const binaryPath = join(root, "release-binary");
  const binary = options.binary ?? FAKE_BINARY;
  writeFileSync(binaryPath, binary, { mode: 0o644 });
  const sha256 = createHash("sha256").update(binary).digest("hex");
  const manifestPath = join(root, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: "9.9.9",
      binaries: {
        "linux-x64": {
          filename: "squirrel-linux-x64",
          sha256,
          size: Buffer.byteLength(binary),
          ...options.manifest,
        },
      },
    }),
  );
  options.home?.(home);
  const paths: Paths = {
    root,
    home,
    tmp,
    shimLog: join(root, "shim.log"),
    stallMark: join(root, "stalled"),
  };

  const env: Record<string, string> = {
    PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: tmp,
    SHIM_LOG: paths.shimLog,
    SHIM_MANIFEST: manifestPath,
    SHIM_BINARY: binaryPath,
    SHIM_STALL_MARK: paths.stallMark,
    SQUIRREL_VERSION: "9.9.9",
    SQUIRREL_BIN_DIR: join(home, "bin"),
    SQUIRREL_NO_MODIFY_PATH: "1",
    CI: "true",
    LC_ALL: "C",
    ...(options.unsetHome ? {} : { HOME: home }),
  };
  if (options.stall) env.SHIM_STALL = "1";
  if (options.noexec === "tmp") env.SHIM_NOEXEC_DIR = tmp;
  if (options.noexec === "all") env.SHIM_NOEXEC_ALL = "1";
  for (const [k, v] of Object.entries(options.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const prefix = options.umask ? `umask ${options.umask}; ` : "";
  const proc = Bun.spawn(["bash", "-c", `${prefix}exec bash "$1"`, "--", installer], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Its own process group, so a test can signal the installer and its children together, as a
    // terminal does for Ctrl-C.
    detached: true,
  });
  const duringDone = options.during?.(paths, proc);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  await duringDone;
  return { ...paths, stdout, stderr, code };
}

const mode = (path: string): number => statSync(path).mode & 0o777;
const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

describe("a clean install works with the shims (the baseline the other tests change)", () => {
  test("installs, runs the binary from the temp dir and leaves no temp directory", async () => {
    const r = await install();
    expect(r.stderr).not.toContain("Error:");
    expect(r.code).toBe(0);
    expect(read(join(r.home, "ran.txt"))).toContain(`ran-from=${r.tmp}/tmp.`);
    expect(existsSync(join(r.home, "bin", "squirrel"))).toBe(true);
    expect(readdirSync(r.tmp)).toEqual([]);
  }, 60_000);
});

describe("umask (#168)", () => {
  test("a permissive inherited umask still gives nothing group or world writable", async () => {
    const r = await install({ umask: "0000" });
    expect(r.code).toBe(0);
    // The binary ran under the tightened umask, and what it created is not writable by others.
    expect(read(join(r.home, "ran.txt"))).toMatch(/umask=0*22/);
    expect(mode(join(r.home, "bin")) & 0o022).toBe(0);
    expect(mode(join(r.home, "bin", "squirrel")) & 0o022).toBe(0);
  }, 60_000);

  test("a stricter umask is kept, not loosened to 022", async () => {
    const r = await install({ umask: "0077" });
    expect(r.code).toBe(0);
    expect(read(join(r.home, "ran.txt"))).toMatch(/umask=0*77/);
    expect(mode(join(r.home, "bin")) & 0o077).toBe(0);
  }, 60_000);
});

describe("size check (#168)", () => {
  test("a download whose byte count differs from the manifest is rejected before hashing", async () => {
    const r = await install({ manifest: { size: 12345 } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Size mismatch");
    expect(r.stderr).toMatch(/is \d+ bytes, the release manifest says 12345/);
    expect(r.stderr).not.toContain("Checksum");
    expect(existsSync(join(r.home, "ran.txt"))).toBe(false);
  }, 60_000);

  test("a matching size passes on to the checksum, which still catches a wrong hash", async () => {
    const r = await install({ manifest: { sha256: "0".repeat(64) } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Checksum mismatch");
    expect(r.stderr).not.toContain("Size mismatch");
  }, 60_000);

  test("a manifest without a size, or with a size that is not a number, skips the check", async () => {
    const without = await install({ manifest: { size: undefined } });
    expect(without.code).toBe(0);
    const junk = await install({ manifest: { size: "lots" } });
    expect(junk.code).toBe(0);
  }, 120_000);

  test("the grep fallback reads a whole-number size, and nothing from a quoted or missing one", async () => {
    const body = (size: string) =>
      `{"binaries":{"linux-x64":{"filename":"f","sha256":"s",${size}}}}`;
    const script = (json: string) => `source "$1"; json_get_nested_number '${json}' linux-x64 size`;
    const sourced = join(mkdtempSync(join(tmpdir(), "install-168-src-")), "installer.sh");
    pending.push(join(sourced, ".."));
    writeFileSync(sourced, INSTALLER_BODY);
    const value = async (json: string): Promise<string> => {
      const proc = Bun.spawn(["bash", "-c", script(json), "--", sourced], {
        env: { HOME: tmpdir(), PATH: "/usr/bin:/bin", NO_TELEMETRY: "1", LC_ALL: "C" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out.trim();
    };
    expect(await value(body('"size": 4096'))).toBe("4096");
    expect(await value(body('"size":4096'))).toBe("4096");
    expect(await value(body('"size": "4096"'))).toBe("");
    expect(await value(body('"other": 1'))).toBe("");
  }, 30_000);
});

describe("signals (#168)", () => {
  for (const [name, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    test(`${name} during the download exits ${code}, removes the temp directory and files no report`, async () => {
      const r = await install({
        stall: true,
        // Telemetry on, so the report path runs through the curl shim and is logged.
        env: {
          CI: undefined,
          NO_TELEMETRY: undefined,
          DO_NOT_TRACK: undefined,
          SQUIRREL_NO_MODIFY_PATH: "1",
        },
        during: async (paths, proc) => {
          for (let i = 0; i < 200 && !existsSync(paths.stallMark); i++) await Bun.sleep(50);
          expect(existsSync(paths.stallMark)).toBe(true);
          // The temp directory exists mid-download.
          expect(readdirSync(paths.tmp).some((e) => e.startsWith("tmp."))).toBe(true);
          process.kill(-proc.pid, name);
        },
      });
      expect(r.code).toBe(code);
      expect(readdirSync(r.tmp)).toEqual([]);
      // A signal is the user stopping the run, not an installer failure: no report goes out (it would read
      // as a broken published binary on the worker's alerts).
      await Bun.sleep(500);
      expect(read(r.shimLog)).not.toContain("/error");
    }, 60_000);
  }
});

describe("two signals in a row (#168)", () => {
  test("HUP then INT a few ms apart still ends the installer (bash 3.2 lost the second one in a plain wait)", async () => {
    const r = await install({
      stall: true,
      during: async (paths, proc) => {
        for (let i = 0; i < 200 && !existsSync(paths.stallMark); i++) await Bun.sleep(50);
        process.kill(-proc.pid, "SIGHUP");
        process.kill(-proc.pid, "SIGINT");
      },
    });
    expect([129, 130]).toContain(r.code);
    expect(readdirSync(r.tmp)).toEqual([]);
  }, 60_000);
});

describe("SQUIRREL_BIN_DIR and HOME guards (#168)", () => {
  test.each([["/"], ["//"], ["///"], ["   "], [" / "], ["/."], ["/.."], ["/usr/.."], ["/a/../.."], ["/./"], ["/usr/../"], ["/*/.."]])(
    "SQUIRREL_BIN_DIR=%j aborts with a clear error",
    async (value) => {
      const r = await install({ env: { SQUIRREL_BIN_DIR: value } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("SQUIRREL_BIN_DIR");
      expect(r.stderr).toMatch(/filesystem root|only whitespace/);
      // Nothing was downloaded or run.
      expect(existsSync(join(r.home, "ran.txt"))).toBe(false);
      expect(read(r.shimLog)).not.toContain("squirrel-linux-x64");
    },
    60_000,
  );

  test("an empty SQUIRREL_BIN_DIR means not set: the default directory is used", async () => {
    const r = await install({ env: { SQUIRREL_BIN_DIR: "" } });
    expect(r.code).toBe(0);
    expect(existsSync(join(r.home, ".local", "bin", "squirrel"))).toBe(true);
  }, 60_000);

  test("an ordinary directory, with a trailing slash, still works", async () => {
    const dir = join(tmpdir(), `sq-168-bin-${process.pid}`);
    const r = await install({ env: { SQUIRREL_BIN_DIR: `${dir}/` } });
    pending.push(dir);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "squirrel"))).toBe(true);
  }, 60_000);

  test("a path that merely contains dots and is not the root is accepted", async () => {
    const dir = join(tmpdir(), `sq-168-dots-${process.pid}`);
    const r = await install({ env: { SQUIRREL_BIN_DIR: `${dir}/x/../bin` } });
    pending.push(dir);
    expect(r.code).toBe(0);
  }, 60_000);

  test("HOME unset: an actionable error, not an unbound variable", async () => {
    const r = await install({ unsetHome: true });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("HOME is not set");
    // The guard fires even with SQUIRREL_BIN_DIR set (the state lives under $HOME/.squirrel), so the
    // message says so and does not offer SQUIRREL_BIN_DIR as the way out.
    expect(r.stderr).toContain("even when SQUIRREL_BIN_DIR is set");
    expect(r.stderr).not.toContain("or choose the install directory");
    expect(r.stderr).not.toContain("unbound variable");
  }, 60_000);

  test("HOME empty is the same error", async () => {
    const r = await install({ env: { HOME: "" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("HOME is not set");
  }, 60_000);
});

describe("a signal sent to the installer alone (#168)", () => {
  for (const [name, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const) {
    test(`${name} to the installer PID alone is handled at once, mid-download, not after curl returns`, async () => {
      const started = performance.now();
      const r = await install({
        stall: true,
        env: { CI: undefined, NO_TELEMETRY: "1", DO_NOT_TRACK: undefined },
        during: async (paths, proc) => {
          for (let i = 0; i < 200 && !existsSync(paths.stallMark); i++) await Bun.sleep(50);
          expect(existsSync(paths.stallMark)).toBe(true);
          // Not the group: only the installer, so its curl child is not signalled by the kernel.
          process.kill(proc.pid, name);
        },
      });
      expect(r.code).toBe(code);
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(readdirSync(r.tmp)).toEqual([]);
    }, 60_000);
  }
});

describe("noexec temp directory (#168)", () => {
  test("falls back to ~/.squirrel/tmp, installs from there, and cleans the staging directory", async () => {
    const r = await install({ noexec: "tmp" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Trying ~/.squirrel/tmp");
    expect(read(join(r.home, "ran.txt"))).toContain(`ran-from=${r.home}/.squirrel/tmp/install.`);
    expect(existsSync(join(r.home, "bin", "squirrel"))).toBe(true);
    // Neither staging directory is left behind.
    expect(readdirSync(r.tmp)).toEqual([]);
    expect(readdirSync(join(r.home, ".squirrel", "tmp"))).toEqual([]);
  }, 60_000);

  test("when both places are noexec the error names noexec and how to get out of it", async () => {
    const r = await install({
      noexec: "all",
      env: { CI: undefined, NO_TELEMETRY: undefined, DO_NOT_TRACK: undefined },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("noexec");
    expect(r.stderr).toContain("TMPDIR=");
    expect(r.stderr).toContain("~/.squirrel/tmp");
    expect(readdirSync(r.tmp)).toEqual([]);
    expect(readdirSync(join(r.home, ".squirrel", "tmp"))).toEqual([]);
    // Reported under its own step, not as an ordinary self install failure.
    let log = "";
    for (let i = 0; i < 100 && !log.includes("self_install_noexec"); i++) {
      log = read(r.shimLog);
      if (!log.includes("self_install_noexec")) await Bun.sleep(50);
    }
    expect(log).toContain("self_install_noexec");
  }, 60_000);

  test("the detection does not depend on the language of any message", async () => {
    const r = await install({ noexec: "tmp", env: { LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8", LANGUAGE: "de" } });
    expect(r.code).toBe(0);
    expect(read(join(r.home, "ran.txt"))).toContain(`ran-from=${r.home}/.squirrel/tmp/install.`);
  }, 60_000);

  test("when ~/.squirrel/tmp cannot be created the error says that, not that noexec is the cause", async () => {
    const r = await install({
      noexec: "tmp",
      // `~/.squirrel` is a file: nothing can be created under it.
      home: (home) => writeFileSync(join(home, ".squirrel"), "not a directory"),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("could not be created");
    expect(r.stderr).toContain("$HOME/.squirrel is writable");
    expect(r.stderr).not.toContain("noexec is the likely cause");
    expect(readdirSync(r.tmp)).toEqual([]);
  }, 60_000);

  test("a binary that fails for another reason is not mistaken for noexec", async () => {
    const r = await install({ binary: "#!/bin/sh\necho boom >&2\nexit 3\n" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Self install failed with exit code 3");
    expect(r.stderr).not.toContain("noexec");
    expect(existsSync(join(r.home, ".squirrel", "tmp"))).toBe(false);
  }, 60_000);
});
