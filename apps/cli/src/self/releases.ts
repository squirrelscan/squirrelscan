import { type Result, ok, err, commandError } from "@/controllers/types";
import { requestAsync, requestOnceAsync } from "@/tools/request";

import type {
  GitHubRelease,
  ReleaseManifest,
  ReleaseChannel,
  UpdateCheckResult,
  PlatformArch,
} from "./types";

import { isValidReleaseVersion } from "./paths";

const GITHUB_API = "https://api.github.com";
const REPO_OWNER = "squirrelscan";
const REPO_NAME = "squirrelscan";
const PLATFORM_ARCHES: PlatformArch[] = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
];
const RELEASE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function parseReleaseManifest(value: unknown): Result<ReleaseManifest> {
  if (!value || typeof value !== "object") {
    return err(
      commandError("NETWORK_ERROR", "Malformed release metadata response")
    );
  }

  const manifest = value as Partial<ReleaseManifest>;
  if (
    typeof manifest.version !== "string" ||
    !isValidReleaseVersion(manifest.version) ||
    (manifest.channel !== "stable" && manifest.channel !== "beta") ||
    typeof manifest.released_at !== "string" ||
    !manifest.binaries ||
    typeof manifest.binaries !== "object" ||
    typeof manifest.release_notes_url !== "string"
  ) {
    return err(
      commandError("NETWORK_ERROR", "Malformed release metadata response")
    );
  }

  for (const platformArch of PLATFORM_ARCHES) {
    const binary = manifest.binaries[platformArch];
    if (!binary) continue;
    if (
      typeof binary.filename !== "string" ||
      !RELEASE_FILENAME_PATTERN.test(binary.filename) ||
      typeof binary.sha256 !== "string" ||
      !SHA256_PATTERN.test(binary.sha256) ||
      typeof binary.size !== "number" ||
      !Number.isSafeInteger(binary.size) ||
      binary.size <= 0
    ) {
      return err(
        commandError("NETWORK_ERROR", "Malformed release metadata response")
      );
    }
  }

  return ok(manifest as ReleaseManifest);
}

// R2-backed release metadata (latest manifest per channel) served by the
// installer worker. Primary update-check source: the GitHub API below is
// capped at 60 req/hr per IP for anonymous clients, so users behind shared
// egress (corporate NAT, VPNs, CI) get 403s. #1072
const RELEASES_ENDPOINT = "https://install.squirrelscan.com/releases";

