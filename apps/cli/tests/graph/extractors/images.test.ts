// Tests for extractors/images.ts - Image extraction

import { extractImages } from "@squirrelscan/parser/extractors";
import { describe, it, expect } from "bun:test";
import { parseHTML } from "linkedom";

function parseDoc(html: string) {
  return parseHTML(html).document;
}

describe("extractImages", () => {
  const baseUrl = "https://example.com";

  it("extracts basic images", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <img src="/logo.png" alt="Logo">
          <img src="https://example.com/banner.jpg" alt="Banner">
        </body>
      </html>
    `);

    const images = extractImages(doc, baseUrl);
    expect(images.length).toBe(2);
    expect(images[0].src).toBe("https://example.com/logo.png");
    expect(images[0].alt).toBe("Logo");
    expect(images[1].src).toBe("https://example.com/banner.jpg");
  });

  it("resolves relative URLs", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <img src="/images/photo.png" alt="Photo">
          <img src="relative.jpg" alt="Relative">
          <img src="../parent/image.gif" alt="Parent">
        </body>
      </html>
    `);

    const images = extractImages(doc, baseUrl);
    expect(images[0].src).toBe("https://example.com/images/photo.png");
    expect(images[1].src).toBe("https://example.com/relative.jpg");
    expect(images[2].src).toBe("https://example.com/parent/image.gif");
  });

  it("extracts width and height attributes", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <img src="/img.png" width="200" height="100" alt="Sized">
        </body>
      </html>
    `);

    const images = extractImages(doc, baseUrl);
    expect(images[0].width).toBe("200");
    expect(images[0].height).toBe("100");
  });

  it("handles missing alt text", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <img src="/no-alt.png">
          <img src="/empty-alt.png" alt="">
          <img src="/with-alt.png" alt="Description">
        </body>
      </html>
    `);

    const images = extractImages(doc, baseUrl);
    expect(images[0].alt).toBeNull();
    expect(images[1].alt).toBe("");
    expect(images[2].alt).toBe("Description");
  });

  it("detects lazy loaded images with loading attribute", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <img src="/eager.png" loading="eager" alt="Eager">
          <img src="/lazy.png" loading="lazy" alt="Lazy">
          <img src="/default.png" alt="Default">
        </body>
      </html>
    `);

    const images = extractImages(doc, baseUrl);
    expect(images[0].isLazyLoaded).toBe(false);
    expect(images[1].isLazyLoaded).toBe(true);
    expect(images[2].isLazyLoaded).toBe(false);
  });

  it("detects lazy loaded images with data-src", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <img data-src="/lazy-image.png" alt="Lazy Data">
          <img src="/normal.png" alt="Normal">
        </body>
      </html>
    `);

    const images = extractImages(doc, baseUrl);
    // Image with data-src should be detected as lazy loaded
    const lazyImage = images.find((i) => i.alt === "Lazy Data");
    expect(lazyImage?.isLazyLoaded).toBe(true);
  });

  it("detects images inside figure elements", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <figure>
            <img src="/figure-img.png" alt="In Figure">
            <figcaption>Caption</figcaption>
          </figure>
          <img src="/no-figure.png" alt="No Figure">
        </body>
      </html>
    `);

    const images = extractImages(doc, baseUrl);
    expect(images[0].inFigure).toBe(true);
    expect(images[1].inFigure).toBe(false);
  });

  it("handles images in picture elements", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <picture>
            <source srcset="/large.webp" media="(min-width: 800px)">
            <img src="/fallback.png" alt="Picture Element">
          </picture>
        </body>
      </html>
    `);

    const images = extractImages(doc, baseUrl);
    // Extracts both the img and the source srcset
    expect(images.length).toBe(2);
    expect(images.some((i) => i.src.includes("fallback.png"))).toBe(true);
    expect(images.some((i) => i.src.includes("large.webp"))).toBe(true);
  });

  it("skips data URIs", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <img src="data:image/png;base64,iVBORw0KGgo=" alt="Data URI">
          <img src="/real-image.png" alt="Real">
        </body>
      </html>
    `);

    const images = extractImages(doc, baseUrl);
    expect(images.length).toBe(1);
    expect(images[0].alt).toBe("Real");
  });

  it("handles empty src", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <img src="" alt="Empty">
          <img alt="No src">
          <img src="/valid.png" alt="Valid">
        </body>
      </html>
    `);

    const images = extractImages(doc, baseUrl);
    expect(images.length).toBe(1);
    expect(images[0].alt).toBe("Valid");
  });

  it("extracts external images", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <img src="https://cdn.example.com/image.png" alt="CDN">
          <img src="https://other.com/photo.jpg" alt="External">
        </body>
      </html>
    `);

    const images = extractImages(doc, baseUrl);
    expect(images.length).toBe(2);
    expect(images[0].src).toBe("https://cdn.example.com/image.png");
    expect(images[1].src).toBe("https://other.com/photo.jpg");
  });

  it("handles srcset attribute", () => {
    const doc = parseDoc(`
      <html>
        <body>
          <img
            src="/small.jpg"
            srcset="/medium.jpg 800w, /large.jpg 1200w"
            alt="Responsive"
          >
        </body>
      </html>
    `);

    const images = extractImages(doc, baseUrl);
    expect(images.length).toBe(1);
    expect(images[0].src).toBe("https://example.com/small.jpg");
  });
});
