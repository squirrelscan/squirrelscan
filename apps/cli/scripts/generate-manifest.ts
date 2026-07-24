#!/usr/bin/env bun

import { readdir } from "node:fs/promises";
import { join } from "node:path";

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
}

const VERSION = process.env.VERSION ?? "0.0.0";
const CHANNEL = (process.env.CHANNEL ?? "stable") as "stable" | "beta";
const BUILD_DIR = join(import.meta.dir, "..", "build");
const REPO = "squirrelscan/squirrelscan";

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

async function generateManifest() {
  const files = await readdir(BUILD_DIR);
  const binaries: Partial<Record<PlatformArch, BinaryInfo>> = {};

  for (const filename of files) {
    if (!filename.startsWith("squirrel-")) continue;
    if (filename === "manifest.json") continue;

    const platformArch = extractPlatformArch(filename);
    if (!platformArch) continue;

    const filepath = join(BUILD_DIR, filename);
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
    version: VERSION,
    channel: CHANNEL,
    released_at: new Date().toISOString(),
    binaries,
    release_notes_url: `https://github.com/${REPO}/releases/tag/v${VERSION}`,
  };

  const manifestPath = join(BUILD_DIR, "manifest.json");
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\nManifest written to ${manifestPath}`);
  console.log(JSON.stringify(manifest, null, 2));
}

generateManifest().catch((error) => {
  console.error("Manifest generation failed:", error);
  process.exit(1);
});
