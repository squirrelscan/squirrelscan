// Generate packages/tech-detect/src/fingerprints/generated.ts from researched
// fingerprint JSON (produced by the tech-detect-expand workflow).
//
//   bun run scripts/generate-tech-fingerprints.ts
//
// Input:  packages/tech-detect/data/research-fingerprints.json
//           [{ category, fingerprints: [{ id, name, category, website, icon,
//              detectors: [{ type, name?, pattern?, selector?, caseSensitive? }],
//              confidence?, versionPattern? }] }]
// Output: packages/tech-detect/src/fingerprints/generated.ts
//           export const GENERATED_FINGERPRINTS: TechFingerprint[] = [...]
//
// Guarantees: dedupes against the curated fingerprints + within the new set,
// drops detectors whose regex won't compile, drops `dom` detectors (never match
// in headerless detection), coerces unknown categories to "other", and skips
// any fingerprint left with zero usable detectors.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AD_FINGERPRINTS,
  ANALYTICS_FINGERPRINTS,
  CDN_FINGERPRINTS,
  CHAT_FINGERPRINTS,
  CMS_FINGERPRINTS,
  FONT_FINGERPRINTS,
  FRAMEWORK_FINGERPRINTS,
  HOSTING_FINGERPRINTS,
  OTHER_FINGERPRINTS,
  PAYMENT_FINGERPRINTS,
  SECURITY_FINGERPRINTS,
  SERVER_FINGERPRINTS,
  TAG_MANAGER_FINGERPRINTS,
} from "../packages/tech-detect/src/fingerprints/index";

const ROOT = join(import.meta.dir, "..");
const INPUT = join(ROOT, "packages/tech-detect/data/research-fingerprints.json");
const OUTPUT = join(ROOT, "packages/tech-detect/src/fingerprints/generated.ts");

const VALID_CATEGORIES = new Set([
  "cms", "framework", "analytics", "cdn", "ad-network", "payment", "web-server",
  "hosting", "security", "tag-manager", "chat", "font", "video", "widget", "other",
]);
const DETECTOR_TYPES = new Set([
  "header", "meta", "script-url", "script-content", "html", "url-path",
]);

interface RawDetector {
  type: string;
  name?: string;
  pattern?: string;
  selector?: string;
  caseSensitive?: boolean;
}
interface RawFingerprint {
  id: string;
  name: string;
  category: string;
  website?: string;
  icon?: string;
  detectors: RawDetector[];
  confidence?: string;
  versionPattern?: string;
}
interface RawCategory {
  category: string;
  fingerprints: RawFingerprint[];
}

// ── Collect curated ids (dedupe target) ───────────────────────────
const CURATED = [
  CMS_FINGERPRINTS, FRAMEWORK_FINGERPRINTS, ANALYTICS_FINGERPRINTS, CDN_FINGERPRINTS,
  SERVER_FINGERPRINTS, HOSTING_FINGERPRINTS, TAG_MANAGER_FINGERPRINTS, PAYMENT_FINGERPRINTS,
  CHAT_FINGERPRINTS, AD_FINGERPRINTS, SECURITY_FINGERPRINTS, FONT_FINGERPRINTS, OTHER_FINGERPRINTS,
];
const existingIds = new Set<string>();
for (const arr of CURATED) for (const fp of arr) existingIds.add(fp.id);

function compiles(source: string, flags: string): boolean {
  try {
    new RegExp(source, flags);
    return true;
  } catch {
    return false;
  }
}

function regexLiteral(source: string, caseSensitive?: boolean): string {
  // Emit `new RegExp(<json>, <flags>)` — robust against literal-slash escaping.
  const flags = caseSensitive ? "" : "i";
  return `new RegExp(${JSON.stringify(source)}, ${JSON.stringify(flags)})`;
}

function sanitizeDetector(d: RawDetector): string | null {
  if (!DETECTOR_TYPES.has(d.type)) return null; // drops `dom` + unknowns
  if (d.type === "header" || d.type === "meta") {
    if (!d.name || !d.pattern || !compiles(d.pattern, "i")) return null;
    return `{ type: ${JSON.stringify(d.type)}, name: ${JSON.stringify(d.name)}, pattern: ${regexLiteral(d.pattern, d.caseSensitive)} }`;
  }
  if (!d.pattern || !compiles(d.pattern, "i")) return null;
  return `{ type: ${JSON.stringify(d.type)}, pattern: ${regexLiteral(d.pattern, d.caseSensitive)} }`;
}

function emitFingerprint(fp: RawFingerprint): string | null {
  const category = VALID_CATEGORIES.has(fp.category) ? fp.category : "other";
  const detectors = fp.detectors.map(sanitizeDetector).filter((s): s is string => s != null);
  if (detectors.length === 0) return null;

  const lines: string[] = [];
  lines.push("  {");
  lines.push(`    id: ${JSON.stringify(fp.id)},`);
  lines.push(`    name: ${JSON.stringify(fp.name)},`);
  lines.push(`    category: ${JSON.stringify(category)},`);
  if (fp.website) lines.push(`    website: ${JSON.stringify(fp.website)},`);
  if (fp.icon) lines.push(`    icon: ${JSON.stringify(fp.icon)},`);
  lines.push(`    detectors: [`);
  for (const d of detectors) lines.push(`      ${d},`);
  lines.push(`    ],`);
  if (fp.confidence && ["high", "medium", "low"].includes(fp.confidence)) {
    lines.push(`    confidence: ${JSON.stringify(fp.confidence)},`);
  }
  if (fp.versionPattern && compiles(fp.versionPattern, "i")) {
    lines.push(`    versionPattern: ${regexLiteral(fp.versionPattern, false)},`);
  }
  lines.push("  }");
  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────
const raw: RawCategory[] = JSON.parse(readFileSync(INPUT, "utf8"));
const seen = new Set<string>(existingIds);
const emitted: { category: string; block: string }[] = [];
let skippedDup = 0;
let skippedNoDetectors = 0;

for (const cat of raw) {
  for (const fp of cat.fingerprints ?? []) {
    if (!fp.id || seen.has(fp.id)) {
      skippedDup++;
      continue;
    }
    const block = emitFingerprint(fp);
    if (!block) {
      skippedNoDetectors++;
      continue;
    }
    seen.add(fp.id);
    emitted.push({ category: VALID_CATEGORIES.has(fp.category) ? fp.category : "other", block });
  }
}

// Group emitted blocks by category for readability.
emitted.sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));

const header = `// AUTO-GENERATED by scripts/generate-tech-fingerprints.ts — do not edit by hand.
// Source data: packages/tech-detect/data/research-fingerprints.json
// Regenerate: bun run scripts/generate-tech-fingerprints.ts
//
// Researched, adversarially-reviewed technology fingerprints. These extend the
// curated per-category fingerprint files; the detect engine consumes the union.

import type { TechFingerprint } from "../types";

export const GENERATED_FINGERPRINTS: TechFingerprint[] = [
`;
const body = emitted.map((e) => e.block).join(",\n");
const footer = "\n];\n";

writeFileSync(OUTPUT, header + body + footer, "utf8");

console.log(`generated ${emitted.length} fingerprints → ${OUTPUT}`);
console.log(`  skipped ${skippedDup} duplicate-id, ${skippedNoDetectors} no-usable-detectors`);
