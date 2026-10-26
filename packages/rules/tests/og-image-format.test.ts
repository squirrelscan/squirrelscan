import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { ogImageSizeRule } from "../src/social/og-image-size";
import type { ParsedPage, RuleContext } from "../src/types";

const PAGE_URL = "https://example.com/pricing";

function run(head: string) {
  const html = `<!doctype html><html><head>${head}</head><body></body></html>`;
  const ctx = {
    page: { url: PAGE_URL, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document: parseHTML(html).document } as unknown as ParsedPage,
    options: {},
  } as RuleContext;
  const result = ogImageSizeRule.run(ctx);
  if (result instanceof Promise) throw new Error("unexpected async rule");
  return result.checks;
}

const meta = (property: string, content: string) =>
  `<meta property="${property}" content="${content}">`;

describe("social/og-image-size image formats", () => {
  test("warns for an SVG og:image URL and names the image", () => {
    const url = "https://upload.wikimedia.org/mascot.svg?rev=4";
    const check = run(meta("og:image", url)).find((row) => row.name === "og-image-format");

    expect(check).toMatchObject({
      status: "warn",
      value: "Use a 1200x630 PNG or JPEG instead",
      items: [{ id: url, label: `og:image: ${url}` }],
    });
    expect(check?.message).toContain("SVG");
  });

  test("warns when og:image:type declares SVG on an extensionless URL", () => {
    const url = "https://cdn.example.com/share?id=pricing";
    const checks = run(`${meta("og:image", url)}${meta("og:image:type", "image/svg+xml")}`);
    const check = checks.find((row) => row.name === "og-image-format");

    expect(check?.status).toBe("warn");
    expect(check?.items?.[0]?.id).toBe(url);
  });

  test.each(["share.png", "share.jpg"])("passes a supported %s og:image", (file) => {
    const check = run(meta("og:image", `https://cdn.example.com/${file}`)).find(
      (row) => row.name === "og-image-format",
    );

    expect(check?.status).toBe("pass");
  });

  test("reports AVIF as having inconsistent preview support", () => {
    const check = run(meta("og:image", "/share.avif")).find(
      (row) => row.name === "og-image-format",
    );

    expect(check?.status).toBe("info");
    expect(check?.message).toContain("AVIF");
  });

  test("checks twitter:image without making og:image mandatory for the format check", () => {
    const url = "https://cdn.example.com/twitter-card.SVG";
    const checks = run(`<meta name="twitter:image" content="${url}">`);
    const check = checks.find((row) => row.name === "twitter-image-format");

    expect(check?.status).toBe("warn");
    expect(check?.items?.[0]?.id).toBe(url);
    expect(checks.find((row) => row.name === "og-image-size")?.status).toBe("info");
  });

  test("checks the property form of twitter:image", () => {
    const url = "https://cdn.example.com/twitter-card.svg";
    const checks = run(meta("twitter:image", url));

    expect(checks.find((row) => row.name === "twitter-image-format")).toMatchObject({
      status: "warn",
      items: [{ id: url, label: `twitter:image: ${url}` }],
    });
  });

  test("does not fetch image URLs to identify their format", () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error("unexpected image fetch");
    }) as typeof fetch;
    try {
      run(meta("og:image", "https://cdn.example.com/share.svg"));
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
