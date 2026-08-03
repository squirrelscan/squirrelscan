// parsePage().contactLinks — tel:/mailto: anchors (#1373).
//
// `extractLinks` drops every non-crawlable scheme, so before this field existed a
// site rule had no way to see a page's declared contact details: by the time a
// site rule runs, only the ParsedPage survives and the DOM is gone. These lock in
// that the anchors are captured, that `links` still excludes them, and that the
// href payload is separated from its routing params.

import { describe, expect, test } from "bun:test";

import { parsePage } from "../src/html";

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
