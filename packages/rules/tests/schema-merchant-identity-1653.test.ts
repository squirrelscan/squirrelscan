// #1653: schema/organization exposes whether a confirmed shop declares an actual
// organization name plus an address or a tax/company identifier. Informational
// only: it never warns and never claims legal compliance.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { organizationSchemaRule } from "../src/schema/organization";
import type { RuleContext } from "../src/types";

const BASE = "http://127.0.0.1:8765/";

function run(html: string, over: { statusCode?: number; siteType?: string } = {}) {
  const ctx = {
    page: { url: BASE, html, statusCode: over.statusCode ?? 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, BASE),
    options: {},
    siteMetadata: over.siteType ? { siteType: over.siteType } : undefined,
  } as unknown as RuleContext;
  const checks = organizationSchemaRule.run(ctx).checks as Array<{
    name: string;
    status: string;
    message: string;
    items?: Array<{ id: string; label?: string }>;
  }>;
  const m = checks.find((c) => c.name === "organization-merchant-identity");
  const fields: Record<string, string> = {};
  for (const i of m?.items ?? []) fields[i.id] = i.label ?? "";
  return { checks, m, fields };
}

const page = (head: string, body = "<h1>t</h1>") =>
  `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body>${body}</body></html>`;
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

const store = (extra: Record<string, unknown> = {}) => ({
  "@context": "https://schema.org",
  "@type": "OnlineStore",
  name: "Beans & Co",
  url: BASE,
  ...extra,
});

describe("schema/organization merchant identity (#1653)", () => {
  test("OnlineStore with a name and PostalAddress is present", () => {
    const r = run(page(ld(store({ address: { "@type": "PostalAddress", streetAddress: "1 Main St", addressCountry: "GB" } }))));
    expect(r.m?.message).toBe("Merchant identity in structured data: present");
    expect(r.fields["address"]).toBe("present (json-ld)");
    expect(r.fields["identifier"]).toBe("absent");
  });

  test("an identifier instead of an address is present", () => {
    const r = run(page(ld(store({ vatID: "GB123456789" }))));
    expect(r.m?.message).toContain(": present");
    expect(r.fields["identifier"]).toBe("present (json-ld)");
  });

  test("a PropertyValue identifier counts", () => {
    const r = run(page(ld(store({ identifier: { "@type": "PropertyValue", propertyID: "CRN", value: "12345678" } }))));
    expect(r.fields["identifier"]).toBe("present (json-ld)");
  });

  test("a generic identifier is not a company identifier: a plain string, or a PropertyValue that is not a legal id", () => {
    for (const identifier of [
      "SKU-12345",
      42,
      { "@type": "PropertyValue", propertyID: "internal-site-id", value: "9981" },
      { "@type": "PropertyValue", value: "12345678" },
    ]) {
      const r = run(page(ld(store({ identifier }))));
      expect(r.fields["identifier"]).toBe("absent");
    }
  });

  test("PropertyValue identifiers that name a legal id count", () => {
    for (const propertyID of ["VAT", "vatID", "Company number", "ABN", "DUNS", "tax id", "EIN"]) {
      const r = run(page(ld(store({ identifier: { "@type": "PropertyValue", propertyID, value: "12345678" } }))));
      expect(r.fields["identifier"]).toBe("present (json-ld)");
    }
  });

  test("entities linked by @id count the same as nested ones", () => {
    const nested = run(page(ld(store({ address: { "@type": "PostalAddress", streetAddress: "1 Main St" } }))));
    const linked = run(
      page(
        ld({
          "@graph": [
            store({ "@id": `${BASE}#org`, address: { "@id": `${BASE}#addr` } }),
            { "@type": "PostalAddress", "@id": `${BASE}#addr`, streetAddress: "1 Main St" },
            { "@type": "WebSite", url: BASE, publisher: { "@id": `${BASE}#org` } },
          ],
        }),
      ),
    );
    expect(linked.m?.message).toBe(nested.m?.message);
    expect(linked.fields).toEqual(nested.fields);
  });

  test("an address object with no parts is not an address", () => {
    const r = run(page(ld(store({ address: { "@type": "PostalAddress" } }))));
    expect(r.fields["address"]).toBe("absent");
    expect(r.m?.message).toContain(": absent");
  });

  test("a placeholder name is not an actual name", () => {
    const r = run(page(ld(store({ name: "Company", vatID: "GB123456789" }))));
    expect(r.fields["name"]).toBe("absent");
    expect(r.m?.message).toContain(": absent");
  });

  test("visible legal-notice text alone is text-only, not structured identity", () => {
    const r = run(
      page("", "<footer>Beans Ltd, registered office 1 Main St. Company number 12345678</footer>"),
      { siteType: "ecommerce" },
    );
    expect(r.m?.message).toBe("Merchant identity in structured data: text-only");
    expect(r.fields["legal-notice-text"]).toBe("visible text only");
  });

  test("text next to a named store without address or identifier is still text-only", () => {
    const r = run(page(ld(store()), "<p>VAT no. GB 123 4567 89</p>"));
    expect(r.m?.message).toContain("text-only");
  });

  test("no identifiable organization is unknown, with no failure", () => {
    const r = run(page(ld({ "@type": "Product", name: "x" })));
    expect(r.m?.message).toBe("Merchant identity in structured data: unknown (no-organization)");
    expect(r.checks.some((c) => c.status === "warn" || c.status === "fail")).toBe(false);
  });

  test("a truncated read is unknown, never absent", () => {
    const html = `<!doctype html><html><head>${ld(store())}</head><body><p>cut`;
    const r = run(html);
    expect(r.m?.message).toBe("Merchant identity in structured data: unknown (incomplete-read)");
    expect(r.fields["address"]).toBe("unknown (incomplete-read)");
  });

  test("a failed read is unknown", () => {
    const r = run(page(ld(store())), { statusCode: 503 });
    expect(r.m?.message).toContain("unknown (incomplete-read)");
  });

  test("a page that is not a confirmed shop emits nothing", () => {
    const r = run(page(ld({ "@type": "Organization", name: "Acme", url: BASE })));
    expect(r.m).toBeUndefined();
  });

  test("existing organization results are unchanged and not duplicated", () => {
    const org = { "@type": "Organization", name: "Acme", url: BASE };
    const plain = run(page(ld(org)));
    const shop = run(page(ld(org)), { siteType: "ecommerce" });
    expect(shop.checks.filter((c) => c.name !== "organization-merchant-identity")).toEqual(plain.checks);
    expect(shop.m?.status).toBe("info");
  });
});
