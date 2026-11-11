// #1735: the two site rules' structured evidence is what the shared affectedPages() reads, so every
// renderer and the cloud show the page sample and the true count (not only the prose in `value`).

import type { RuleContext } from "@squirrelscan/rules";

import { affectedPages } from "@squirrelscan/report";
import { loadAllRules } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";

const rules = loadAllRules();

function run(id: string, site: Record<string, unknown>) {
  const rule = rules.get(id)!;
  const ctx = {
    page: {
      url: "https://example.com/",
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    site: { baseUrl: "https://example.com", robotsTxt: null, ...site },
    options: {},
  } as unknown as RuleContext;
  const result = rule.run(ctx);
  if (result instanceof Promise) throw new Error("sync path expected");
  return result.checks;
}

const schemaPage = (url: string) => ({
  url,
  headers: { "x-robots-tag": "noindex" },
  parsed: {
    meta: { robots: null },
    schemas: { types: ["Article"], valid: true, errors: [], raw: null },
  },
});

describe("affectedPages() over the two rules (#1735)", () => {
  test("crawl/schema-noindex-conflict: a sample and the true count", () => {
    const pages = Array.from({ length: 300 }, (_, i) =>
      schemaPage(`https://example.com/p${String(i).padStart(3, "0")}`)
    );
    const [check] = run("crawl/schema-noindex-conflict", { pages });
    const affected = affectedPages(check!);
    expect(affected.count).toBe(300);
    expect(affected.sample.length).toBeLessThan(300);
    expect(affected.sample[0]).toBe("https://example.com/p000");
    expect(affected.hasMore).toBe(true);
  });

  test("security/csp: the page the header was read from, counted once", () => {
    const checks = run("security/csp", {
      pages: [
        {
          url: "https://example.com/",
          statusCode: 200,
          headers: {
            "content-security-policy": "script-src 'self' 'unsafe-inline'",
          },
        },
      ],
    });
    const unsafe = checks.find((c) => c.name === "csp-unsafe-scripts")!;
    const affected = affectedPages(unsafe);
    expect(affected.sample).toEqual(["https://example.com/"]);
    expect(affected.count).toBe(1);
    expect(affected.hasMore).toBe(false);
  });
});
