#!/usr/bin/env bun
// Debug script to diagnose alt-text detection issues

import { parseHTML } from "linkedom";

import { extractImages } from "../src/parse/extractors/images";

const url = process.argv[2] || "https://nikcub.me/";

console.log(`\n🔍 Debugging alt-text detection for: ${url}\n`);

// Fetch HTML
console.log("📥 Fetching HTML...");
const response = await fetch(url);
const html = await response.text();
console.log(`✓ Fetched ${html.length} bytes\n`);

// Parse with linkedom
console.log("🔨 Parsing HTML with linkedom...");
const { document } = parseHTML(html);
console.log("✓ Parsed\n");

// Extract images
console.log("🖼️  Extracting images...");
const images = extractImages(document, url);
console.log(`✓ Found ${images.length} images\n`);

// Print all images
console.log("📋 Image details:");
console.log("=".repeat(80));
for (const [index, img] of images.entries()) {
  console.log(`\nImage ${index + 1}:`);
  console.log(`  src: ${img.src}`);
  console.log(`  alt: ${JSON.stringify(img.alt)} (type: ${typeof img.alt})`);
  console.log(`  alt === null: ${img.alt === null}`);
  console.log(`  alt === "": ${img.alt === ""}`);
  if (typeof img.alt === "string") {
    console.log(`  alt.trim() === "": ${img.alt.trim() === ""}`);
  }
  console.log(`  width: ${img.width}`);
  console.log(`  height: ${img.height}`);
  console.log(`  isLazyLoaded: ${img.isLazyLoaded}`);
  console.log(`  inFigure: ${img.inFigure}`);
}

// Test rule logic
console.log("\n" + "=".repeat(80));
console.log("🧪 Testing alt-text rule logic:\n");

// Current rule logic
const missingAlt = images.filter(
  (img) =>
    img.alt === null || (typeof img.alt === "string" && img.alt.trim() === "")
);

console.log(`Missing alt (current logic): ${missingAlt.length} images`);
if (missingAlt.length > 0) {
  console.log("  URLs:");
  for (const img of missingAlt) {
    console.log(`    - ${img.src}`);
  }
}

// Alternative logic
const missingAltAlt = images.filter(
  (img) => !img.alt || (typeof img.alt === "string" && img.alt.trim() === "")
);

console.log(
  `\nMissing alt (alternative logic): ${missingAltAlt.length} images`
);
if (missingAltAlt.length > 0) {
  console.log("  URLs:");
  for (const img of missingAltAlt) {
    console.log(`    - ${img.src}`);
  }
}

// Check for logo specifically
console.log("\n" + "=".repeat(80));
console.log("🔎 Looking for logo (nik.png):\n");
const logo = images.find((img) => img.src.includes("nik.png"));
if (logo) {
  console.log("✓ Logo found!");
  console.log(`  src: ${logo.src}`);
  console.log(`  alt: ${JSON.stringify(logo.alt)}`);
  console.log(`  Should be flagged: ${!logo.alt || logo.alt.trim() === ""}`);
} else {
  console.log("✗ Logo NOT found in extracted images");
}

console.log("\n" + "=".repeat(80));
console.log("✅ Diagnostic complete\n");
