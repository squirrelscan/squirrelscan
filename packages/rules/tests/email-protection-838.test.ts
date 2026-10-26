// Cloudflare email obfuscation links through the rules (pub#838).
//
// The parser drops `/cdn-cgi/l/email-protection` from the link graph and records it as a
// mailto contact link (pub#811), and `links/broken-links` skips it. These pin the rules that
// read the page's anchors themselves: `links/tel-mailto` counts it as a mailto, and
// `links/nofollow-internal` and `links/https-downgrade` do not judge it as a page link.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { httpsDowngradeRule } from "../src/links/https-downgrade";
import { nofollowInternalRule } from "../src/links/nofollow-internal";
import { telMailtoRule } from "../src/links/tel-mailto";
import type { RuleContext } from "../src/types";

const BASE = "https://example.com";

const encode = (address: string, key: number): string =>
  key.toString(16).padStart(2, "0") +
  [...address].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");

const OBFUSCATED = `<a href="/cdn-cgi/l/email-protection#${encode("hi@example.com", 0x2a)}">[email&#160;protected]</a>`;

function html(body: string): string {
  return `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;
}

function sitePage(path: string, status: number, body: string) {
  const url = `${BASE}${path}`;
  return { url, statusCode: status, parsed: parsePage(html(body), url) };
}

function siteCtx(pages: ReturnType<typeof sitePage>[]): RuleContext {
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {},
    site: { baseUrl: BASE, robotsTxt: null, sitemaps: null, pages },
    options: {},
  } as unknown as RuleContext;
}

function pageCtx(body: string): RuleContext {
  const url = `${BASE}/legal/privacy`;
  return {
    page: { url, html: html(body), statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html(body), url),
    options: {},
  } as unknown as RuleContext;
}

describe("links/tel-mailto with a Cloudflare obfuscated email", () => {
  test("counts it as a mailto link and does not judge it invalid", () => {
    const { checks } = telMailtoRule.run(pageCtx(`<p>${OBFUSCATED}</p>`));
    expect(checks.find((c) => c.name === "mailto-links")).toMatchObject({
      status: "pass",
      message: "1 mailto: link(s) found",
    });
  });

  test("an address that cannot be decoded is counted, never reported invalid", () => {
    const { checks } = telMailtoRule.run(pageCtx(`<a href="/cdn-cgi/l/email-protection#zz">[email&#160;protected]</a>`));
    expect(checks.find((c) => c.name === "mailto-links")?.status).toBe("pass");
  });

  test("it sits beside a plain mailto and a tel without disturbing them", () => {
    const { checks } = telMailtoRule.run(
      pageCtx(`${OBFUSCATED}<a href="mailto:real@example.com">mail</a><a href="tel:+15551234567">+15551234567</a>`),
    );
    expect(checks.find((c) => c.name === "mailto-links")?.message).toBe("2 mailto: link(s) found");
    expect(checks.find((c) => c.name === "tel-links")?.status).toBe("pass");
  });

  test("one on another host is read as a mailto too, as the parser reads it (pub#811)", () => {
    const { checks } = telMailtoRule.run(
      pageCtx(`<a href="https://other.example.org/cdn-cgi/l/email-protection#2a4f">x</a>`),
    );
    expect(checks.find((c) => c.name === "mailto-links")?.status).toBe("pass");
  });
});

describe("raw-anchor link rules do not judge the obfuscation link as a page link", () => {
  test("links/nofollow-internal ignores it but still flags a real nofollowed internal link", () => {
    const only = nofollowInternalRule.run(
      pageCtx(`<a rel="nofollow" href="/cdn-cgi/l/email-protection#2a4f">[email&#160;protected]</a>`),
    );
    expect(only.checks.map((c) => c.status)).toEqual(["pass"]);

    const both = nofollowInternalRule.run(
      pageCtx(
        `<a rel="nofollow" href="/cdn-cgi/l/email-protection#2a4f">x</a><a rel="nofollow" href="/private">y</a>`,
      ),
    );
    expect(both.checks[0]?.items?.map((i) => i.id)).toEqual(["/private"]);
  });

  test("links/https-downgrade ignores an http:// spelling of it but still flags a real downgrade", () => {
    const only = httpsDowngradeRule.run(
      pageCtx(`<a href="http://example.com/cdn-cgi/l/email-protection#2a4f">[email&#160;protected]</a>`),
    );
    expect(only.checks.map((c) => c.status)).toEqual(["pass"]);

    const both = httpsDowngradeRule.run(
      pageCtx(
        `<a href="http://example.com/cdn-cgi/l/email-protection#2a4f">x</a><a href="http://example.com/old">y</a>`,
      ),
    );
    expect(both.checks[0]?.items?.map((i) => i.id)).toEqual(["http://example.com/old"]);
  });
});

describe("links/tel-mailto: an obfuscated address that cannot be decoded", () => {
  test("is not compared with the visible text, so it raises no mismatch", () => {
    const { checks } = telMailtoRule.run(
      pageCtx(`<a href="/cdn-cgi/l/email-protection#zz">hi@example.com</a>`),
    );
    expect(checks.find((c) => c.name === "mailto-mismatch")).toBeUndefined();
    expect(checks.find((c) => c.name === "mailto-links")?.status).toBe("pass");
  });

  test("a decoded address is compared with the visible text as any mailto is", () => {
    const { checks } = telMailtoRule.run(pageCtx(`${OBFUSCATED.replace("[email&#160;protected]", "other@example.com")}`));
    expect(checks.find((c) => c.name === "mailto-mismatch")?.status).toBe("warn");
  });
});
