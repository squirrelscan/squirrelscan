// parsePage().contactLinks — tel:/mailto: anchors (#1373).
//
// `extractLinks` drops every non-crawlable scheme, so before this field existed a
// site rule had no way to see a page's declared contact details: by the time a
// site rule runs, only the ParsedPage survives and the DOM is gone. These lock in
// that the anchors are captured, that `links` still excludes them, and that the
// href payload is separated from its routing params.

import { describe, expect, test } from "bun:test";

import { extractCrawlableUrls, extractLinks } from "../src/extractors/links";
import { parsePage } from "../src/html";
import { parseDocument } from "../src/index";

const URL = "https://example.com/contact";

function page(body: string): string {
  return `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;
}

describe("parsePage — contactLinks", () => {
  test("tel: and mailto: anchors are captured with scheme, payload and text", () => {
    const parsed = parsePage(
      page(
        `<a href="tel:+1 (555) 123-4567">+1 (555) 123-4567</a>` +
          `<a href="mailto:hi@example.com">Email us</a>`,
      ),
      URL,
    );

    expect(parsed.contactLinks).toEqual([
      { scheme: "tel", value: "+1 (555) 123-4567", text: "+1 (555) 123-4567" },
      { scheme: "mailto", value: "hi@example.com", text: "Email us" },
    ]);
  });

  test("they stay OUT of the crawlable link graph", () => {
    const parsed = parsePage(
      page(`<a href="tel:5551234567">call</a><a href="/about">about</a>`),
      URL,
    );

    expect(parsed.links.map((l) => l.url)).toEqual(["https://example.com/about"]);
    expect(parsed.contactLinks).toHaveLength(1);
  });

  test("routing params are stripped from the payload but the text is untouched", () => {
    const parsed = parsePage(
      page(
        `<a href="mailto:hi@example.com?subject=Hello&body=Hi">Contact</a>` +
          `<a href="tel:+15551234567;phone-context=+1">Call</a>`,
      ),
      URL,
    );

    expect(parsed.contactLinks?.map((c) => c.value)).toEqual([
      "hi@example.com",
      "+15551234567",
    ]);
  });

  test("scheme matching is case-insensitive", () => {
    const parsed = parsePage(page(`<a href="TEL:5551234567">call</a>`), URL);
    expect(parsed.contactLinks).toEqual([
      { scheme: "tel", value: "5551234567", text: "call" },
    ]);
  });

  test("other schemes are not contact links", () => {
    const parsed = parsePage(
      page(`<a href="sms:5551234567">text</a><a href="javascript:void(0)">x</a>`),
      URL,
    );
    expect(parsed.contactLinks).toEqual([]);
  });

  test("the carried list is capped", () => {
    const anchors = Array.from(
      { length: 50 },
      (_, i) => `<a href="tel:555000${i}">n${i}</a>`,
    ).join("");
    const parsed = parsePage(page(anchors), URL);
    expect(parsed.contactLinks).toHaveLength(32);
  });
});

// pub#811: Cloudflare's email obfuscation rewrites a `mailto:` link to
// `/cdn-cgi/l/email-protection#<hex>` (and an address in the text to an anchor
// carrying `data-cfemail`). Not a page: it is a contact affordance like the
// `mailto:` it replaced, so it is carried here and kept out of the link graph.
describe("parsePage — Cloudflare email-protection links (pub#811)", () => {
  /** Cloudflare's encoding: a key byte, then each UTF-8 byte XOR the key, all hex. */
  const encode = (text: string, key = 0x5a): string =>
    [key, ...new TextEncoder().encode(text).map((b) => b ^ key)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  test("an obfuscated mailto link is a contact link with the decoded address", () => {
    const parsed = parsePage(
      page(
        `<a href="/cdn-cgi/l/email-protection#${encode("hi@example.com?subject=Hello")}">[email&#160;protected]</a>` +
          `<a href="/about">about</a>`,
      ),
      URL,
    );
    expect(parsed.contactLinks).toEqual([
      { scheme: "mailto", value: "hi@example.com", text: "[email\u00a0protected]", obfuscated: "cloudflare" },
    ]);
    expect(parsed.links.map((l) => l.url)).toEqual(["https://example.com/about"]);
  });

  test("an obfuscated address in the text reads its data-cfemail, on the anchor or inside it", () => {
    const parsed = parsePage(
      page(
        `<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${encode("a@example.com")}">[email&#160;protected]</a>` +
          `<a href="/cdn-cgi/l/email-protection"><span class="__cf_email__" data-cfemail="${encode("b@example.com", 0x13)}">[email&#160;protected]</span></a>`,
      ),
      URL,
    );
    expect(parsed.contactLinks?.map((c) => [c.scheme, c.value, c.obfuscated])).toEqual([
      ["mailto", "a@example.com", "cloudflare"],
      ["mailto", "b@example.com", "cloudflare"],
    ]);
    expect(parsed.links).toEqual([]);
  });

  test("a payload that does not decode to an address is still a contact link, with no value", () => {
    const parsed = parsePage(
      page(`<a href="/cdn-cgi/l/email-protection#abcd">[email&#160;protected]</a>`),
      URL,
    );
    expect(parsed.contactLinks).toEqual([
      { scheme: "mailto", value: "", text: "[email\u00a0protected]", obfuscated: "cloudflare" },
    ]);
    expect(parsed.links).toEqual([]);
  });

  test("one on another host is not an external link either", () => {
    const html = page(
      `<a href="https://other.example/cdn-cgi/l/email-protection#${encode("x@other.example")}">mail</a>` +
        `<a href="https://other.example/page">page</a>`,
    );
    const parsed = parsePage(html, URL);
    expect(parsed.links.map((l) => l.url)).toEqual(["https://other.example/page"]);
    expect(parsed.contactLinks?.map((c) => c.value)).toEqual(["x@other.example"]);
    const doc = parseDocument(html);
    expect(extractLinks(doc, URL).map((l) => l.href)).toEqual(["https://other.example/page"]);
  });

  test("the crawl never queues one", () => {
    const doc = parseDocument(
      page(`<a href="/cdn-cgi/l/email-protection#abcd">mail</a><a href="/about">about</a>`),
    );
    expect(extractCrawlableUrls(doc, URL)).toEqual(["https://example.com/about"]);
    expect(extractLinks(doc, URL).map((l) => l.href)).toEqual(["https://example.com/about"]);
  });

  test("obfuscated addresses have a cap of their own, so they never push out tel: links", () => {
    const obfuscated = Array.from(
      { length: 40 },
      (_, i) => `<a href="/cdn-cgi/l/email-protection#${encode(`a${i}@example.com`)}">mail</a>`,
    ).join("");
    const parsed = parsePage(page(`${obfuscated}<a href="tel:+15551234567">call</a>`), URL);
    expect(parsed.contactLinks?.filter((c) => c.obfuscated)).toHaveLength(32);
    expect(parsed.contactLinks?.filter((c) => !c.obfuscated)).toEqual([
      { scheme: "tel", value: "+15551234567", text: "call" },
    ]);
  });

  test("other /cdn-cgi/ links are links: an image-resizing URL is a real resource", () => {
    const parsed = parsePage(page(`<a href="/cdn-cgi/image/width=1200/a.jpg">full size</a>`), URL);
    expect(parsed.links.map((l) => l.url)).toEqual([
      "https://example.com/cdn-cgi/image/width=1200/a.jpg",
    ]);
    expect(parsed.contactLinks).toEqual([]);
  });
});

// #2307: `links/tel-mailto` says where a flagged contact link sits, so the anchor carries its
// section. An anchor outside every landmark carries none.
describe("parsePage — contactLinks sections", () => {
  test("a contact anchor records the landmark it sits in", () => {
    const parsed = parsePage(
      page(
        `<footer><a href="tel:+15551234567">call</a></footer>` +
          `<main><a href="mailto:hi@example.com">Email us</a></main>` +
          `<p><a href="mailto:loose@example.com">loose</a></p>`,
      ),
      URL,
    );

    expect(parsed.contactLinks).toEqual([
      { scheme: "tel", value: "+15551234567", text: "call", section: "footer" },
      { scheme: "mailto", value: "hi@example.com", text: "Email us", section: "content" },
      { scheme: "mailto", value: "loose@example.com", text: "loose" },
    ]);
  });
});

describe("parsePage — invalid links keep their section", () => {
  test("a link the parser cannot read still says where it sat", () => {
    const parsed = parsePage(page(`<footer><a href="http://[bad">bad</a></footer>`), URL);

    expect(parsed.links).toEqual([
      {
        url: "http://[bad",
        text: "bad",
        isInternal: false,
        error: "Invalid URL format",
        section: "footer",
      },
    ]);
  });
});
