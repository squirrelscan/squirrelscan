// #1418 — the console renderer is the DEFAULT output path, so a refused
// off-site seed redirect has to be disclosed here or the common case (`squirrel
// audit <url>`, read the terminal) is the one place it stays invisible.
// packages/report covers the shared renderers and the canonicalization itself;
// this covers the console wiring, including the failed/blocked branch that
// returns before the normal header.

import { describe, expect, test, spyOn } from "bun:test";

import type { AuditReport } from "@/types";

import { generateConsoleReport } from "@/reports/output/console";

import { createMinimalReport } from "../fixtures";

/** 8-bit CSI: a terminal acts on it exactly as it does on ESC-[. */
const CSI = String.fromCharCode(0x9b);
const RTL_OVERRIDE = String.fromCharCode(0x202e);

const NOTE =
  "Seed redirected off-site to https://other.example/landing, not followed. This audit graded https://example.com.";
const WITHHELD_NOTE =
  "Seed redirected off-site and was not followed. The redirect target was not a valid URL and is withheld. This audit graded https://example.com.";

/**
 * The renderer's full output. `fmt` disables colour when stdout is not a TTY,
 * which it never is under the test runner, so this is already plain text and
 * safe to compare byte-for-byte.
 */
function capture(report: AuditReport): string {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  try {
    generateConsoleReport(report);
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

function redirected(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    ...createMinimalReport(),
    finalUrl: "https://other.example/landing",
    ...overrides,
  };
}

describe("console report discloses a refused off-site seed redirect", () => {
  test("names the refused target and the URL that was actually graded", () => {
    const out = capture(redirected());
    expect(out).toContain(NOTE);
    // The graded URL is still the header's subject; the disclosure sits under
    // it. Located by the score, not by the URL: a URL literal handed to
    // `includes` trips CodeQL's incomplete-url-substring-sanitization rule.
    const lines = out.split("\n");
    const header = lines.findIndex((l) => l.includes("/100"));
    expect(header).toBeGreaterThan(-1);
    expect(lines[header]).toContain("https://example.com");
    expect(lines[header + 1]).toContain("Seed redirected off-site");
  });

  test("nothing is printed when the seed did not redirect off-site", () => {
    expect(capture(createMinimalReport())).not.toContain("Seed redirected");
  });

  test("the whole rest of the output is byte-identical without a redirect", () => {
    // Full-output equality, not the absence of a phrase: the disclosure is the
    // only thing a redirect adds to the console report.
    const clean = capture(createMinimalReport());
    const lines = capture(redirected()).split("\n");
    const kept = lines.filter((l) => !l.includes("Seed redirected"));
    // Exactly one line is the disclosure, and dropping it leaves the clean
    // rendering byte for byte — so nothing else rode along with it.
    expect(lines.length - kept.length).toBe(1);
    expect(kept.join("\n")).toBe(clean);
    // And every suppressed spelling renders exactly as the absent field does.
    for (const finalUrl of [
      "",
      "   ",
      "https://example.com",
      "https://example.com/",
      "https://example.com:443/",
    ]) {
      expect(`${finalUrl}: ${capture(redirected({ finalUrl }))}`).toBe(
        `${finalUrl}: ${clean}`
      );
    }
  });

  test("a failed or blocked audit discloses it too", () => {
    // A seed that redirects off-site and is refused is a common way to end up
    // with nothing to audit, and that branch returns before the normal header.
    for (const status of ["failed", "blocked"] as const) {
      const out = capture(
        redirected({ status, statusReason: "No auditable pages" })
      );
      expect(`${status}: ${out.includes(NOTE)}`).toBe(`${status}: true`);
    }
  });

  test("a target that could not be canonicalized is withheld, not printed", () => {
    // Unparseable, and carrying an 8-bit CSI plus a bidi override — neither of
    // which the console's SGR-preserving sanitizer would strip on its own.
    const out = capture(
      redirected({ finalUrl: `not-a-url${CSI}2J${RTL_OVERRIDE}txt` })
    );
    expect(out).toContain(WITHHELD_NOTE);
    expect(out).not.toContain("not-a-url");
    expect(out).not.toContain(CSI);
    expect(out).not.toContain(RTL_OVERRIDE);
  });
});
