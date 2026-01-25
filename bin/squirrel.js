#!/usr/bin/env node

/**
 * squirrel CLI wrapper
 * Executes the natively installed binary
 */

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Native install locations (checked first) + npm package fallback (checked last)
const homeDir = os.homedir();
const isWindows = process.platform === "win32";
const ext = isWindows ? ".exe" : "";

// Local npm package binary (fallback if self install failed)
const localBinary = path.join(__dirname, `squirrel${ext}`);

const binaryLocations = isWindows
  ? [
      path.join(homeDir, "AppData", "Local", "squirrel", "bin", "squirrel.exe"),
      path.join(homeDir, ".local", "bin", "squirrel.exe"),
      localBinary,
    ]
  : [
      path.join(homeDir, ".local", "bin", "squirrel"),
      "/usr/local/bin/squirrel",
      "/opt/homebrew/bin/squirrel",
      localBinary,
    ];

// Find binary
let binaryPath = null;
for (const loc of binaryLocations) {
  if (fs.existsSync(loc)) {
    binaryPath = loc;
    break;
  }
}

if (!binaryPath) {
  console.error("Error: squirrelscan binary not found.");
  console.error("");
  console.error("The binary should have been installed during npm install.");
  console.error("Expected locations:");
  binaryLocations.forEach((loc) => console.error(`  - ${loc}`));
  console.error("");
  console.error("Try reinstalling: npm install -g squirrelscan");
  console.error("");
  console.error("Or install directly:");
  console.error("  curl -fsSL https://squirrelscan.com/install | bash");
  process.exit(1);
}

// Execute binary with all arguments
const args = process.argv.slice(2);

try {
  const result = spawnSync(binaryPath, args, {
    stdio: "inherit",
    windowsHide: true,
  });

  if (result.status !== null) {
    process.exit(result.status);
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
} catch (err) {
  console.error(`Error executing squirrel: ${err.message}`);
  process.exit(1);
}
