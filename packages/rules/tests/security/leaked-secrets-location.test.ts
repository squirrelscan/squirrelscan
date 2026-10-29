// security/leaked-secrets: JSON items identify the matched value's length and
// source position without publishing the value itself (#1230).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { leakedSecretsRule, scanContent } from "../../src/security/leaked-secrets";
import type { CheckItem, RuleContext } from "../../src/types";

const PAGE = "https://app.acme.test/";
const inlineSecret = "sk_live_" + "aB3dE5gH7jK9mN1pQ3rS5tU7"; // pragma: allowlist secret
const externalSecret = "sk_live_" + "zY8xW6vU4tS2rQ0pN8mL6kJ4"; // pragma: allowlist secret

function run(html: string, scripts: { url: string; content: string }[] = []): CheckItem[] {
  const ctx = {
    site: {
      baseUrl: PAGE,
      pages: [{ url: PAGE, statusCode: 200, parsed: parsePage(html, PAGE) }],
      robotsTxt: null,
      sitemaps: null,
      scripts: scripts.map((script) => ({
        ...script,
        status: 200,
        error: null,
        contentType: "application/javascript",
        sizeBytes: script.content.length,
        sourcePages: [PAGE],
      })),
    },
    options: {},
  } as unknown as RuleContext;

  return (leakedSecretsRule.run(ctx).checks ?? []).flatMap((check) => check.items ?? []);
}

describe("leaked-secret source location metadata", () => {
  test("inline items point into the script body and identify its page position", () => {
    const script = `window.config = { key: "${inlineSecret}" };`;
    const items = run(
      `<html><body><script src="/vendor.js"></script><script>${script}</script></body></html>`
    );
    const item = items.find((candidate) => candidate.id.startsWith("Stripe Live Key:"));

    expect(item?.meta).toMatchObject({
      length: inlineSecret.length,
      offset: script.indexOf(inlineSecret),
      scriptIndex: 1,
    });
    expect(item?.id).toBe(
      `Stripe Live Key: ${inlineSecret.slice(0, 6)}${"*".repeat(Math.min(inlineSecret.length - 10, 20))}${inlineSecret.slice(-4)}`
    );
    expect(JSON.stringify(item)).not.toContain(inlineSecret);
  });

  test("external-script items point into the fetched script body", () => {
    const content = `export const config = { key: "${externalSecret}" };`;
    const items = run("<html><body>ok</body></html>", [
      { url: "https://app.acme.test/app.js", content },
    ]);
    const item = items.find((candidate) => candidate.id.startsWith("Stripe Live Key:"));

    expect(item?.meta).toMatchObject({
      length: externalSecret.length,
      offset: content.indexOf(externalSecret),
    });
    expect(item?.meta).not.toHaveProperty("scriptIndex");
    expect(JSON.stringify(item)).not.toContain(externalSecret);
  });

  test("generic assignments locate the value rather than the key and quotes", () => {
    const secret = "aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY2"; // pragma: allowlist secret
    const content = `window.config = { apiKey: "${secret}" };`;
    const finding = scanContent(content, "external-script").find(
      (candidate) => candidate.type === "Generic API Key Assignment"
    );

    expect(finding).toMatchObject({
      length: secret.length,
      offset: content.indexOf(secret),
    });
  });

  test("base64 findings point to the encoded source blob", () => {
    const decoded = JSON.stringify({ padding: "x".repeat(40), key: externalSecret });
    const encoded = Buffer.from(decoded).toString("base64");
    const content = `window.config = "${encoded}";`;
    const finding = scanContent(content, "external-script").find(
      (candidate) => candidate.location === "external-script (base64)"
    );

    expect(finding).toMatchObject({
      length: externalSecret.length,
      offset: content.indexOf(encoded),
    });
  });
});
