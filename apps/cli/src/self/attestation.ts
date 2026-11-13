import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Result, ok, err, commandError } from "@/controllers/types";

/**
 * Release provenance check (#169), the same policy as install.sh and
 * install.ps1.
 *
 * The sha256 in the release manifest is served from the same origin as the
 * binary, so it cannot tell a compromised origin from a good one. GitHub
 * artifact attestations are signed in the release workflow and verified against
 * Sigstore and GitHub, a trust root that is not our download origin.
 *
 *   gh usable, attestation matches    -> verified
 *   gh usable, attestation mismatch   -> ATTESTATION_FAILED, nothing installs
 *   gh absent, too old, or logged out -> skipped, the caller warns and the
 *                                        sha256 check alone decides
 *
 * `gh attestation verify` needs an authenticated gh, so a gh that is installed
 * but not logged in counts as absent, never as a pass.
 */
export const ATTESTATION_REPO = "squirrelscan/squirrelscan";
export const ATTESTATION_CERT_IDENTITY =
  "https://github.com/squirrelscan/squirrelscan/.github/workflows/release.yml@refs/heads/main";

export type AttestationOutcome =
  | { status: "verified" }
  | { status: "skipped"; reason: string };

/**
 * Result of one gh call. `null` from the runner means gh could not be started
 * (not installed). `code: null` means gh was killed at its deadline.
 */
export interface GhRun {
  code: number | null;
  output: string;
}
export type GhRunner = (
  args: string[],
  timeoutMs: number
) => Promise<GhRun | null>;

export interface AttestationDeps {
  /** Test seam: replaces spawning the real `gh`. */
  runGh?: GhRunner;
}

const PROBE_TIMEOUT_MS = 15_000;
const VERIFY_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_LINES = 10;
const OUTPUT_CAP_BYTES = 64 * 1024;

const PROBE_TIMEOUT_S = PROBE_TIMEOUT_MS / 1000;
const VERIFY_TIMEOUT_S = VERIFY_TIMEOUT_MS / 1000;

const defaultRunGh: GhRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn("gh", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GH_NO_UPDATE_NOTIFIER: "1",
          GH_PROMPT_DISABLED: "1",
        },
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let output = "";
    const collect = (chunk: Buffer) => {
      if (output.length < OUTPUT_CAP_BYTES) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });

const SKIP_NOT_FOUND =
  "GitHub CLI (gh) not found: skipping the release provenance check, relying on the sha256 checksum only. " +
  "Install gh and run 'gh auth login' to verify updates against the GitHub attestation.";
const skipTimedOut = (what: string) =>
  `${what} timed out after ${PROBE_TIMEOUT_S}s: skipping the release provenance check, relying on the sha256 checksum only.`;
const SKIP_TOO_OLD =
  "This gh is too old for 'gh attestation verify': skipping the release provenance check, relying on the sha256 checksum only.";
const SKIP_NOT_LOGGED_IN =
  "gh is not logged in: skipping the release provenance check, relying on the sha256 checksum only. " +
  "Run 'gh auth login' to enable it.";

/**
 * Verify the downloaded release binary against its GitHub attestation. The
 * attestation is matched on the file's digest, so the temp file's name does
 * not matter and a binary that differs by one byte fails.
 */
export async function verifyReleaseAttestation(
  data: ArrayBuffer,
  deps?: AttestationDeps
): Promise<Result<AttestationOutcome>> {
  const runGh = deps?.runGh ?? defaultRunGh;
  const skipped = (reason: string) =>
    ok<AttestationOutcome>({ status: "skipped", reason });

  const help = await runGh(
    ["attestation", "verify", "--help"],
    PROBE_TIMEOUT_MS
  );
  if (!help) return skipped(SKIP_NOT_FOUND);
  if (help.code === null)
    return skipped(skipTimedOut("gh attestation verify --help"));
  if (help.code !== 0) return skipped(SKIP_TOO_OLD);

  const auth = await runGh(
    ["auth", "status", "--hostname", "github.com"],
    PROBE_TIMEOUT_MS
  );
  if (!auth) return skipped(SKIP_NOT_FOUND);
  if (auth.code === null) return skipped(skipTimedOut("gh auth status"));
  if (auth.code !== 0) return skipped(SKIP_NOT_LOGGED_IN);

  const dir = mkdtempSync(join(tmpdir(), "squirrel-attest-"));
  try {
    const file = join(dir, "squirrel");
    writeFileSync(file, Buffer.from(data), { mode: 0o600 });
    const verify = await runGh(
      [
        "attestation",
        "verify",
        file,
        "--repo",
        ATTESTATION_REPO,
        "--cert-identity",
        ATTESTATION_CERT_IDENTITY,
        "--deny-self-hosted-runners",
      ],
      VERIFY_TIMEOUT_MS
    );
    // gh was there a moment ago; it vanishing mid-run is the same as absent.
    if (!verify) return skipped(SKIP_NOT_FOUND);
    if (verify.code === null) {
      return err(
        commandError(
          "ATTESTATION_FAILED",
          `gh attestation verify timed out after ${VERIFY_TIMEOUT_S}s, nothing was installed.`
        )
      );
    }
    if (verify.code !== 0) {
      const tail = verify.output
        .trim()
        .split("\n")
        .slice(-OUTPUT_TAIL_LINES)
        .join("\n");
      return err(
        commandError(
          "ATTESTATION_FAILED",
          `Attestation verification failed: this binary was not built by the ${ATTESTATION_REPO} release workflow. Nothing was installed.` +
            (tail ? `\n${tail}` : "")
        )
      );
    }
    return ok<AttestationOutcome>({ status: "verified" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
