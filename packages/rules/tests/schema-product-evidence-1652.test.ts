// #1652: schema/product reports name, description, image, price and availability
// as present, absent or unknown, with the representation each was read from.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { productSchemaRule } from "../src/schema/product";
import type { RuleContext } from "../src/types";

const BASE = "http://127.0.0.1:8765/p";

interface Out {
  checks: Array<{ name: string; status: string; message: string; items?: Array<{ id: string; label?: string }> }>;
  fields: Record<string, string>;
  byName: (n: string) => string | undefined;
}

function run(html: string, extra: Partial<RuleContext> = {}): Out {
  const ctx = {
    page: { url: BASE, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, BASE),
    options: {},
    ...extra,
  } as unknown as RuleContext;
  const checks = productSchemaRule.run(ctx).checks as Out["checks"];
  const ev = checks.find((c) => c.name === "product-field-evidence");
  const fields: Record<string, string> = {};
  for (const i of ev?.items ?? []) fields[i.id] = i.label ?? "";
  return { checks, fields, byName: (n) => checks.find((c) => c.name === n)?.status };
}

const page = (head: string, body = "<h1>t</h1>") =>
  `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body>${body}</body></html>`;
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

const full = () => ({
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Dripper",
  description: "x",
  image: "https://e.test/a.jpg",
  offers: { "@type": "Offer", price: "32.00", priceCurrency: "USD", availability: "https://schema.org/InStock" },
});

describe("schema/product field evidence (#1652): JSON-LD Product", () => {
  test("all fields present, no warnings", () => {
    const r = run(page(ld(full())));
    expect(r.fields).toEqual({
      name: "present (json-ld)",
      description: "present (json-ld)",
      image: "present (json-ld)",
      price: "present (json-ld)",
      availability: "present (json-ld)",
    });
    expect(r.byName("product-required")).toBe("pass");
    expect(r.byName("product-offer-details")).toBeUndefined();
  });

  for (const field of ["name", "description", "image", "price", "availability"]) {
    test(`removing ${field} alone makes only ${field} absent`, () => {
      const p = full() as Record<string, unknown>;
      if (field === "price" || field === "availability") delete (p["offers"] as Record<string, unknown>)[field];
      else delete p[field];
      const r = run(page(ld(p)));
      for (const [k, v] of Object.entries(r.fields)) {
        expect(v === "absent").toBe(k === field);
      }
    });
  }

  test("missing fields are warned once by the existing checks, never by the evidence check", () => {
    const p = full() as Record<string, unknown>;
    delete p["name"];
    const r = run(page(ld(p)));
    expect(r.byName("product-required")).toBe("warn");
    expect(r.byName("product-field-evidence")).toBe("info");
    expect(r.checks.filter((c) => c.status === "warn")).toHaveLength(1);
  });

  test("description is judged on presence, not on length", () => {
    const r = run(page(ld(full())));
    expect(r.fields["description"]).toBe("present (json-ld)");
  });

  test("a price of 0 is declared", () => {
    const p = full();
    (p.offers as Record<string, unknown>).price = 0;
    expect(run(page(ld(p))).fields["price"]).toBe("present (json-ld)");
  });

  test("offers by @id reference resolve", () => {
    const r = run(
      page(
        ld({
          "@graph": [
            { "@type": "Product", name: "n", offers: { "@id": `${BASE}#o` } },
            { "@type": "Offer", "@id": `${BASE}#o`, price: "1", availability: "https://schema.org/InStock" },
          ],
        }),
      ),
    );
    expect(r.fields["price"]).toBe("present (json-ld)");
    expect(r.fields["availability"]).toBe("present (json-ld)");
  });

  test("a dangling offer reference is unknown, not absent", () => {
    const r = run(page(ld({ "@type": "Product", name: "n", offers: { "@id": `${BASE}#gone` } })));
    expect(r.fields["price"]).toBe("unknown (unresolved-reference)");
  });
});

