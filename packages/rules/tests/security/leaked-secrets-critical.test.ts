// security/leaked-secrets: server-only secrets shipped in browser-served
// scripts are reported as critical. Fixture values are synthetic.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { leakedSecretsRule } from "../../src/security/leaked-secrets";
import type { RuleContext } from "../../src/types";

const PAGE = "https://shop.acme.test/";
const STRIPE_LIVE = "sk_live_" + "aB3dE5gH7jK9mN1pQ3rS5tU7"; // pragma: allowlist secret
const STRIPE_PUBLISHABLE = "pk_live_" + "aB3dE5gH7jK9mN1pQ3rS5tU7"; // pragma: allowlist secret
const PG_URL = "postgres://app_user:Zx9fLq2Vb7Nm@db.acme.test:5432/app"; // pragma: allowlist secret

// Assembled at runtime so no webhook-shaped literal sits in the source.
const SLACK_HOOK = ["https://hooks.slack", ".com/services/", "T0AAAAAAA/B0AAAAAAA/", "aB3dE5gH7jK9mN1pQ3rS5tU7"].join(""); // pragma: allowlist secret

function run(html: string, scripts: { url: string; content: string }[] = []) {
  const ctx = {
    site: {
      baseUrl: PAGE,
      pages: [{ url: PAGE, statusCode: 200, parsed: parsePage(html, PAGE) }],
      robotsTxt: null,
      sitemaps: null,
      scripts: scripts.map((s) => ({
        ...s,
        status: 200,
        error: null,
        contentType: "application/javascript",
        sizeBytes: s.content.length,
        sourcePages: [PAGE],
      })),
    },
    options: {},
  } as unknown as RuleContext;
  return (leakedSecretsRule.run(ctx) as { checks: any[] }).checks;
}

const byName = (checks: any[], name: string) => checks.find((c) => c.name === name);
const ids = (c: any) => (c?.items ?? []).map((i: any) => i.id).join("|");

describe("leaked-secrets critical escalation", () => {
  test("server-only secret in an external script is critical with shipped-to-every-visitor copy", () => {
    const checks = run("<html><body>ok</body></html>", [
      { url: "https://shop.acme.test/app.js", content: `var k="${STRIPE_LIVE}";` },
    ]);
    const crit = byName(checks, "leaked-secrets-critical");
    expect(crit.status).toBe("fail");
    expect(crit.details.severity).toBe("critical");
    expect(crit.message).toContain("shipped to every visitor");
    expect(crit.items[0].label).toContain("external-script");
    expect(byName(checks, "leaked-secrets-high")).toBeUndefined();
  });

  test("server-only secret in an inline script is critical", () => {
    const checks = run(`<html><body><script>var db="${PG_URL}";</script></body></html>`);
    const crit = byName(checks, "leaked-secrets-critical");
    expect(crit.message).toContain("shipped to every visitor");
    expect(crit.items[0].label).toContain("inline-script");
  });

  test("a server-only secret outside a script keeps its current severity", () => {
    const checks = run(`<html><body><p>${PG_URL}</p></body></html>`);
    expect(byName(checks, "leaked-secrets-critical")).toBeUndefined();
    expect(byName(checks, "leaked-secrets-high").items[0].label).toContain("Found in html");
  });

  test("publishable keys are not escalated", () => {
    const checks = run("<html><body>ok</body></html>", [
      { url: "https://shop.acme.test/app.js", content: `var k="${STRIPE_PUBLISHABLE}";` },
    ]);
    expect(byName(checks, "leaked-secrets-critical")).toBeUndefined();
    expect(byName(checks, "leaked-secrets-public")).toBeDefined();
  });

  test("a non-server-only class in a script stays high", () => {
    const checks = run("<html><body>ok</body></html>", [
      { url: "https://shop.acme.test/app.js", content: `var u="${SLACK_HOOK}";` },
    ]);
    expect(byName(checks, "leaked-secrets-critical")).toBeUndefined();
    expect(ids(byName(checks, "leaked-secrets-high"))).toContain("Slack Webhook");
  });

  test("no duplicate finding: one hit appears once, in the critical check only", () => {
    const checks = run(`<html><body><script>var k="${STRIPE_LIVE}";</script></body></html>`, [
      { url: "https://shop.acme.test/app.js", content: `var k="${STRIPE_LIVE}";` },
    ]);
    const all = checks.filter((c) => c.items).flatMap((c) => c.items.map((i: any) => i.id));
    expect(all.filter((id: string) => id.includes("sk_liv")).length).toBe(1);
    expect(ids(byName(checks, "leaked-secrets-critical"))).toContain("sk_liv");
  });
});
