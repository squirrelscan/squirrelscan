// #437 — a meta refresh inside <noscript> never fires in a browser with
// scripting on, so seed redirect resolution must not follow it.

import { describe, expect, test } from "bun:test";

import { findClientRedirects } from "../src/client-redirects";

const BASE = "https://example.com/";

describe("findClientRedirects and <noscript>", () => {
  test("ignores a meta refresh inside <noscript>", () => {
    const html = `<html><head><noscript><meta http-equiv="refresh" content="0; url=/no-js.html"></noscript></head><body>app</body></html>`;
    expect(findClientRedirects(html, BASE)).toBeNull();
  });

  test("ignores a meta refresh inside an uppercase, multi-line <noscript>", () => {
    const html = `<head><NOSCRIPT>\n<meta http-equiv="refresh" content="0;url=/no-js.html">\n</NOSCRIPT></head>`;
    expect(findClientRedirects(html, BASE)).toBeNull();
  });

  test("negative control: a meta refresh outside <noscript> is still followed", () => {
    const html = `<html><head><meta http-equiv="refresh" content="0; url=/new"></head><body>app</body></html>`;
    expect(findClientRedirects(html, BASE)).toBe("https://example.com/new");
  });

  test("a meta refresh outside <noscript> wins when the page also has one inside", () => {
    const html = `<head><noscript><meta http-equiv="refresh" content="0; url=/no-js.html"></noscript><meta http-equiv="refresh" content="0; url=/real"></head>`;
    expect(findClientRedirects(html, BASE)).toBe("https://example.com/real");
  });

  test("a meta refresh after a closed <noscript> is still followed", () => {
    const html = `<head><noscript><link rel="stylesheet" href="/a.css"></noscript><meta http-equiv="refresh" content="0; url=/new"></head>`;
    expect(findClientRedirects(html, BASE)).toBe("https://example.com/new");
  });
});