describe("schema/product field evidence (#1652): ProductGroup with variants", () => {
  const group = (variant: Record<string, unknown>) => ({
    "@context": "https://schema.org",
    "@type": "ProductGroup",
    name: "Shirt",
    description: "A shirt",
    hasVariant: [variant],
  });

  test("price, availability and image read from a variant count for the group", () => {
    const r = run(
      page(
        ld(
          group({
            "@type": "Product",
            image: "https://e.test/s.jpg",
            offers: { "@type": "Offer", price: "9", availability: "https://schema.org/InStock" },
          }),
        ),
      ),
    );
    expect(Object.values(r.fields).every((v) => v.startsWith("present"))).toBe(true);
    expect(r.byName("product-required")).toBe("pass");
  });

  test("variants referenced by @id resolve the same as inline ones", () => {
    const inline = run(
      page(ld(group({ "@type": "Product", image: "i", offers: { price: "1", availability: "a" } }))),
    );
    const linked = run(
      page(
        ld({
          "@graph": [
            { "@type": "ProductGroup", name: "Shirt", description: "d", hasVariant: [{ "@id": `${BASE}#v` }] },
            { "@type": "Product", "@id": `${BASE}#v`, image: "i", offers: { price: "1", availability: "a" } },
          ],
        }),
      ),
    );
    expect(linked.fields).toEqual(inline.fields);
  });

  test("a field no variant and not the group has is absent", () => {
    const r = run(page(ld(group({ "@type": "Product", offers: { price: "1", availability: "a" } }))));
    expect(r.fields["image"]).toBe("absent");
    expect(r.byName("product-required")).toBe("warn");
  });
});

describe("schema/product field evidence (#1652): Microdata and RDFa", () => {
  test("Microdata product with a nested Offer", () => {
    const body = `<div itemscope itemtype="https://schema.org/Product">
      <h1 itemprop="name">Dripper</h1><p itemprop="description">Pour over</p>
      <img itemprop="image" src="/a.jpg" alt="">
      <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
        <meta itemprop="price" content="32.00"><link itemprop="availability" href="https://schema.org/InStock">
      </div></div>`;
    const r = run(page("", body));
    expect(Object.values(r.fields)).toEqual(Array(5).fill("present (microdata)"));
    expect(r.byName("product-schema")).toBeUndefined();
  });

  test("Microdata product missing its image", () => {
    const body = `<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">N</span></div>`;
    const r = run(page("", body));
    expect(r.fields["name"]).toBe("present (microdata)");
    expect(r.fields["image"]).toBe("absent");
    expect(r.byName("product-required")).toBe("warn");
  });

  test("RDFa product with a nested Offer", () => {
    const body = `<div vocab="https://schema.org/" typeof="Product">
      <span property="name">Dripper</span><span property="description">d</span>
      <img property="image" src="/a.jpg" alt="">
      <div property="offers" typeof="Offer"><span property="price" content="32.00">$32</span>
      <link property="availability" href="https://schema.org/InStock"></div></div>`;
    const r = run(page("", body));
    expect(Object.values(r.fields)).toEqual(Array(5).fill("present (rdfa)"));
  });

  test("an itemref leaves unfound fields unsupported, not absent", () => {
    const body = `<div itemscope itemtype="https://schema.org/Product" itemref="x"><span itemprop="name">N</span></div><p id="x" itemprop="image">far</p>`;
    const r = run(page("", body));
    expect(r.fields["image"]).toBe("unknown (unsupported)");
  });
});

