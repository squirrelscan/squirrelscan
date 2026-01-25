#!/usr/bin/env node

/**
 * postinstall script for squirrelscan npm package
 * Downloads binary and runs native self-install
 *
 * Environment variables:
 *   SQUIRREL_VERSION   - Pin to specific version (e.g., v0.0.15)
 *   SQUIRREL_CHANNEL   - Release channel: stable or beta (default: stable)
 */

const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { getPlatform, getBinaryExtension } = require("../lib/platform");

const REPO = "squirrelscan/squirrelscan";

// Colors for terminal output
const supportsColor = process.stdout.isTTY;
const green = (s) => (supportsColor ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s) => (supportsColor ? `\x1b[33m${s}\x1b[0m` : s);
const red = (s) => (supportsColor ? `\x1b[31m${s}\x1b[0m` : s);
const blue = (s) => (supportsColor ? `\x1b[34m${s}\x1b[0m` : s);

const log = (msg) => console.log(`${green("==>")} ${msg}`);
const info = (msg) => console.log(`${blue("::")} ${msg}`);
const warn = (msg) => console.log(`${yellow("Warning:")} ${msg}`);
const error = (msg) => {
  console.error(`${red("Error:")} ${msg}`);
  process.exit(1);
};

/**
 * HTTPS GET with redirect following
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "squirrelscan-npm" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        return;
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ data: Buffer.concat(chunks), statusCode: res.statusCode }));
      res.on("error", reject);
    });

    request.on("error", reject);
    request.setTimeout(120000, () => {
      request.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

/**
 * Fetch with retry
 */
async function fetchWithRetry(url, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const { data } = await httpsGet(url);
      return data;
    } catch (err) {
      if (i < attempts) {
        warn(`Download failed, retrying (${i}/${attempts})...`);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Compute SHA256 hash
 */
function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Get latest version from GitHub releases
 */
async function getLatestVersion(channel) {
  const apiUrl = `https://api.github.com/repos/${REPO}/releases`;
  info(`Fetching releases (channel: ${channel})...`);

  let releases;
  try {
    const data = await fetchWithRetry(apiUrl);
    releases = JSON.parse(data.toString());
  } catch (err) {
    error(`Failed to fetch releases: ${err.message}\n  URL: ${apiUrl}`);
  }

  if (!releases || releases.length === 0) {
    error(`No releases found. Check: https://github.com/${REPO}/releases`);
  }

  let release;
  if (channel === "stable") {
    release = releases.find((r) => !r.prerelease);
  } else {
    release = releases[0];
  }

  if (!release) {
    error(`No releases found for channel '${channel}'`);
  }

  return release.tag_name;
}

async function main() {
  const platform = getPlatform();
  const ext = getBinaryExtension();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "squirrelscan-"));
  const binaryPath = path.join(tmpDir, `squirrel${ext}`);

  // Determine version: pinned, channel-based, or package default
  let version;
  if (process.env.SQUIRREL_VERSION) {
    version = process.env.SQUIRREL_VERSION;
    log(`Installing pinned version: ${version}`);
  } else {
    const channel = process.env.SQUIRREL_CHANNEL || "stable";
    version = await getLatestVersion(channel);
    log(`Latest version: ${version} (channel: ${channel})`);
  }

  log(`Installing squirrelscan ${version} for ${platform}...`);

  // Fetch manifest
  const releaseUrl = `https://github.com/${REPO}/releases/download/${version}`;
  const manifestUrl = `${releaseUrl}/manifest.json`;

  info("Fetching manifest...");
  let manifest;
  try {
    const manifestData = await fetchWithRetry(manifestUrl);
    manifest = JSON.parse(manifestData.toString());
  } catch (err) {
    error(`Failed to fetch manifest: ${err.message}\n  URL: ${manifestUrl}`);
  }

  // Get binary info for platform
  const binaryInfo = manifest.binaries?.[platform];
  if (!binaryInfo) {
    error(`No binary available for platform: ${platform}\n  See: https://github.com/${REPO}/releases/tag/${version}`);
  }

  const { filename, sha256: expectedSha256 } = binaryInfo;

  // Download binary
  const binaryUrl = `${releaseUrl}/${filename}`;
  info(`Downloading ${filename}...`);

  let binaryData;
  try {
    binaryData = await fetchWithRetry(binaryUrl);
  } catch (err) {
    error(`Failed to download binary: ${err.message}\n  URL: ${binaryUrl}`);
  }

  // Verify checksum
  info("Verifying checksum...");
  const actualSha256 = sha256(binaryData);
  if (actualSha256 !== expectedSha256) {
    error(`Checksum mismatch!\n  Expected: ${expectedSha256}\n  Actual:   ${actualSha256}`);
  }
  info(`Checksum verified: ${expectedSha256.slice(0, 16)}...`);

  // Write binary to temp
  fs.writeFileSync(binaryPath, binaryData);

  // Make executable (Unix only)
  if (process.platform !== "win32") {
    fs.chmodSync(binaryPath, 0o755);
  }

  // Run self install
  info("Running self install...");
  const result = spawnSync(binaryPath, ["self", "install"], {
    stdio: "inherit",
    windowsHide: true,
  });

  // Cleanup temp
  try {
    fs.rmSync(tmpDir, { recursive: true });
  } catch {
    // ignore cleanup errors
  }

  if (result.status !== 0) {
    error("Self install failed");
  }

  log("Installation complete!");
  info("Run 'squirrel --help' to get started");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
