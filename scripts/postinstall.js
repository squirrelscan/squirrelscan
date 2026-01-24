#!/usr/bin/env node

/**
 * postinstall script for squirrelscan npm package
 * Downloads the platform-specific binary from GitHub releases
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getPlatform, getBinaryExtension } = require("../lib/platform");

const REPO = "squirrelscan/squirrelscan";
const pkg = require("../package.json");
const VERSION = `v${pkg.version}`;

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
 * @param {string} url
 * @returns {Promise<{data: Buffer, statusCode: number}>}
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "squirrelscan-npm" } }, (res) => {
      // Follow redirects
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
 * @param {string} url
 * @param {number} attempts
 * @returns {Promise<Buffer>}
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
 * Compute SHA256 hash of buffer
 * @param {Buffer} buffer
 * @returns {string}
 */
function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  const platform = getPlatform();
  const binDir = path.join(__dirname, "..", "bin");
  const binaryName = `squirrel${getBinaryExtension()}`;
  const binaryPath = path.join(binDir, binaryName);

  log(`Installing squirrelscan ${VERSION} for ${platform}...`);

  // Ensure bin directory exists
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  // Fetch manifest
  const releaseUrl = `https://github.com/${REPO}/releases/download/${VERSION}`;
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
    error(`No binary available for platform: ${platform}\n  See: https://github.com/${REPO}/releases/tag/${VERSION}`);
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

  // Write binary
  fs.writeFileSync(binaryPath, binaryData);

  // Make executable (Unix only)
  if (process.platform !== "win32") {
    fs.chmodSync(binaryPath, 0o755);
  }

  log("Installation complete!");
  info(`Binary: ${binaryPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
