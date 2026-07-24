#!/usr/bin/env bun
// Test parsePage function

import { parsePage } from "../src/parse/html";

const url = "https://nikcub.me/";

console.log(`\n🧪 Testing parsePage for: ${url}\n`);

const html = await (await fetch(url)).text();
const parsed = parsePage(html, url);

console.log(`Images found: ${parsed.images.length}`);
for (const img of parsed.images) {
  console.log(`  - ${img.src}`);
  console.log(`    alt: ${JSON.stringify(img.alt)}`);
  console.log(`    missing alt: ${!img.alt || img.alt.trim() === ""}`);
}

// Check for logo
const logo = parsed.images.find((img) => img.src.includes("nik.png"));
console.log(`\n🔎 Logo found: ${logo ? "YES" : "NO"}`);
if (logo) {
  console.log(`   Should be flagged: ${!logo.alt || logo.alt.trim() === ""}`);
}

console.log("\n✅ Test complete\n");
