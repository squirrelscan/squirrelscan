// Tests for extractors/meta.ts - Meta tag extraction

import {
  extractMeta,
  extractOG,
  extractTwitter,
  extractH1,
} from "@squirrelscan/parser/extractors";
import { describe, it, expect } from "bun:test";
import { parseHTML } from "linkedom";

function parseDoc(html: string) {
  return parseHTML(html).document;
}

describe("extractMeta", () => {
  it("extracts title from title tag", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <title>My Page Title</title>
        </head>
        <body></body>
      </html>
    `);

    const meta = extractMeta(doc);
    expect(meta.title).toBe("My Page Title");
  });

  it("extracts meta description", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <meta name="description" content="This is a description">
        </head>
        <body></body>
      </html>
    `);

    const meta = extractMeta(doc);
    expect(meta.description).toBe("This is a description");
  });

  it("extracts canonical URL", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <link rel="canonical" href="https://example.com/canonical-page">
        </head>
        <body></body>
      </html>
    `);

    const meta = extractMeta(doc);
    expect(meta.canonical).toBe("https://example.com/canonical-page");
  });

  it("extracts robots meta tag", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <meta name="robots" content="noindex, nofollow">
        </head>
        <body></body>
      </html>
    `);

    const meta = extractMeta(doc);
    expect(meta.robots).toBe("noindex, nofollow");
  });

  it("handles missing meta tags", () => {
    const doc = parseDoc(`
      <html>
        <head></head>
        <body></body>
      </html>
    `);

    const meta = extractMeta(doc);
    expect(meta.title).toBeNull();
    expect(meta.description).toBeNull();
    expect(meta.canonical).toBeNull();
    expect(meta.robots).toBeNull();
  });

  it("handles empty values", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <title></title>
          <meta name="description" content="">
        </head>
        <body></body>
      </html>
    `);

    const meta = extractMeta(doc);
    expect(meta.title).toBe(null);
    expect(meta.description).toBe(null);
  });

  it("extracts all fields together", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <title>Complete Page</title>
          <meta name="description" content="Full description">
          <link rel="canonical" href="https://example.com/page">
          <meta name="robots" content="index, follow">
        </head>
        <body></body>
      </html>
    `);

    const meta = extractMeta(doc);
    expect(meta.title).toBe("Complete Page");
    expect(meta.description).toBe("Full description");
    expect(meta.canonical).toBe("https://example.com/page");
    expect(meta.robots).toBe("index, follow");
  });
});

describe("extractOG", () => {
  it("extracts Open Graph title", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <meta property="og:title" content="OG Title">
        </head>
        <body></body>
      </html>
    `);

    const og = extractOG(doc);
    expect(og.title).toBe("OG Title");
  });

  it("extracts all Open Graph properties", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <meta property="og:title" content="OG Title">
          <meta property="og:description" content="OG Description">
          <meta property="og:url" content="https://example.com/og-page">
          <meta property="og:type" content="website">
          <meta property="og:image" content="https://example.com/og-image.jpg">
          <meta property="og:site_name" content="Example Site">
        </head>
        <body></body>
      </html>
    `);

    const og = extractOG(doc);
    expect(og.title).toBe("OG Title");
    expect(og.description).toBe("OG Description");
    expect(og.url).toBe("https://example.com/og-page");
    expect(og.type).toBe("website");
    expect(og.image).toBe("https://example.com/og-image.jpg");
    expect(og.siteName).toBe("Example Site");
  });

  it("handles missing Open Graph tags", () => {
    const doc = parseDoc(`
      <html>
        <head></head>
        <body></body>
      </html>
    `);

    const og = extractOG(doc);
    expect(og.title).toBeNull();
    expect(og.description).toBeNull();
    expect(og.url).toBeNull();
    expect(og.type).toBeNull();
    expect(og.image).toBeNull();
    expect(og.siteName).toBeNull();
  });
});

describe("extractTwitter", () => {
  it("extracts Twitter card type", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <meta name="twitter:card" content="summary_large_image">
        </head>
        <body></body>
      </html>
    `);

    const twitter = extractTwitter(doc);
    expect(twitter.card).toBe("summary_large_image");
  });

  it("extracts all Twitter card properties", () => {
    const doc = parseDoc(`
      <html>
        <head>
          <meta name="twitter:card" content="summary">
          <meta name="twitter:title" content="Twitter Title">
          <meta name="twitter:description" content="Twitter Description">
          <meta name="twitter:image" content="https://example.com/twitter.jpg">
        </head>
        <body></body>
      </html>
    `);

    const twitter = extractTwitter(doc);
    expect(twitter.card).toBe("summary");
    expect(twitter.title).toBe("Twitter Title");
    expect(twitter.description).toBe("Twitter Description");
    expect(twitter.image).toBe("https://example.com/twitter.jpg");
  });

  it("handles missing Twitter tags", () => {
    const doc = parseDoc(`
      <html>
        <head></head>
        <body></body>
      </html>
    `);

    const twitter = extractTwitter(doc);
    expect(twitter.card).toBeNull();
    expect(twitter.title).toBeNull();
    expect(twitter.description).toBeNull();
    expect(twitter.image).toBeNull();
  });
});

describe("extractH1", () => {
  it("extracts single H1", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <h1>Main Heading</h1>
        </body>
      </html>
    `);

    const h1 = extractH1(doc);
    expect(h1.count).toBe(1);
    expect(h1.texts).toContain("Main Heading");
  });

  it("extracts multiple H1s", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <h1>First Heading</h1>
          <h1>Second Heading</h1>
          <h1>Third Heading</h1>
        </body>
      </html>
    `);

    const h1 = extractH1(doc);
    expect(h1.count).toBe(3);
    expect(h1.texts).toContain("First Heading");
    expect(h1.texts).toContain("Second Heading");
    expect(h1.texts).toContain("Third Heading");
  });

  it("handles no H1s", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <h2>Not an H1</h2>
          <p>No heading here</p>
        </body>
      </html>
    `);

    const h1 = extractH1(doc);
    expect(h1.count).toBe(0);
    expect(h1.texts).toEqual([]);
  });

  it("trims whitespace from H1 text", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <h1>
            Heading with Whitespace
          </h1>
        </body>
      </html>
    `);

    const h1 = extractH1(doc);
    expect(h1.texts[0]).toBe("Heading with Whitespace");
  });

  it("handles empty H1s", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <h1></h1>
          <h1>   </h1>
          <h1>Valid</h1>
        </body>
      </html>
    `);

    const h1 = extractH1(doc);
    expect(h1.count).toBe(3);
    // Empty strings should be included
    expect(h1.texts.length).toBe(3);
  });

  it("extracts text from nested elements", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <h1><span>Nested</span> <strong>Heading</strong></h1>
        </body>
      </html>
    `);

    const h1 = extractH1(doc);
    expect(h1.texts[0]).toContain("Nested");
    expect(h1.texts[0]).toContain("Heading");
  });
});
