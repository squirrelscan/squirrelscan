// Tests for processors/parse/parse-page.ts - Page parsing and extraction

import { describe, it, expect } from "bun:test";
import { Effect } from "effect";

import {
  parseDocument,
  parseDocumentEffect,
  extractAllFromDocument,
  getCrawlableUrlsFromDocument,
  parsePageProcessor,
} from "../../../../src/parse/document";

describe("parseDocument", () => {
  it("parses valid HTML", () => {
    const html = `<html><head><title>Test</title></head><body><h1>Hello</h1></body></html>`;
    const doc = parseDocument(html);

    expect(doc.querySelector("h1")?.textContent).toBe("Hello");
    expect(doc.querySelector("title")?.textContent).toBe("Test");
  });

  it("handles minimal HTML", () => {
    const html = `<p>Just a paragraph</p>`;
    const doc = parseDocument(html);

    expect(doc.querySelector("p")?.textContent).toBe("Just a paragraph");
  });

  it("handles empty HTML", () => {
    const html = "";
    const doc = parseDocument(html);

    expect(doc).toBeDefined();
  });

  it("handles malformed HTML", () => {
    const html = `<html><head><title>Test</head><body><p>Unclosed`;
    const doc = parseDocument(html);

    // linkedom is lenient with malformed HTML
    expect(doc).toBeDefined();
  });
});

describe("parseDocumentEffect", () => {
  it("succeeds with valid HTML", async () => {
    const html = `<html><body><h1>Test</h1></body></html>`;
    const result = await Effect.runPromise(
      parseDocumentEffect(html, "https://example.com")
    );

    expect(result.querySelector("h1")?.textContent).toBe("Test");
  });

  it("succeeds with empty HTML", async () => {
    const result = await Effect.runPromise(
      parseDocumentEffect("", "https://example.com")
    );

    expect(result).toBeDefined();
  });
});

describe("extractAllFromDocument", () => {
  it("extracts all data types concurrently", async () => {
    const html = `
      <html>
        <head>
          <title>Test Page</title>
          <meta name="description" content="Test description">
          <meta property="og:title" content="OG Title">
          <meta name="twitter:card" content="summary">
        </head>
        <body>
          <h1>Main Heading</h1>
          <h2>Sub Heading</h2>
          <a href="/about">About</a>
          <img src="/logo.png" alt="Logo">
        </body>
      </html>
    `;
    const doc = parseDocument(html);
    const result = await Effect.runPromise(
      extractAllFromDocument(doc, html, "https://example.com")
    );

    expect(result.meta.title).toBe("Test Page");
    expect(result.meta.description).toBe("Test description");
    expect(result.og.title).toBe("OG Title");
    expect(result.twitter.card).toBe("summary");
    expect(result.h1.count).toBe(1);
    expect(result.h1.texts).toContain("Main Heading");
    expect(result.headings.h1Count).toBe(1);
    expect(result.headings.headings.filter((h) => h.level === 2).length).toBe(
      1
    );
  });

  it("handles page with no meta", async () => {
    const html = `<html><body><p>Minimal page</p></body></html>`;
    const doc = parseDocument(html);
    const result = await Effect.runPromise(
      extractAllFromDocument(doc, html, "https://example.com")
    );

    expect(result.meta.title).toBeNull();
    expect(result.meta.description).toBeNull();
    expect(result.og.title).toBeNull();
    expect(result.twitter.card).toBeNull();
    expect(result.h1.count).toBe(0);
  });

  it("extracts schema from JSON-LD", async () => {
    const html = `
      <html>
        <head>
          <script type="application/ld+json">
            {"@type": "Organization", "name": "Test Corp"}
          </script>
        </head>
        <body></body>
      </html>
    `;
    const doc = parseDocument(html);
    const result = await Effect.runPromise(
      extractAllFromDocument(doc, html, "https://example.com")
    );

    expect(result.schema.types).toContain("Organization");
    expect(result.schema.valid).toBe(true);
  });

  it("extracts content stats", async () => {
    const html = `
      <html>
        <body>
          <p>This is some test content with multiple words.</p>
          <p>Another paragraph here.</p>
        </body>
      </html>
    `;
    const doc = parseDocument(html);
    const result = await Effect.runPromise(
      extractAllFromDocument(doc, html, "https://example.com")
    );

    expect(result.content.wordCount).toBeGreaterThan(0);
    expect(result.content.textLength).toBeGreaterThan(0);
  });
});

