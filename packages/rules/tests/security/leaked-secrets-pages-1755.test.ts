// security/leaked-secrets: a finding names the pages it sits on, through the streaming engine path (#1755).
// Site rules get collected signals and no DOM there. Values are built from parts: no secret-shaped literal is committed.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { buildCollectedPageSignal } from "../../src/collected-signals";
import { leakedSecretsRule } from "../../src/security/leaked-secrets";
import type { RuleContext } from "../../src/types";

const BASE = "https://shop.example.test";
const KEY = `${["sk", "live"].join("_")}_${"aB3dE5gH7jK9mN1pQ3rS5tU7"}`;
const SCRIPT = `${BASE}/_fault/shop-config.js`;

const signal = (url: string, html: string) =>
  buildCollectedPageSignal({ url, parsed: parsePage(html, url), rendered: false });

function run(pages: ReturnType<typeof signal>[], scripts: { url: string; content: string; sourcePages: string[] }[]) {
  const ctx = {
    site: {
      baseUrl: BASE,
      pages: [],
      scripts: scripts.map((s) => ({
        ...s,
        status: 200,
        error: null,
        contentType: "application/javascript",
        sizeBytes: s.content.length,
      })),
    },
    collectedSignals: { pages },
    options: {},
  } as unknown as RuleContext;
  return leakedSecretsRule.run(ctx).checks;
}

describe("leaked-secrets names the pages (#1755)", () => {
  const loader = `${BASE}/products/crunchy-peanut-butter`;
  const other = `${BASE}/products/almond-butter`;

  test("an external script finding lists every page that loads the script", () => {
    const checks = run(
      [signal(loader, `<html><body><script src="${SCRIPT}"></script></body></html>`), signal(other, "<html><body>x</body></html>")],
      [{ url: SCRIPT, content: `window.cfg={key:"${KEY}"};`, sourcePages: [loader] }],
    );
    const crit = checks.find((c) => c.name === "leaked-secrets-critical")!;
    expect(crit.items).toHaveLength(1);
    expect(crit.items![0]!.id).toMatch(/^Stripe Live Key: sk_liv\*+5tU7$/);
    expect(crit.items![0]!.label).toContain("external-script");
    expect(crit.items![0]!.sourcePages).toEqual([loader]);
  });

  test("the inline copy on the loading page is reported with its page as its own occurrence", () => {
    const checks = run(
      [signal(loader, `<html><body><script>window.__SHOP_CONFIG__={"k":"${KEY}"};</script></body></html>`)],
      [{ url: SCRIPT, content: `window.cfg={key:"${KEY}"};`, sourcePages: [loader, other] }],
    );
    const crit = checks.find((c) => c.name === "leaked-secrets-critical")!;
    expect(crit.items).toHaveLength(1);
    const item = crit.items![0]!;
    expect(item.sourcePages).toEqual([loader, other]);
    const occ = item.meta!.occurrences as { location: string; page?: string; script?: string }[];
    expect(occ.some((o) => o.location.startsWith("inline-script") && o.page === loader)).toBe(true);
    expect(occ.some((o) => o.location === "external-script" && o.script === SCRIPT)).toBe(true);
  });

  test("no raw value appears anywhere in the result", () => {
    const checks = run(
      [signal(loader, `<html><body><script>var a="${KEY}";</script></body></html>`)],
      [{ url: SCRIPT, content: `var b="${KEY}";`, sourcePages: [loader] }],
    );
    expect(JSON.stringify(checks)).not.toContain(KEY);
  });

  test("the rule is not named after environment variables", () => {
    expect(leakedSecretsRule.meta.name.toLowerCase()).not.toContain("environment");
  });
});