describe("schema/product field evidence (#1652): JavaScript shells and truncated reads", () => {
  const shell = `<!doctype html><html><head><title>t</title><meta property="og:type" content="product"></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;

  test("a JavaScript-only product shell reports every field unknown (rendered-only)", () => {
    const r = run(shell);
    expect(Object.values(r.fields)).toEqual(Array(5).fill("unknown (rendered-only)"));
    expect(r.checks.some((c) => c.status === "warn")).toBe(false);
  });

  test("a script that builds the JSON-LD is rendered-only too", () => {
    const html = page(`<script>var d={"@context":"https://schema.org/Product"}</script>`);
    expect(run(html).fields["name"]).toBe("unknown (rendered-only)");
  });

  test("an ordinary page with no product signal gets no evidence", () => {
    const r = run(page(""));
    expect(r.byName("product-schema")).toBe("info");
    expect(r.byName("product-field-evidence")).toBeUndefined();
  });

  test("a truncated read keeps found fields present and leaves the rest unknown", () => {
    const html = `<!doctype html><html><head>${ld({ "@type": "Product", name: "N" })}</head><body><p>cut off mid-sent`;
    const r = run(html);
    expect(r.fields["name"]).toBe("present (json-ld)");
    expect(r.fields["image"]).toBe("unknown (incomplete-read)");
    expect(r.fields["price"]).toBe("unknown (incomplete-read)");
    expect(r.checks.some((c) => c.status === "warn")).toBe(false);
  });

  // htmlReadState is a heuristic: a page that ends in </html> or </body> was served whole.
  test("valid HTML that omits </html> but ends in </body> is a complete read", () => {
    const html = `<!doctype html><html><head><title>t</title>${ld({ "@type": "Product", name: "N" })}</head><body><p>done</p></body>`;
    const r = run(html);
    expect(r.fields["image"]).toBe("absent");
    expect(r.fields["name"]).toBe("present (json-ld)");
  });

  test("a long tail after </html> (more than 4 KB of comments and whitespace) is still a complete read", () => {
    const tail = `<!-- ${"analytics snippet ".repeat(800)} -->\n${" ".repeat(2000)}`;
    expect(tail.length).toBeGreaterThan(8000);
    const r = run(page(ld({ "@type": "Product", name: "N" })) + tail);
    expect(r.fields["image"]).toBe("absent");
  });

  test("a page with neither </html> nor </body> near its end stays a truncated read", () => {
    const html = `<!doctype html><html><head>${ld({ "@type": "Product", name: "N" })}</head><body><p>cut ${"x".repeat(9000)}`;
    expect(run(html).fields["image"]).toBe("unknown (incomplete-read)");
  });

  test("a closing tag far from the end (past the tail searched) does not make a cut-off page complete", () => {
    const html = `<!doctype html><html><head>${ld({ "@type": "Product", name: "N" })}</head><body></body></html>${"x".repeat(80_000)}<p>cut`;
    expect(run(html).fields["image"]).toBe("unknown (incomplete-read)");
  });

  test("a failed read (error status) never proves absence", () => {
    const html = page(ld({ "@type": "Product", name: "N" }));
    const r = run(html, { page: { url: BASE, html, statusCode: 503, loadTime: 0, headers: {} } } as never);
    expect(r.fields["image"]).toBe("unknown (incomplete-read)");
  });

  test("a complete read of the same product says absent", () => {
    const r = run(page(ld({ "@type": "Product", name: "N" })));
    expect(r.fields["image"]).toBe("absent");
  });
});

// Measured at about 150 ms on a quiet machine; the budget leaves room for a loaded CI runner and still fails a 100x slowdown.
const HOSTILE_BUDGET_MS = 2000;

describe("schema/product field evidence (#1652): hostile markup stays bounded", () => {
  test(
    "deeply nested and very many Microdata scopes finish and still answer",
    () => {
      const deep = '<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">N</span>' +
        '<div itemprop="offers" itemscope>'.repeat(3000) +
        "</div>".repeat(3000) + "</div>";
      const many = '<div itemscope itemtype="https://schema.org/Thing"></div>'.repeat(20000);
      const started = performance.now();
      const r = run(page("", deep + many));
      const elapsed = performance.now() - started;
      expect(r.fields["name"]).toBe("present (microdata)");
      // The caps keep this linear. A 100x slowdown (a quadratic walk) fails here, not just at the 30 s timeout.
      expect(elapsed).toBeLessThan(HOSTILE_BUDGET_MS);
    },
    30_000,
  );
});
