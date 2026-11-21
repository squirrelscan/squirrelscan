// local/nap-consistency: an Event organiser's or a Person's phone is not the
// page's business phone (#1877).

import { parsePage } from "@squirrelscan/parser";
import { extractNapSignal, napPhoneKey } from "@squirrelscan/utils";
import { describe, expect, test } from "bun:test";

import type { ParsedPage, RuleContext } from "../src/types";

import { napConsistencyRule } from "../src/local/nap-consistency";

const ORIGIN = "http://localhost:8766";
const BIZ = "+1 555 0199";
const ORG = "+1 555 0100";
const BIZ_KEY = napPhoneKey(BIZ)!;

const ld = (obj: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const business = ld({ "@type": "LocalBusiness", name: "Acme", telephone: BIZ });
const event = ld({
  "@type": "Event",
  name: "Example event",
  organizer: { "@type": "Person", name: "A. Organiser", telephone: ORG },
});
const orgLink =
  '<p>Call the organiser: <a href="tel:+15550100">555 0100</a></p>';
const bizLink = '<a href="tel:+15550199">555 0199</a>';

const page = (head: string, body = "") =>
  `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
const sig = (html: string) =>
  extractNapSignal(parsePage(html, `${ORIGIN}/`) as ParsedPage);

function phoneCheck(pages: string[]) {
  const ctx: RuleContext = {
    page: {
      url: `${ORIGIN}/`,
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: {} as ParsedPage,
    options: {},
    site: {
      baseUrl: `${ORIGIN}/`,
      pages: pages.map((html, i) => ({
        url: `${ORIGIN}/p${i}`,
        statusCode: 200,
        parsed: parsePage(html, `${ORIGIN}/p${i}`) as ParsedPage,
      })),
      robotsTxt: null,
      sitemaps: null,
    },
  };
  const result = napConsistencyRule.run(ctx);
  if (result instanceof Promise) throw new Error("sync expected");
  return result.checks.find((c) => c.name === "phone-consistency");
}

describe("extractNapSignal ignores non-business phones (#1877)", () => {
  test("Event organiser phone, in JSON-LD and as a tel: link, yields no phone", () => {
    expect(sig(page(event, orgLink)).phones).toEqual([]);
  });

  test("a Person node's telephone is not the NAP phone", () => {
    const person = ld({ "@type": "Person", name: "P", telephone: ORG });
    expect(sig(page(person)).phones).toEqual([]);
  });

  test("a top-level Event telephone is ignored", () => {
    const e = ld({ "@type": "MusicEvent", name: "E", telephone: ORG });
    expect(sig(page(e)).phones).toEqual([]);
  });

  test("business phone is primary whatever the document order", () => {
    expect(sig(page(event + business, orgLink + bizLink)).phones).toEqual([
      BIZ_KEY,
    ]);
    expect(sig(page(business + event, bizLink + orgLink)).phones).toEqual([
      BIZ_KEY,
    ]);
  });

  test("business JSON-LD phone leads a different tel: link", () => {
    const s = sig(page(business, orgLink));
    expect(s.phones[0]).toBe(BIZ_KEY);
  });
});

describe("local/nap-consistency with an event page (#1877)", () => {
  test("one event page with an organiser phone does not cause drift", () => {
    const biz = page(business, bizLink);
    const check = phoneCheck([
      ...Array(11).fill(biz),
      page(event + business, orgLink + bizLink),
    ]);
    expect(check?.status).toBe("pass");
  });

  test("a page whose only phone is the organiser's is not deviant", () => {
    const biz = page(business, bizLink);
    const check = phoneCheck([...Array(12).fill(biz), page(event, orgLink)]);
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("12 pages");
  });
});
