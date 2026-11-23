import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { GENERATED_FINGERPRINTS } from "../src/fingerprints/generated";

interface RawDetector {
  type: string;
  pattern?: string;
}
interface RawFingerprint {
  id: string;
  detectors: RawDetector[];
}
const SOURCE = join(import.meta.dir, "../data/research-fingerprints.json");
const raw = (await Bun.file(SOURCE).json()) as {
  fingerprints: RawFingerprint[];
}[];
const sourceIds = raw.flatMap((c) => c.fingerprints.map((f) => f.id));

describe("research-fingerprints.json is the source of generated.ts (repo#3768)", () => {
  test("source and generated ids match", () => {
    expect(sourceIds.toSorted()).toEqual(
      GENERATED_FINGERPRINTS.map((f) => f.id).toSorted()
    );
  });

  test("cloudflare-insights is merged into cloudflare-web-analytics", () => {
    expect(sourceIds).not.toContain("cloudflare-insights");
    const cf = raw
      .flatMap((c) => c.fingerprints)
      .find((f) => f.id === "cloudflare-web-analytics");
    const patterns = (cf?.detectors ?? []).map((d) => d.pattern ?? "");
    expect(patterns.some((p) => p.includes("cdn-cgi/rum"))).toBe(true);
    expect(patterns.some((p) => p.includes("data-cf-beacon\\s*="))).toBe(true);
  });

  test("Bing UET source pattern covers bat.bing.net with a URL boundary", () => {
    // Reads the JSON source, not generated.ts: dropping the host from
    // research-fingerprints.json fails here before anyone regenerates.
    const uet = raw
      .flatMap((c) => c.fingerprints)
      .find((f) => f.id === "microsoft-uet");
    const source = uet?.detectors.find((d) => d.type === "script-url")?.pattern;
    expect(source).toBeString();
    const re = new RegExp(source ?? "(?!)", "i");
    expect(re.test("https://bat.bing.net/bat.js")).toBe(true);
    expect(re.test("https://bat.bing.com/bat.js")).toBe(true);
    expect(re.test("https://bat.bing.com/bat.json")).toBe(false);
  });
});
