// #1600: Google Tag Manager is a code-injection surface, so its presence is info, not a pass.

import { describe, expect, test } from "bun:test";

import { parseHTML } from "@squirrelscan/parser/dom";
import { gtmPresentRule } from "../src/analytics/gtm-present";
import type { RuleContext } from "../src/types";

async function run(html: string) {
  const ctx = { page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} }, parsed: { document: parseHTML(html).document }, options: {} } as unknown as RuleContext;
  const result = await gtmPresentRule.run(ctx);
  return result.checks[0]!;
}

describe("analytics/gtm-present (#1600)", () => {
  test("a GTM container is info, not a pass", async () => {
    const check = await run('<html><head><script async src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC123"></script></head><body></body></html>');
    expect(check.status).toBe("info");
    expect(check.items?.map((i) => i.id)).toContain("GTM");
  });

  test("GTM next to GA4 is still info and lists both", async () => {
    const check = await run('<html><head><script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC123"></script><script src="https://www.googletagmanager.com/gtag/js?id=G-ABC"></script></head></html>');
    expect(check.status).toBe("info");
    expect(check.items?.map((i) => i.id)).toEqual(["GTM", "GA4"]);
  });

  test("GA4 alone through gtag.js is not mistaken for GTM and stays a pass", async () => {
    const check = await run('<html><head><script src="https://www.googletagmanager.com/gtag/js?id=G-ABC"></script></head></html>');
    expect(check.status).toBe("pass");
    expect(check.items?.map((i) => i.id)).toEqual(["GA4"]);
  });

  test("a privacy analytics script is still a pass, and nothing is still info", async () => {
    expect((await run('<html><head><script src="https://plausible.io/js/script.js"></script></head></html>')).status).toBe("pass");
    expect((await run("<html><head></head></html>")).message).toBe("No analytics tracking detected");
  });
});
