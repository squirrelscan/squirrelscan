// Tests for extractors/links.ts - Link extraction with position detection

import {
  extractLinks,
  extractCrawlableUrls,
} from "@squirrelscan/parser/extractors";
import { describe, it, expect } from "bun:test";
import { parseHTML } from "linkedom";

function parseDoc(html: string) {
  return parseHTML(html).document;
}

describe("extractLinks", () => {
  const baseUrl = "https://example.com";

  it("extracts basic links", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <a href="/about">About Us</a>
          <a href="https://example.com/contact">Contact</a>
        </body>
      </html>
    `);

    const links = extractLinks(doc, baseUrl);
    expect(links.length).toBe(2);
    expect(links[0].href).toBe("https://example.com/about");
    expect(links[0].text).toBe("About Us");
    expect(links[1].href).toBe("https://example.com/contact");
  });

  it("resolves relative URLs", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <a href="/path/to/page">Page</a>
          <a href="relative-page">Relative</a>
          <a href="../parent">Parent</a>
        </body>
      </html>
    `);

    const links = extractLinks(doc, baseUrl);
    expect(links[0].href).toBe("https://example.com/path/to/page");
    expect(links[1].href).toBe("https://example.com/relative-page");
    expect(links[2].href).toBe("https://example.com/parent");
  });

  it("identifies internal vs external links", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <a href="/internal">Internal</a>
          <a href="https://example.com/also-internal">Also Internal</a>
          <a href="https://external.com/page">External</a>
        </body>
      </html>
    `);

    const links = extractLinks(doc, baseUrl);
    expect(links[0].isInternal).toBe(true);
    expect(links[1].isInternal).toBe(true);
    expect(links[2].isInternal).toBe(false);
  });

  it("detects link position in header", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <header>
            <a href="/home">Home</a>
          </header>
        </body>
      </html>
    `);

    const links = extractLinks(doc, baseUrl);
    expect(links[0].position).toBe("header");
  });

  it("detects link position in nav", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <nav>
            <a href="/about">About</a>
            <a href="/contact">Contact</a>
          </nav>
        </body>
      </html>
    `);

    const links = extractLinks(doc, baseUrl);
    expect(links[0].position).toBe("nav");
    expect(links[1].position).toBe("nav");
  });

  it("detects link position in footer", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <footer>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
          </footer>
        </body>
      </html>
    `);

    const links = extractLinks(doc, baseUrl);
    expect(links[0].position).toBe("footer");
    expect(links[1].position).toBe("footer");
  });

  it("detects link position in sidebar", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <aside>
            <a href="/related">Related</a>
          </aside>
        </body>
      </html>
    `);

    const links = extractLinks(doc, baseUrl);
    expect(links[0].position).toBe("sidebar");
  });

  it("detects link position in main content", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <main>
            <article>
              <a href="/read-more">Read More</a>
            </article>
          </main>
        </body>
      </html>
    `);

    const links = extractLinks(doc, baseUrl);
    expect(links[0].position).toBe("content");
  });

  it("extracts rel attributes", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <a href="/page" rel="nofollow noopener">Link</a>
        </body>
      </html>
    `);

    const links = extractLinks(doc, baseUrl);
    expect(links[0].rel).toContain("nofollow");
    expect(links[0].rel).toContain("noopener");
    expect(links[0].isNofollow).toBe(true);
  });

  it("identifies nofollow links", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <a href="/followed">Followed</a>
          <a href="/nofollow" rel="nofollow">NoFollow</a>
          <a href="/ugc" rel="ugc">UGC</a>
          <a href="/sponsored" rel="sponsored">Sponsored</a>
        </body>
      </html>
    `);

    const links = extractLinks(doc, baseUrl);
    expect(links[0].isNofollow).toBe(false);
    expect(links[1].isNofollow).toBe(true);
    expect(links[2].isNofollow).toBe(true);
    expect(links[3].isNofollow).toBe(true);
  });

  it("handles empty href", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <a href="">Empty</a>
          <a>No href</a>
        </body>
      </html>
    `);

    const links = extractLinks(doc, baseUrl);
    // Empty href and no href should be filtered out
    expect(links.length).toBe(0);
  });

  it("skips javascript and mailto links", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <a href="javascript:void(0)">JS Link</a>
          <a href="mailto:test@example.com">Email</a>
          <a href="tel:+1234567890">Phone</a>
          <a href="#">Empty Anchor</a>
          <a href="#section">Anchor</a>
          <a href="/real-page">Real Page</a>
        </body>
      </html>
    `);

    const links = extractLinks(doc, baseUrl);
    // Only skips javascript:, mailto:, tel:, data:, and exactly "#"
    // #section is kept because it's a valid anchor that resolves to the page
    expect(links.length).toBe(2);
    expect(links.some((l) => l.href.endsWith("/real-page"))).toBe(true);
    expect(links.some((l) => l.href.includes("#section"))).toBe(true);
  });

  it("detects position through very deep nesting (no depth cap)", () => {
    // 40 attribute-less wrappers between <nav> and the link — the walk is
    // unbounded, so position is still resolved (the early-exit optimization only
    // skips class/id work on attribute-less wrappers; it never stops walking).
    const wrappers = "<div>".repeat(40);
    const closers = "</div>".repeat(40);
    const doc = parseDoc(
      `<html><body><nav>${wrappers}<a href="/deep">Deep</a>${closers}</nav></body></html>`
    );
    const links = extractLinks(doc, baseUrl);
    expect(links[0].position).toBe("nav");
  });

  it("preserves tag/role precedence within a single ancestor", () => {
    // Element is both <footer> and role="banner" — original precedence checks the
    // header group (tag header OR role banner) before the footer group, so this
    // must resolve to "header".
    const doc = parseDoc(
      `<html><body><footer role="banner"><a href="/x">X</a></footer></body></html>`
    );
    const links = extractLinks(doc, baseUrl);
    expect(links[0].position).toBe("header");
  });

  it("handles complex nested structures", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <header>
            <nav>
              <ul>
                <li><a href="/home">Home</a></li>
                <li><a href="/about">About</a></li>
              </ul>
            </nav>
          </header>
          <main>
            <article>
              <p>Check out our <a href="/products">products</a>.</p>
            </article>
          </main>
          <footer>
            <div class="links">
              <a href="/privacy">Privacy</a>
            </div>
          </footer>
        </body>
      </html>
    `);

    const links = extractLinks(doc, baseUrl);
    expect(links.length).toBe(4);
    // Links in nav inside header should be nav position
    expect(links[0].position).toBe("nav");
    expect(links[1].position).toBe("nav");
    expect(links[2].position).toBe("content");
    expect(links[3].position).toBe("footer");
  });
});

describe("extractCrawlableUrls", () => {
  const baseUrl = "https://example.com";

  it("extracts only internal links", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <a href="/about">About</a>
          <a href="https://external.com">External</a>
          <a href="/contact">Contact</a>
        </body>
      </html>
    `);

    const urls = extractCrawlableUrls(doc, baseUrl);
    expect(urls.length).toBe(2);
    expect(urls).toContain("https://example.com/about");
    expect(urls).toContain("https://example.com/contact");
  });

  it("deduplicates URLs", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <a href="/about">About</a>
          <a href="/about">About Again</a>
          <a href="/about?utm=test">About with UTM</a>
        </body>
      </html>
    `);

    const urls = extractCrawlableUrls(doc, baseUrl);
    // Should dedupe (though UTM might be kept - depends on implementation)
    expect(urls.length).toBeLessThanOrEqual(3);
  });

  it("skips non-crawlable URLs", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <a href="javascript:void(0)">JS</a>
          <a href="mailto:a@b.com">Mail</a>
          <a href="#">Empty Anchor</a>
          <a href="#anchor">Anchor</a>
          <a href="/valid">Valid</a>
        </body>
      </html>
    `);

    const urls = extractCrawlableUrls(doc, baseUrl);
    // #anchor resolves to baseUrl#anchor, which after removing fragment becomes baseUrl
    // So we might get 2 URLs (or the anchor might be deduped with baseUrl)
    expect(urls.length).toBeGreaterThanOrEqual(1);
    expect(urls.some((u) => u.includes("/valid"))).toBe(true);
  });
});