export async function fetchChannelManifest(
  channel: ReleaseChannel,
  options?: { noRetry?: boolean }
): Promise<Result<ReleaseManifest>> {
  try {
    const doRequest = options?.noRetry ? requestOnceAsync : requestAsync;
    const response = await doRequest(`${RELEASES_ENDPOINT}/${channel}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "SquirrelScan-Updater",
      },
    });
    if (!response.ok) {
      return err(
        commandError(
          "NETWORK_ERROR",
          `Failed to fetch release metadata: ${response.status}`
        )
      );
    }
    return parseReleaseManifest(await response.json());
  } catch (error) {
    return err(commandError("NETWORK_ERROR", (error as Error).message));
  }
}

export async function fetchReleases(options?: {
  noRetry?: boolean;
}): Promise<Result<GitHubRelease[]>> {
  try {
    const doRequest = options?.noRetry ? requestOnceAsync : requestAsync;
    const response = await doRequest(
      `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/releases`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "SquirrelScan-Updater",
        },
      }
    );

    if (!response.ok) {
      return err(
        commandError(
          "NETWORK_ERROR",
          `Failed to fetch releases: ${response.status}`
        )
      );
    }

    const releases = (await response.json()) as GitHubRelease[];
    return ok(releases);
  } catch (error) {
    return err(
      commandError(
        "NETWORK_ERROR",
        `Failed to fetch releases: ${(error as Error).message}`
      )
    );
  }
}

export async function fetchManifest(
  release: GitHubRelease,
  options?: { noRetry?: boolean }
): Promise<Result<ReleaseManifest>> {
  const manifestAsset = release.assets.find((a) => a.name === "manifest.json");
  if (!manifestAsset) {
    return err(
      commandError("MANIFEST_NOT_FOUND", "No manifest.json in release")
    );
  }

  try {
    const doRequest = options?.noRetry ? requestOnceAsync : requestAsync;
    const response = await doRequest(manifestAsset.browser_download_url);
    if (!response.ok) {
      return err(
        commandError(
          "NETWORK_ERROR",
          `Failed to fetch manifest: ${response.status}`
        )
      );
    }
    return parseReleaseManifest(await response.json());
  } catch (error) {
    return err(commandError("NETWORK_ERROR", (error as Error).message));
  }
}

export async function getLatestRelease(
  channel: ReleaseChannel,
  options?: { noRetry?: boolean }
): Promise<Result<GitHubRelease | null>> {
  const result = await fetchReleases(options);
  if (!result.ok) return result;

  const releases = result.data;

  // Drafts are never installable (assets 404 for anonymous users) — a
  // draft slipping through here is how "update says yes, then nothing
  // happens" looks to users. For stable channel, also filter prereleases.
  const filtered = releases.filter(
    (r) => !r.draft && (channel === "beta" ? true : !r.prerelease)
  );

  if (filtered.length === 0) return ok(null);

  // Pick the highest version by semver, not published_at — re-publishing or
  // hotfixing an older line must never be offered over a newer version.
  const latest = filtered.reduce((best, r) =>
    compareVersions(r.tag_name, best.tag_name) > 0 ? r : best
  );

  return ok(latest);
}

export async function checkForUpdates(
  currentVersion: string,
  channel: ReleaseChannel = "stable",
  options?: { noRetry?: boolean }
): Promise<Result<UpdateCheckResult>> {
  // Endpoint-first: one small fetch, no rate limits. GitHub below is fallback.
  const endpointResult = await fetchChannelManifest(channel, options);
  if (endpointResult.ok) {
    const manifest = endpointResult.data;
    return ok({
      available: compareVersions(manifest.version, currentVersion) > 0,
      current_version: currentVersion,
      latest_version: manifest.version,
      release_url: manifest.release_notes_url ?? null,
      manifest,
    });
  }

  const releaseResult = await getLatestRelease(channel, options);
  if (!releaseResult.ok) return releaseResult;

  const release = releaseResult.data;
  if (!release) {
    return ok({
      available: false,
      current_version: currentVersion,
      latest_version: null,
      release_url: null,
      manifest: null,
    });
  }

  const manifestResult = await fetchManifest(release, options);
  if (!manifestResult.ok) return manifestResult;

  const manifest = manifestResult.data;
  const latestVersion = manifest.version;

  return ok({
    available: compareVersions(latestVersion, currentVersion) > 0,
    current_version: currentVersion,
    latest_version: latestVersion,
    release_url: release.html_url,
    manifest,
  });
}

/**
 * Compare two semantic versions (prerelease-aware)
 * Returns: positive if a > b, negative if a < b, 0 if equal
 *
 * Follows semver precedence: 1.0.0-beta.1 < 1.0.0-beta.2 < 1.0.0.
 * Without this, beta-channel users on 0.0.43-beta.1 never see
 * 0.0.43-beta.2 or the 0.0.43 stable (all compared equal).
 */
export function compareVersions(a: string, b: string): number {
  const parseVersion = (v: string): { core: number[]; pre: string[] } => {
    // Build metadata (+...) never affects precedence per semver
    const cleaned = v.replace(/^v/, "").split("+")[0];
    const [core, ...preParts] = cleaned.split("-");
    return {
      core: core.split(".").map((n) => Number.parseInt(n, 10) || 0),
      pre: preParts.length > 0 ? preParts.join("-").split(".") : [],
    };
  };

  const av = parseVersion(a);
  const bv = parseVersion(b);

  for (let i = 0; i < 3; i++) {
    const diff = (av.core[i] ?? 0) - (bv.core[i] ?? 0);
    if (diff !== 0) return diff;
  }

  // Equal core: a release without prerelease outranks one with it
  if (av.pre.length === 0 && bv.pre.length === 0) return 0;
  if (av.pre.length === 0) return 1;
  if (bv.pre.length === 0) return -1;

  // Both prereleases: compare identifiers left to right (numeric < alphanumeric)
  const len = Math.max(av.pre.length, bv.pre.length);
  for (let i = 0; i < len; i++) {
    const ai = av.pre[i];
    const bi = bv.pre[i];
    // Fewer identifiers sorts lower (beta < beta.1)
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;

    const an = Number.parseInt(ai, 10);
    const bn = Number.parseInt(bi, 10);
    const aNumeric = /^\d+$/.test(ai);
    const bNumeric = /^\d+$/.test(bi);

    if (aNumeric && bNumeric) {
      if (an !== bn) return an - bn;
    } else if (aNumeric !== bNumeric) {
      // Numeric identifiers sort below alphanumeric ones
      return aNumeric ? -1 : 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

// Bounds time-to-headers only; the body of a ~100MB binary on a slow
// connection can legitimately stream for minutes and must not be cut off.
const DOWNLOAD_HEADERS_TIMEOUT_MS = 30_000;

export async function downloadBinary(
  manifest: ReleaseManifest,
  platformArch: PlatformArch,
  options?: { signal?: AbortSignal }
): Promise<Result<ArrayBuffer>> {
  if (!isValidReleaseVersion(manifest.version)) {
    return err(commandError("INVALID_RELEASE", "Release version is invalid"));
  }
  const binary = manifest.binaries[platformArch];
  if (!binary) {
    return err(
      commandError(
        "UNSUPPORTED_PLATFORM",
        `No binary available for ${platformArch}`
      )
    );
  }
  if (
    !RELEASE_FILENAME_PATTERN.test(binary.filename) ||
    !SHA256_PATTERN.test(binary.sha256) ||
    !Number.isSafeInteger(binary.size) ||
    binary.size <= 0
  ) {
    return err(
      commandError("INVALID_RELEASE", "Release binary metadata is invalid")
    );
  }

  const url = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/v${manifest.version}/${binary.filename}`;

  // Plain fetch, not requestAsync: the shared request layer replaces the
  // caller's AbortSignal with its own timeout controller, but the in-process
  // Windows updater must be able to abort this download at command exit
  // (#1074). No retry either — the auto path retries on a later run via the
  // hourly attempt throttle, and interactive callers can just rerun.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options?.signal?.addEventListener("abort", onAbort, { once: true });
  if (options?.signal?.aborted) controller.abort();
  const headersTimeout = setTimeout(
    () => controller.abort(),
    DOWNLOAD_HEADERS_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(headersTimeout);
    if (!response.ok) {
      return err(
        commandError("DOWNLOAD_FAILED", `Download failed: ${response.status}`)
      );
    }

    const buffer = await response.arrayBuffer();

    // Verify SHA256
    const hash = await computeSHA256(buffer);
    if (hash !== binary.sha256) {
      return err(
        commandError("CHECKSUM_MISMATCH", "SHA256 checksum verification failed")
      );
    }

    return ok(buffer);
  } catch (error) {
    if (options?.signal?.aborted) {
      return err(commandError("DOWNLOAD_ABORTED", "Download aborted"));
    }
    return err(commandError("DOWNLOAD_FAILED", (error as Error).message));
  } finally {
    clearTimeout(headersTimeout);
    options?.signal?.removeEventListener("abort", onAbort);
  }
}

async function computeSHA256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { REPO_OWNER, REPO_NAME };
