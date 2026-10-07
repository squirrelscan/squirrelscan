// content/placeholder-media: images that were never replaced with real content.
//
// The no-false-positive fixture carries more weight than the detection cases: a
// tracking pixel, a lazy-loaded hero and descriptive alt text must all stay clean.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { dataUriDimensions, isPlaceholderSource, placeholderMediaRule } from "../src/content/placeholder-media";
import { imageRedundantAltRule } from "../src/a11y/image-redundant-alt";
import type { ParsedPage, Rule, RuleContext } from "../src/types";

const GIF_1X1 = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function runRule(rule: Rule, body: string) {
  const html = `<html><head><title>t</title></head><body>${body}</body></html>`;
  const { document } = parseHTML(html);
  const ctx: RuleContext = {
    page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document } as unknown as ParsedPage,
    options: {},
  };
  return rule.run(ctx).checks;
}

const run = (body: string) => runRule(placeholderMediaRule, body);

describe("isPlaceholderSource", () => {
  test.each([
    "https://via.placeholder.com/600x400",
    "http://placehold.it/300",
    "https://dummyimage.com/600x400/000/fff",
    "http://lorempixel.com/400/200/",
    "https://source.unsplash.com/random/800x600",
    "https://source.unsplash.com/featured/?nature",
    "/assets/placeholder.png",
    "/img/Placeholder-hero.jpg?v=2",
  ])("flags %s", (url) => expect(isPlaceholderSource(url)).toBe(true));

  test.each([
    "/img/team.jpg",
    "https://images.unsplash.com/photo-123?w=800",
    "https://source.unsplash.com/abc123/800x600",
    "data:image/gif;base64,AAAA",
    "",
  ])("does not flag %p", (url) => expect(isPlaceholderSource(url)).toBe(false));
});

