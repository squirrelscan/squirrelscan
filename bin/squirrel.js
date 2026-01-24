#!/usr/bin/env node

/**
 * squirrel CLI wrapper
 * Executes the platform-specific binary downloaded during npm install
 */

const { execFileSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { getBinaryExtension } = require("../lib/platform");

const binaryName = `squirrel${getBinaryExtension()}`;
const binaryPath = path.join(__dirname, binaryName);

// Check if binary exists
if (!fs.existsSync(binaryPath)) {
  console.error("Error: squirrelscan binary not found.");
  console.error("");
  console.error("The binary should have been downloaded during npm install.");
  console.error("Try reinstalling: npm install -g squirrelscan");
  console.error("");
  console.error("Or install directly:");
  console.error("  curl -fsSL https://squirrelscan.com/install | bash");
  process.exit(1);
}

// Execute binary with all arguments
const args = process.argv.slice(2);

try {
  // Use spawnSync for proper signal handling and stdio inheritance
  const result = spawnSync(binaryPath, args, {
    stdio: "inherit",
    windowsHide: true,
  });

  // Forward exit code
  if (result.status !== null) {
    process.exit(result.status);
  }

  // Handle signal termination
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
} catch (err) {
  console.error(`Error executing squirrel: ${err.message}`);
  process.exit(1);
}
