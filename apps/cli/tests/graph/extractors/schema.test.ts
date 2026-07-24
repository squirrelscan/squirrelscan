// Tests for extractors/schema.ts - Schema.org JSON-LD extraction

import {
  SchemaCollection,
  schemaCollectionFromJSON,
} from "@squirrelscan/parser";
import { extractSchema } from "@squirrelscan/parser/extractors";
import { describe, it, expect } from "bun:test";
import { parseHTML } from "linkedom";

function parseDoc(html: string) {
  return parseHTML(html).document;
}

describe("extractSchema", () => {
  it("extracts JSON-LD schema", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Organization",
              "name": "Example Company"
            }
          </script>
        </head>
        <body></body>
      </html>
    `);

    const schema = extractSchema(doc);
    expect(schema.types).toContain("Organization");
    expect(schema.valid).toBe(true);
    expect(schema.errors.length).toBe(0);
  });

  it("extracts multiple schema types", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "WebPage",
              "name": "Home"
            }
          </script>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Organization",
              "name": "Company"
            }
          </script>
        </head>
        <body></body>
      </html>
    `);

    const schema = extractSchema(doc);
    expect(schema.types).toContain("WebPage");
    expect(schema.types).toContain("Organization");
  });

  it("handles nested types with @graph", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@graph": [
                { "@type": "WebSite", "name": "Site" },
                { "@type": "Organization", "name": "Org" },
                { "@type": "WebPage", "name": "Page" }
              ]
            }
          </script>
        </head>
        <body></body>
      </html>
    `);

    const schema = extractSchema(doc);
    expect(schema.types).toContain("WebSite");
    expect(schema.types).toContain("Organization");
    expect(schema.types).toContain("WebPage");
  });

  it("inherits @context from parent in @graph structure", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@graph": [
                { "@type": "WebSite", "name": "Site", "url": "https://example.com" },
                { "@type": "Organization", "name": "Org", "url": "https://example.com" }
              ]
            }
          </script>
        </head>
        <body></body>
      </html>
    `);

    const schema = extractSchema(doc);
    // Should not report "Missing @context" for @graph items
    expect(schema.valid).toBe(true);
    expect(schema.errors).not.toContainEqual(
      expect.stringContaining("Missing @context")
    );
  });

  it("handles array of types", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <script type="application/ld+json">
            [
              { "@type": "Article", "headline": "Test" },
              { "@type": "Person", "name": "Author" }
            ]
          </script>
        </head>
        <body></body>
      </html>
    `);

    const schema = extractSchema(doc);
    expect(schema.types).toContain("Article");
    expect(schema.types).toContain("Person");
  });

  it("handles invalid JSON", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <script type="application/ld+json">
            { invalid json here
          </script>
        </head>
        <body></body>
      </html>
    `);

    const schema = extractSchema(doc);
    expect(schema.valid).toBe(false);
    expect(schema.errors.length).toBeGreaterThan(0);
  });

  it("handles empty JSON-LD", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <script type="application/ld+json"></script>
        </head>
        <body></body>
      </html>
    `);

    const schema = extractSchema(doc);
    expect(schema.types.length).toBe(0);
  });

  it("handles no schema at all", () => {
    const doc = parseDoc(`
      <html>
        <head></head>
        <body></body>
      </html>
    `);

    const schema = extractSchema(doc);
    expect(schema.types.length).toBe(0);
    expect(schema.valid).toBe(true);
    expect(schema.raw).toBeNull();
  });

  it("extracts common SEO schema types", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Article",
              "headline": "Test Article",
              "author": {
                "@type": "Person",
                "name": "John Doe"
              },
              "publisher": {
                "@type": "Organization",
                "name": "Example Pub"
              }
            }
          </script>
        </head>
        <body></body>
      </html>
    `);

    const schema = extractSchema(doc);
    expect(schema.types).toContain("Article");
    expect(schema.types).toContain("Person");
    expect(schema.types).toContain("Organization");
  });

  it("handles BreadcrumbList schema", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "BreadcrumbList",
              "itemListElement": [
                { "@type": "ListItem", "position": 1, "name": "Home" },
                { "@type": "ListItem", "position": 2, "name": "Products" }
              ]
            }
          </script>
        </head>
        <body></body>
      </html>
    `);

    const schema = extractSchema(doc);
    expect(schema.types).toContain("BreadcrumbList");
    expect(schema.types).toContain("ListItem");
  });

  it("stores raw JSON for further analysis", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <script type="application/ld+json">
            {"@type": "Product", "name": "Test"}
          </script>
        </head>
        <body></body>
      </html>
    `);

    const schema = extractSchema(doc);
    expect(schema.raw).not.toBeNull();
  });

  it("preserves multi-type @type arrays (GH#5)", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": ["LocalBusiness", "Organization"],
              "name": "My Business",
              "address": {
                "@type": "PostalAddress",
                "streetAddress": "123 Main St"
              }
            }
          </script>
        </head>
        <body></body>
      </html>
    `);

    const schema = extractSchema(doc);
    // Both types should be in the types array
    expect(schema.types).toContain("LocalBusiness");
    expect(schema.types).toContain("Organization");
    expect(schema.types).toContain("PostalAddress");
    expect(schema.valid).toBe(true);
  });
});

describe("schemaCollectionFromJSON", () => {
  it("rehydrates SchemaCollection from serialized data (GH#4)", () => {
    // Simulate what happens when parsedData is deserialized from storage
    const original = new SchemaCollection(
      [{ "@type": "Product", name: "Test" }],
      [],
      '{"@type":"Product"}',
      []
    );

    // Serialize and deserialize (simulates storage round-trip)
    const serialized = JSON.stringify(original);
    const deserialized = JSON.parse(serialized);

    // deserialized is a plain object - .types getter doesn't exist
    expect(deserialized.types).toBeUndefined();

    // Rehydrate restores the getter
    const rehydrated = schemaCollectionFromJSON(deserialized);
    expect(rehydrated.types).toEqual(["Product"]);
    expect(rehydrated.all).toHaveLength(1);
    expect(rehydrated.valid).toBe(true);
  });

  it("handles null/undefined gracefully", () => {
    expect(schemaCollectionFromJSON(null).types).toEqual([]);
    expect(schemaCollectionFromJSON(undefined).types).toEqual([]);
  });

  it("handles empty object", () => {
    const rehydrated = schemaCollectionFromJSON({});
    expect(rehydrated.types).toEqual([]);
    expect(rehydrated.all).toEqual([]);
  });
});
