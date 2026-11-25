#!/usr/bin/env bun

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseReleaseKeys } from "../src/self/release-keys";

interface BinaryInfo {
  filename: string;
  sha256: string;
  size: number;
}

type PlatformArch =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-x64"
  | "linux-x64-musl"
  | "linux-arm64"
  | "linux-arm64-musl"
  | "windows-x64";

interface ReleaseManifest {
  version: string;
  channel: "stable" | "beta";
  released_at: string;
  binaries: Partial<Record<PlatformArch, BinaryInfo>>;
  release_notes_url: string;
  /**
   * The pinned release key that signs this manifest. The CLI refuses a signed
   * manifest without it (provenance.ts). It is written here, not appended
   * later, because the release lane publishes these exact bytes and the
   * signature covers them.
   */
  signing_key_id: string;
}

export interface GenerateManifestOptions {
  buildDir: string;
  version: string;
  channel: "stable" | "beta";
  /** Defaults to the repository's release-keys.json. */
  releaseKeysPath?: string;
  now?: Date;
}

const BUILD_DIR = join(import.meta.dir, "..", "build");
const RELEASE_KEYS_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "release-keys.json"
);
const REPO = "squirrelscan/squirrelscan";

/**
 * The id of the current-slot key in release-keys.json. Throws when the slot is
 * empty or malformed: a manifest without a key id can never verify, so the
 * build must stop rather than publish one.
 */
export async function readSigningKeyId(
  releaseKeysPath: string = RELEASE_KEYS_PATH
): Promise<string> {
  const set = parseReleaseKeys(await Bun.file(releaseKeysPath).json());
  const current = set.keys[0];
  if (!current || current.slot !== "current" || current.id === "")
    throw new Error(
      `${releaseKeysPath}: the current release key slot is empty, so manifest.json would carry no signing_key_id`
    );
  if (set.revokedKeyIds.includes(current.id))
    throw new Error(
      `${releaseKeysPath}: the current release key ${current.id} is revoked`
    );
  return current.id;
}

async function computeSHA256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function extractPlatformArch(filename: string): PlatformArch | null {
  if (filename.includes("darwin-arm64")) return "darwin-arm64";
  if (filename.includes("darwin-x64")) return "darwin-x64";
  // Check musl BEFORE base platforms (linux-x64-musl contains linux-x64)
  if (filename.includes("linux-x64-musl")) return "linux-x64-musl";
  if (filename.includes("linux-arm64-musl")) return "linux-arm64-musl";
  if (filename.includes("linux-x64")) return "linux-x64";
  if (filename.includes("linux-arm64")) return "linux-arm64";
  if (filename.includes("windows-x64")) return "windows-x64";
  return null;
}

export async function generateManifest(
  opts: GenerateManifestOptions
): Promise<ReleaseManifest> {
  const signingKeyId = await readSigningKeyId(opts.releaseKeysPath);
  const files = await readdir(opts.buildDir);
  const binaries: Partial<Record<PlatformArch, BinaryInfo>> = {};

  for (const filename of files) {
    if (!filename.startsWith("squirrel-")) continue;
    if (filename === "manifest.json") continue;

    const platformArch = extractPlatformArch(filename);
    if (!platformArch) continue;

    const filepath = join(opts.buildDir, filename);
    const file = Bun.file(filepath);
    const buffer = await file.arrayBuffer();
    const sha256 = await computeSHA256(buffer);

    binaries[platformArch] = {
      filename,
      sha256,
      size: file.size,
    };

    console.log(`  ${platformArch}: ${sha256.substring(0, 16)}...`);
  }

  const manifest: ReleaseManifest = {
    version: opts.version,
    channel: opts.channel,
    released_at: (opts.now ?? new Date()).toISOString(),
    binaries,
    release_notes_url: `https://github.com/${REPO}/releases/tag/v${opts.version}`,
    signing_key_id: signingKeyId,
  };

  const manifestPath = join(opts.buildDir, "manifest.json");
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\nManifest written to ${manifestPath}`);
  console.log(JSON.stringify(manifest, null, 2));
  return manifest;
}

if (import.meta.main) {
  generateManifest({
    buildDir: BUILD_DIR,
    version: process.env.VERSION ?? "0.0.0",
    channel: (process.env.CHANNEL ?? "stable") as "stable" | "beta",
  }).catch((error) => {
    console.error("Manifest generation failed:", error);
    process.exit(1);
  });
}