describe("dataUriDimensions", () => {
  test("reads GIF and PNG headers", () => {
    expect(dataUriDimensions(GIF_1X1)).toEqual({ width: 1, height: 1 });
    expect(dataUriDimensions(PNG_1X1)).toEqual({ width: 1, height: 1 });
  });
  test("returns null for anything else", () => {
    expect(dataUriDimensions("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(dataUriDimensions("https://example.com/a.gif")).toBeNull();
  });
});

describe("placeholder-media outcomes", () => {
  test("skipped when the page has no images", () => {
    const [c] = run("<p>hi</p>");
    expect(c!.status).toBe("skipped");
  });

  test("pass when images are real", () => {
    const [c] = run('<img src="/a.jpg" alt="Red running shoes on a track">');
    expect(c!.status).toBe("pass");
  });

  test("fail on a placeholder source", () => {
    const [c] = run('<img src="https://via.placeholder.com/600x400" alt="Team photo at the offsite">');
    expect(c!.status).toBe("fail");
    expect(c!.items?.[0]?.label).toBe("placeholder image");
  });

  test("fail on a placeholder in the filename", () => {
    expect(run('<img src="/img/placeholder.png" alt="Our office">')[0]!.status).toBe("fail");
  });

  test("a placeholder data-src is flagged even when src is a real-looking stub", () => {
    const [c] = run(`<img src="${GIF_1X1}" data-src="https://dummyimage.com/800x600" alt="Hero banner for spring">`);
    expect(c!.status).toBe("fail");
  });

  test("fail on a 1x1 base64 GIF or PNG used as content", () => {
    expect(run(`<img src="${GIF_1X1}" alt="Product shot of the blue kettle">`)[0]!.status).toBe("fail");
    expect(run(`<img src="${PNG_1X1}" alt="Product shot of the blue kettle">`)[0]!.status).toBe("fail");
  });

  test("warn on a camera-default alt alone", () => {
    for (const alt of ["DSC_0001", "IMG_1234", "dscn0042.jpg"]) {
      const [c] = run(`<img src="/uploads/team-lunch.jpg" alt="${alt}">`);
      expect(c!.status).toBe("warn");
    }
  });

  test("source findings outrank an alt finding", () => {
    const [c] = run('<img src="/x/placeholder.jpg" alt="IMG_1234">');
    expect(c!.status).toBe("fail");
    expect(c!.items).toHaveLength(2);
  });

  test("caps items and records the remainder", () => {
    const body = Array.from({ length: 14 }, (_, i) => `<img src="/p${i}/placeholder.png" alt="Real description ${i}">`).join("");
    const [c] = run(body);
    expect(c!.items).toHaveLength(10);
    expect(c!.details?.additional).toBe(4);
  });
});

describe("placeholder-media src vs srcset and legitimate paths", () => {
  test("a placeholder src beside a real srcset is not flagged", () => {
    const [c] = run('<img src="/img/placeholder.png" srcset="/img/hero-1x.jpg 1x, /img/hero-2x.jpg 2x" alt="Hero shot of the lobby">');
    expect(c!.status).toBe("pass");
  });

  test("a placeholder src beside a real <picture> source is not flagged", () => {
    const [c] = run('<picture><source srcset="/img/hero.webp" type="image/webp"><img src="/img/placeholder.png" alt="Hero shot of the lobby"></picture>');
    expect(c!.status).toBe("pass");
  });

  test("a placeholder srcset is flagged even when src looks real", () => {
    const [c] = run('<img src="/img/hero.jpg" srcset="/img/placeholder.png 1x" alt="Hero shot of the lobby">');
    expect(c!.status).toBe("fail");
  });

  test.each([
    "/blog/placeholder-text-guide/hero.jpg",
    "/placeholder-images/real-photo.jpg",
    "/img/placeholders-we-love.jpg",
  ])("does not flag %s", (url) => expect(isPlaceholderSource(url)).toBe(false));

  test("still flags placeholder as a filename word", () => {
    expect(isPlaceholderSource("/img/hero-placeholder_2x.jpg")).toBe(true);
  });
});

describe("placeholder-media other lazy-loaders and edge sources", () => {
  test("a 1x1 stub with the real URL in an unrecognised data-* attribute is not flagged", () => {
    const [c] = run(`<img src="${GIF_1X1}" data-echo="/img/team.jpg" alt="The team at work">`);
    expect(c!.status).toBe("pass");
  });

  test("protocol-relative placeholder host is flagged", () => {
    expect(isPlaceholderSource("//via.placeholder.com/600x400")).toBe(true);
  });

  test("a <picture> where every source is a placeholder is flagged", () => {
    const [c] = run('<picture><source srcset="/img/placeholder.webp"><img src="/img/placeholder.png" alt="Hero shot"></picture>');
    expect(c!.status).toBe("fail");
  });

  test("a malformed data URI has no dimensions", () => {
    expect(dataUriDimensions("data:image/gif;base64,@@@")).toBeNull();
  });
});

describe("placeholder-media no false positives", () => {
  test("a tracking pixel, a lazy-loaded hero and descriptive alt text stay clean", () => {
    const [c] = run(`
      <img src="https://analytics.example.com/pixel.gif" width="1" height="1" alt="">
      <img src="${GIF_1X1}" width="1" height="1" alt="" aria-hidden="true">
      <img src="${GIF_1X1}" data-src="/img/hero.jpg" alt="A squirrel carrying an acorn across a wire">
      <img src="/img/placeholder.gif" data-src="/img/gallery-1.jpg" alt="Gallery view of the workshop">
      <img src="${GIF_1X1}" srcset="/img/a-480.jpg 480w, /img/a-960.jpg 960w" alt="Mountain lake at dawn">
      <img src="/img/kettle.jpg" alt="Blue enamel kettle on a gas hob">
      <noscript><img src="/img/placeholder.png" alt="IMG_1234"></noscript>
    `);
    expect(c!.status).toBe("pass");
  });

  test("an alt that merely contains a camera-like fragment is not flagged", () => {
    expect(run('<img src="/a.jpg" alt="Photo of IMG_1234 sculpture in the gallery">')[0]!.status).toBe("pass");
  });
});

describe("overlap with a11y/image-redundant-alt", () => {
  test("plain junk alt and filename alt are left to the a11y rule, not double-reported", () => {
    const body =
      '<img src="/a/team.jpg" alt="image"><img src="/a/photo.jpg" alt="photo"><img src="/a/DSC_0001.jpg" alt="DSC_0001">';
    expect(run(body)[0]!.status).toBe("pass");
    expect(runRule(imageRedundantAltRule, body)[0]!.status).toBe("warn");
  });

  test("a camera-default alt on a differently named file is reported only here", () => {
    const body = '<img src="/a/team-lunch.jpg" alt="IMG_1234">';
    expect(run(body)[0]!.status).toBe("warn");
    expect(runRule(imageRedundantAltRule, body)[0]!.status).toBe("pass");
  });
});
