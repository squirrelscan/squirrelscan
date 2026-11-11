// pub#1765: too short and too long are separate checks on every two-sided length rule.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { metaDescriptionRule } from "../src/core/meta-description";
import { internalLinksRule } from "../src/links/internal-links";
import type { ParsedPage, Rule, RuleContext } from "../src/types";

const URL = "https://example.com/p";

function run(rule: Rule, html: string): CheckResult[] {
  const ctx: RuleContext = {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, URL) as ParsedPage,
    options: {},
  };
  return rule.run(ctx).checks as CheckResult[];
}

const withDescription = (d: string) =>
  `<!doctype html><html lang="en"><head><title>t</title><meta name="description" content="${d}"></head><body><p>x</p></body></html>`;

const warned = (checks: CheckResult[]) => checks.filter((c) => c.status === "warn");

describe("meta-description", () => {
  test("a short and a long description report under their own checks and labels", () => {
    const short = warned(run(metaDescriptionRule, withDescription("a".repeat(80))));
    const long = warned(run(metaDescriptionRule, withDescription("b".repeat(190))));
    expect(short.map((c) => [c.name, c.message])).toEqual([
      ["meta-description-too-short", "Description too short (80 chars, min 120)"],
    ]);
    expect(long.map((c) => [c.name, c.message])).toEqual([
      ["meta-description-too-long", "Description too long (190 chars, max 160)"],
    ]);
    expect(String(short[0]!.items?.[0]?.label)).toContain("(80 chars, under 120)");
    expect(String(long[0]!.items?.[0]?.label)).toContain("(190 chars, over 160)");
  });

  test("an in-range description passes both sides and a missing one keeps the old name", () => {
    expect(run(metaDescriptionRule, withDescription("c".repeat(140))).map((c) => [c.name, c.status])).toEqual([
      ["meta-description-too-short", "pass"],
      ["meta-description-too-long", "pass"],
    ]);
    const missing = run(metaDescriptionRule, "<!doctype html><html><head><title>t</title></head><body></body></html>");
    expect(missing.map((c) => [c.name, c.status])).toEqual([["meta-description", "fail"]]);
  });
});

describe("internal-links", () => {
  const links = (n: number) =>
    `<!doctype html><html><head><title>t</title></head><body>${Array.from({ length: n }, (_, i) => `<a href="/p${i}">l${i}</a>`).join("")}</body></html>`;

  test("too few and too many are separate checks", () => {
    expect(warned(run(internalLinksRule, links(0))).map((c) => [c.name, c.message])).toEqual([
      ["internal-links-too-few", "Too few internal links (0, min 1)"],
    ]);
    expect(warned(run(internalLinksRule, links(101))).map((c) => [c.name, c.message])).toEqual([
      ["internal-links-too-many", "Too many internal links (101, max 100)"],
    ]);
    expect(run(internalLinksRule, links(5)).map((c) => [c.name, c.status])).toEqual([
      ["internal-links-too-few", "pass"],
      ["internal-links-too-many", "pass"],
    ]);
  });
});
