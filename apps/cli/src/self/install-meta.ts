import { hostname } from "node:os";
import { sep } from "node:path";

import { isManagedInstall } from "./paths";

// Max length for a stamped source string (keeps the analytics column bounded).
const MAX_SOURCE_LEN = 64;

/**
 * Best-effort install channel for analytics. Precedence:
 *   1. `SQUIRREL_INSTALL_SOURCE` env — lets installers / CI stamp a precise
 *      value (e.g. "install.sh", "homebrew", "ci").
 *   2. inference from the running binary's path.
 *
 * Inference: a binary under `node_modules` is the npm-fallback build ("npm");
 * a binary in the managed releases dir is a curl / install.sh / npm-postinstall
 * managed install ("binary"); the bun runtime itself is a dev checkout ("dev");
 * anything else is a hand-placed copy ("manual").
 *
 * `source` answers "which installer"; `managed` (below) answers the distinct
 * question "can this install silently self-update".
 */
export function detectInstallSource(): string {
  const override = process.env.SQUIRREL_INSTALL_SOURCE?.trim();
  if (override) return override.slice(0, MAX_SOURCE_LEN);

  const exe = process.execPath;
  if (exe.includes(`${sep}node_modules${sep}`)) return "npm";
  if (isManagedInstall()) return "binary";
  // Dev runs execute through the bun runtime; a compiled standalone binary
  // reports its own path and falls through to "manual".
  if (/[\\/]bun(?:\.exe)?$/i.test(exe)) return "dev";
  return "manual";
}

/**
 * True when running in a CI / automation environment. Checks only explicit CI
 * signals — NOT TTY presence, since squirrel's agent-driven runs are routinely
 * non-interactive and must not be miscounted as CI. Mirrors the common
 * `is-ci` convention (`CI` set and not "false"/"0") plus provider-specific vars.
 */
export function detectCi(): boolean {
  const env = process.env;
  if (env.CI !== undefined && env.CI !== "false" && env.CI !== "0") return true;
  return (
    env.CONTINUOUS_INTEGRATION !== undefined ||
    env.GITHUB_ACTIONS !== undefined ||
    env.GITLAB_CI !== undefined ||
    env.CIRCLECI !== undefined ||
    env.BUILDKITE !== undefined ||
    env.JENKINS_URL !== undefined ||
    env.TEAMCITY_VERSION !== undefined ||
    env.TF_BUILD !== undefined // Azure Pipelines
  );
}

/** Where an audit run was executed — surfaced in the dashboard + end-of-run. */
export interface RunnerInfo {
  /** True in any CI / automation environment (see `detectCi`). */
  ci: boolean;
  /** CI provider slug ("github"/"gitlab"/"ci") or null for a local run. */
  provider: string | null;
  /** `owner/repo` (CI only). */
  repo: string | null;
  branch: string | null;
  commit: string | null;
  /** Deep link to the CI run, when the provider exposes one. */
  runUrl: string | null;
  /** Machine hostname (best-effort). */
  hostname: string | null;
}

/**
 * Detect where this run executes — local laptop vs CI, and the CI coordinates
 * (repo/branch/commit/run-url) when available — for the dashboard "who/where ran
 * it" metadata (#271 phase 6). All best-effort from env; absent fields are null.
 */
export function detectRunner(): RunnerInfo {
  const env = process.env;
  let host: string | null = null;
  try {
    host = hostname();
  } catch {
    host = null;
  }

  // GitHub Actions — the primary CI for the `squirrelscan/audit-action`.
  if (env.GITHUB_ACTIONS !== undefined) {
    const repo = env.GITHUB_REPOSITORY ?? null;
    const runUrl =
      repo && env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
        : null;
    return {
      ci: true,
      provider: "github",
      repo,
      branch: env.GITHUB_REF_NAME ?? null,
      commit: env.GITHUB_SHA ?? null,
      runUrl,
      hostname: host,
    };
  }

  // GitLab CI.
  if (env.GITLAB_CI !== undefined) {
    return {
      ci: true,
      provider: "gitlab",
      repo: env.CI_PROJECT_PATH ?? null,
      branch: env.CI_COMMIT_REF_NAME ?? null,
      commit: env.CI_COMMIT_SHA ?? null,
      runUrl: env.CI_PIPELINE_URL ?? null,
      hostname: host,
    };
  }

  // Other CI providers (generic) or a local run.
  const ci = detectCi();
  return {
    ci,
    provider: ci ? "ci" : null,
    repo: null,
    branch: null,
    commit: null,
    runUrl: null,
    hostname: host,
  };
}

/**
 * Explicit opt-out of all background update activity via `SQUIRREL_NO_UPDATE`.
 * For locked-down / air-gapped environments that must never make outbound
 * update requests. Truthy = anything other than unset/empty/"0"/"false"
 * (case-insensitive), mirroring the `CI` convention.
 */
export function isUpdateDisabledByEnv(): boolean {
  const v = process.env.SQUIRREL_NO_UPDATE?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

/**
 * Why background update activity (the check AND the silent auto-install) is
 * suppressed, or null when it's allowed. Covers CI and environments that opt
 * out of outbound update requests. Explicit `squirrel self update` is NOT
 * affected — only the automatic, unattended paths consult this.
 */
export function updateSuppressedReason(): string | null {
  if (isUpdateDisabledByEnv()) return "SQUIRREL_NO_UPDATE is set";
  if (detectCi()) return "running in CI";
  return null;
}
