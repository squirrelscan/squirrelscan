// squirrelscan/squirrelscan#2224: a missing aria-controls target of a collapsed
// disclosure is not an error, and a missing id reads differently from a duplicate.

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { ParsedPage, RuleContext } from "../src/types";

import { duplicateIdAriaRule } from "../src/a11y/duplicate-id-aria";

const URL = "https://example.com/";

function run(body: string) {
  const html = `<html><body>${body}</body></html>`;
  const ctx: RuleContext = {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, URL) as ParsedPage,
    options: {},
  };
  return (
    duplicateIdAriaRule.run(ctx) as {
      checks: { name: string; status: string; message: string }[];
    }
  ).checks;
}

describe("a11y/duplicate-id-aria (#2224)", () => {
  test("collapsed disclosure with a missing aria-controls target is not reported", () => {
    const checks = run(
      '<button aria-expanded="false" aria-controls="x">m</button>'
    );
    expect(
      checks.every((c) => c.status !== "fail" && c.status !== "warn")
    ).toBe(true);
  });

  test("aria-haspopup trigger with a missing target is not reported", () => {
    const checks = run(
      '<button aria-haspopup="menu" aria-controls="x">m</button>'
    );
    expect(
      checks.every((c) => c.status !== "fail" && c.status !== "warn")
    ).toBe(true);
  });

  test("expanded disclosure with a missing target still reports, not as an error", () => {
    const checks = run(
      '<button aria-expanded="true" aria-controls="x">m</button>'
    );
    const hit = checks.find((c) => c.name === "aria-missing-id-ref");
    expect(hit?.status).toBe("warn");
    expect(hit?.message).toContain("missing id");
  });

  test("missing aria-labelledby target is still an error", () => {
    const checks = run('<div aria-labelledby="nope">x</div>');
    expect(checks.find((c) => c.name === "aria-missing-name-id")?.status).toBe(
      "fail"
    );
  });

  test("duplicate ids have their own message and stay errors", () => {
    const checks = run(
      '<p id="a">1</p><p id="a">2</p><div aria-labelledby="a">x</div>'
    );
    const dup = checks.find((c) => c.name === "duplicate-id-aria");
    expect(dup?.status).toBe("fail");
    expect(dup?.message).toContain("duplicated");
    expect(dup?.message).not.toContain("missing");
  });
});
