// crawl/soft-404 rule + the soft-404 gating of page content/legal rules (#1174).

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { soft404Rule } from "../src/crawl/soft-404";
import { RuleRunner, type RulesConfig } from "../src/runner";
import type { ParsedPage, PageData, RuleContext } from "../src/types";

// Real soft-404 shape: Next.js error shell, "Page Not Found" title/h1, noindex.
const SOFT_404_HTML = `<!doctype html>
<html id="__next_error__">
  <head>
    <meta charset="utf-8" />
    <meta name="robots" content="noindex" />
    <title>Page Not Found | Example Site</title>
  </head>
  <body>
    <main><h1>Page Not Found</h1><p>The page does not exist.</p></main>
  </body>
</html>`;

// A normal content page that also ships a cookie-consent banner.
const NORMAL_HTML = `<!doctype html>
<html>
  <head><title>Great Article About Widgets</title></head>
  <body>
    <main>
      <h1>Everything about widgets</h1>
      <p>${"Widgets are wonderful and this paragraph has plenty of words. ".repeat(30)}</p>
      <a href="/terms">Terms of Service</a>
    </main>
    <div id="cookie-consent">We use cookies. <button>Accept</button></div>
  </body>
</html>`;

function makeRunner(enable: string[]): RuleRunner {
  const config: RulesConfig = { rule_options: {}, rules: { enable } };
  return new RuleRunner({ config });
}

function page(html: string, statusCode = 200): PageData {
  return { url: "https://example.com/blog/gone", html, statusCode, loadTime: 0, headers: {} };
}

function byId(checks: Map<string, { checks: CheckResult[] }>, id: string): CheckResult[] {
  return checks.get(id)?.checks ?? [];
}

describe("soft404Rule.run (direct)", () => {
  const baseCtx = (
    isSoft404: boolean,
    confirmation?: "confirmed" | "intermittent" | "unconfirmed" | "unconfirmed-rendered",
  ): RuleContext => ({
    page: page(SOFT_404_HTML),
    parsed: {
      isSoft404,
      soft404Confirmation: confirmation,
      soft404Signals: isSoft404
        ? [{ name: "error-shell", strong: true, detail: "error shell" }]
        : [],
    } as ParsedPage,
    options: {},
  });

  test("confirmed: standard soft-404 warn, with the server-HTML caveat", () => {
    const checks = soft404Rule.run(baseCtx(true, "confirmed")).checks;
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("warn");
    expect(checks[0]?.message).toContain("Page serves 404 content with HTTP 200");
    expect(checks[0]?.message).not.toContain("intermittently");
    expect(checks[0]?.message).toContain("server's HTML response");
    expect((checks[0]?.details as { confirmation?: string })?.confirmation).toBe("confirmed");
  });

  test("intermittent: DISTINCT wording, not the standard warn", () => {
    const checks = soft404Rule.run(baseCtx(true, "intermittent")).checks;
    expect(checks[0]?.status).toBe("warn");
    expect(checks[0]?.message).toContain("intermittently serves 404 error content");
    expect(checks[0]?.message).toContain("server's HTML response");
    expect((checks[0]?.details as { confirmation?: string })?.confirmation).toBe("intermittent");
  });

  test("unconfirmed: warn annotated as a single observation (never dropped)", () => {
    const checks = soft404Rule.run(baseCtx(true, "unconfirmed")).checks;
    expect(checks[0]?.status).toBe("warn");
    expect(checks[0]?.message).toContain("single crawl observation");
    expect((checks[0]?.details as { confirmation?: string })?.confirmation).toBe("unconfirmed");
  });

  test("unconfirmed-rendered: warn with render-specific annotation", () => {
    const checks = soft404Rule.run(baseCtx(true, "unconfirmed-rendered")).checks;
    expect(checks[0]?.status).toBe("warn");
    expect(checks[0]?.message).toContain("cannot verify without JS rendering");
    expect(checks[0]?.message).toContain("rendered crawl observation");
    expect((checks[0]?.details as { confirmation?: string })?.confirmation).toBe(
      "unconfirmed-rendered",
    );
  });

  test("absent confirmation (runner-only path) is treated as unconfirmed, still warns", () => {
    const checks = soft404Rule.run(baseCtx(true)).checks;
    expect(checks[0]?.status).toBe("warn");
    expect(checks[0]?.message).toContain("single crawl observation");
  });

  test("passes when the page is not a soft-404", () => {
    const checks = soft404Rule.run(baseCtx(false)).checks;
    expect(checks[0]?.status).toBe("pass");
  });
});

const GATED = ["legal/cookie-consent", "legal/terms-of-service", "ax/token-weight"];

describe("soft-404 gating through the runner", () => {
  test("soft-404 page: crawl/soft-404 warns, gated content/legal rules skip", async () => {
    const runner = makeRunner(["crawl/soft-404", ...GATED]);
    const { ruleResults } = await runner.runPageRules(page(SOFT_404_HTML));

    const soft = byId(ruleResults, "crawl/soft-404");
    expect(soft[0]?.status).toBe("warn");

    for (const id of GATED) {
      const checks = byId(ruleResults, id);
      expect(checks[0]?.status).toBe("skipped");
      expect(checks[0]?.skipReason).toBe("soft-404");
    }
  });

  test("normal page: crawl/soft-404 passes, gated rules run (cookie-consent passes)", async () => {
    const runner = makeRunner(["crawl/soft-404", ...GATED]);
    const { ruleResults } = await runner.runPageRules(page(NORMAL_HTML));

    expect(byId(ruleResults, "crawl/soft-404")[0]?.status).toBe("pass");

    // cookie-consent actually ran (not skipped) and found the banner.
    const consent = byId(ruleResults, "legal/cookie-consent");
    expect(consent[0]?.status).not.toBe("skipped");
    expect(consent[0]?.status).toBe("pass");

    // terms-of-service ran (found the /terms link → pass) rather than skipping.
    expect(byId(ruleResults, "legal/terms-of-service")[0]?.status).not.toBe("skipped");
  });

  test("real 404 (status 404) is not treated as a soft-404", async () => {
    const runner = makeRunner(["crawl/soft-404"]);
    const { ruleResults } = await runner.runPageRules(page(SOFT_404_HTML, 404));
    expect(byId(ruleResults, "crawl/soft-404")[0]?.status).toBe("pass");
  });
});