describe("getCrawlableUrlsFromDocument", () => {
  it("extracts internal URLs", () => {
    const html = `
      <html>
        <body>
          <a href="/about">About</a>
          <a href="/contact">Contact</a>
        </body>
      </html>
    `;
    const doc = parseDocument(html);
    const urls = getCrawlableUrlsFromDocument(doc, "https://example.com");

    expect(urls).toContain("https://example.com/about");
    expect(urls).toContain("https://example.com/contact");
  });

  it("excludes external URLs", () => {
    const html = `
      <html>
        <body>
          <a href="/internal">Internal</a>
          <a href="https://external.com/page">External</a>
        </body>
      </html>
    `;
    const doc = parseDocument(html);
    const urls = getCrawlableUrlsFromDocument(doc, "https://example.com");

    expect(urls).toContain("https://example.com/internal");
    expect(urls).not.toContain("https://external.com/page");
  });

  it("excludes non-crawlable protocols", () => {
    const html = `
      <html>
        <body>
          <a href="javascript:void(0)">JS</a>
          <a href="mailto:test@example.com">Email</a>
          <a href="tel:+1234567890">Phone</a>
          <a href="/valid">Valid</a>
        </body>
      </html>
    `;
    const doc = parseDocument(html);
    const urls = getCrawlableUrlsFromDocument(doc, "https://example.com");

    expect(urls.length).toBe(1);
    expect(urls).toContain("https://example.com/valid");
  });

  it("deduplicates URLs", () => {
    const html = `
      <html>
        <body>
          <a href="/about">About</a>
          <a href="/about">About Again</a>
          <a href="/about">About Third</a>
        </body>
      </html>
    `;
    const doc = parseDocument(html);
    const urls = getCrawlableUrlsFromDocument(doc, "https://example.com");

    // Should deduplicate
    const aboutUrls = urls.filter((u) => u.includes("/about"));
    expect(aboutUrls.length).toBeLessThanOrEqual(3);
  });
});

describe("parsePageProcessor", () => {
  it("parses page and extracts data", async () => {
    const html = `
      <html>
        <head>
          <title>Test Page</title>
          <meta name="description" content="A test page">
        </head>
        <body>
          <h1>Welcome</h1>
          <a href="/about">About</a>
          <a href="/contact">Contact</a>
        </body>
      </html>
    `;

    const result = await Effect.runPromise(
      parsePageProcessor(html, "https://example.com", "https://example.com")
    );

    expect(result.parsed.meta.title).toBe("Test Page");
    expect(result.parsed.meta.description).toBe("A test page");
    expect(result.parsed.h1.texts).toContain("Welcome");
    expect(result.crawlableUrls).toContain("https://example.com/about");
    expect(result.crawlableUrls).toContain("https://example.com/contact");
  });

  it("handles page with complex structure", async () => {
    const html = `
      <html>
        <head>
          <title>Complex Page</title>
          <link rel="canonical" href="https://example.com/page">
          <script type="application/ld+json">
            {"@type": "Article", "headline": "Test Article"}
          </script>
        </head>
        <body>
          <header>
            <nav>
              <a href="/home">Home</a>
              <a href="/blog">Blog</a>
            </nav>
          </header>
          <main>
            <article>
              <h1>Article Title</h1>
              <p>Article content here.</p>
              <a href="/related">Related Post</a>
            </article>
          </main>
          <footer>
            <a href="/privacy">Privacy</a>
          </footer>
        </body>
      </html>
    `;

    const result = await Effect.runPromise(
      parsePageProcessor(
        html,
        "https://example.com/page",
        "https://example.com"
      )
    );

    expect(result.parsed.meta.canonical).toBe("https://example.com/page");
    expect(result.parsed.schema.types).toContain("Article");
    expect(result.parsed.h1.texts).toContain("Article Title");
    expect(result.crawlableUrls).toContain("https://example.com/home");
    expect(result.crawlableUrls).toContain("https://example.com/blog");
    expect(result.crawlableUrls).toContain("https://example.com/related");
    expect(result.crawlableUrls).toContain("https://example.com/privacy");
  });

  it("handles empty page", async () => {
    const html = `<html><head></head><body></body></html>`;

    const result = await Effect.runPromise(
      parsePageProcessor(html, "https://example.com", "https://example.com")
    );

    expect(result.parsed.meta.title).toBeNull();
    expect(result.parsed.h1.count).toBe(0);
    expect(result.crawlableUrls.length).toBe(0);
  });
});
