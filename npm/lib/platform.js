/**
 * Platform detection for squirrelscan binary downloads
 * Mirrors logic from install.sh
 */

const os = require("os");
const fs = require("fs");

/**
 * Detect if running on musl libc (Alpine, etc.)
 * @returns {boolean}
 */
function isMusl() {
  // Check for musl loader
  try {
    const files = fs.readdirSync("/lib");
    if (files.some((f) => f.startsWith("ld-musl-"))) {
      return true;
    }
  } catch {
    // /lib doesn't exist or not readable
  }

  // Check for Alpine
  try {
    if (fs.existsSync("/etc/alpine-release")) {
      return true;
    }
  } catch {
    // Not Alpine
  }

  return false;
}

/**
 * Get platform identifier for binary download
 * @returns {string} Platform identifier (e.g., "darwin-arm64", "linux-x64-musl")
 */
function getPlatform() {
  const platform = os.platform();
  const arch = os.arch();

  let osName;
  switch (platform) {
    case "darwin":
      osName = "darwin";
      break;
    case "linux":
      osName = "linux";
      break;
    case "win32":
      osName = "windows";
      break;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }

  let archName;
  switch (arch) {
    case "x64":
      archName = "x64";
      break;
    case "arm64":
      archName = "arm64";
      break;
    default:
      throw new Error(`Unsupported architecture: ${arch}`);
  }

  // Add musl suffix for Linux if needed
  const libc = osName === "linux" && isMusl() ? "-musl" : "";

  return `${osName}-${archName}${libc}`;
}

/**
 * Get binary filename for current platform
 * @param {string} version - Version string (e.g., "0.0.17")
 * @returns {string} Binary filename
 */
function getBinaryFilename(version) {
  const platform = getPlatform();
  const ext = os.platform() === "win32" ? ".exe" : "";
  return `squirrel-${version}-${platform}${ext}`;
}

/**
 * Get extension for current platform
 * @returns {string} ".exe" on Windows, "" otherwise
 */
function getBinaryExtension() {
  return os.platform() === "win32" ? ".exe" : "";
}

module.exports = {
  getPlatform,
  getBinaryFilename,
  getBinaryExtension,
  isMusl,
};
