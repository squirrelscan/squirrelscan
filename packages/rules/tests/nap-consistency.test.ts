// local/nap-consistency — cross-page NAP drift (#1373).
//
// The rule compares each page's PRIMARY declared phone/address across the crawl.
// Three outcomes matter and are easy to get backwards, so each has its own case:
//   - one number, one rendering  → pass
//   - one number, several renderings → warn (a citation problem, not a conflict)
//   - a genuinely different number on some pages → fail (a real NAP conflict)
//
// Everything else here defends the SILENCE cases: below the sample floor, or on a
// legitimately multi-location site, the rule must say nothing rather than accuse a
// heterogeneous site of being inconsistent.

import { describe, expect, test } from "bun:test";

import type { CheckResult, SiteMetadata } from "@squirrelscan/core-contracts";
import { napAddressKey, napPhoneKey } from "@squirrelscan/utils";

import { parsePage } from "@squirrelscan/parser";

import { ruleApplies } from "../src/applicability";
import {
  napConsistencyRule,
  NAP_DRIFT_MIN_PAGES,
  NAP_MODAL_MIN_AGREEMENT,
} from "../src/local/nap-consistency";
import type { ParsedPage, RuleContext } from "../src/types";

interface PageSpec {
  /** Rendered phone text; also the `tel:` href payload. */
  phone?: string;
  /** JSON-LD `streetAddress`. */
  street?: string;
  /** Emit LocalBusiness JSON-LD (name + address). */
  business?: boolean;
}

function html(spec: PageSpec): string {
  const parts: string[] = [];
  if (spec.business || spec.street) {
    const node: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: "Acorn Hardware",
    };
    if (spec.street) {
      node.address = {
        "@type": "PostalAddress",
        streetAddress: spec.street,
        addressLocality: "Sydney",
        postalCode: "2000",
      };
    }
    parts.push(`<script type="application/ld+json">${JSON.stringify(node)}</script>`);
  }
  if (spec.phone) {
    parts.push(`<a href="tel:${spec.phone}">${spec.phone}</a>`);
  }
  return `<html><head>${parts.join("")}</head><body><p>Acorn Hardware</p></body></html>`;
}

/** A site context from per-page specs, in the normalized_url order the rule assumes. */
function siteCtx(specs: PageSpec[]): RuleContext {
  const pages = specs.map((spec, i) => {
    const url = `https://example.com/p${String(i).padStart(3, "0")}`;
    return {
      url,
      statusCode: 200,
      parsed: parsePage(html(spec), url) as ParsedPage,
    };
  });
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    options: {},
    site: { baseUrl: "https://example.com/", pages, robotsTxt: null, sitemaps: null },
  };
}

function checks(ctx: RuleContext): CheckResult[] {
  const result = napConsistencyRule.run(ctx);
  if (result instanceof Promise) throw new Error("legacy path must be synchronous");
  return result.checks as CheckResult[];
}

function named(list: CheckResult[], name: string): CheckResult {
  const found = list.find((c) => c.name === name);
  if (!found) throw new Error(`no check named ${name} in [${list.map((c) => c.name).join(", ")}]`);
  return found;
}

/** `n` pages, each carrying `phone` and (optionally) `street`. */
function repeat(n: number, spec: PageSpec): PageSpec[] {
  return Array.from({ length: n }, () => ({ ...spec }));
}

const FLOOR = NAP_DRIFT_MIN_PAGES;

describe("local/nap-consistency — identity is unchanged", () => {
  test("rule id and the local-business gate are untouched", () => {
    expect(napConsistencyRule.meta.id).toBe("local/nap-consistency");
    expect(napConsistencyRule.meta.appliesWhen).toEqual({ requiresLocalBusiness: true });
    expect(napConsistencyRule.meta.scope).toBe("site");
  });

  test("guard constants are at their documented starting values", () => {
    expect(NAP_DRIFT_MIN_PAGES).toBe(10);
    expect(NAP_MODAL_MIN_AGREEMENT).toBe(0.7);
  });
});

describe("local/nap-consistency — skipped", () => {
  test("no pages → single skipped check", () => {
    const ctx = siteCtx([]);
    expect(checks(ctx)).toEqual([
      { name: "nap-consistency", status: "skipped", message: "No pages available for analysis" },
    ]);
  });

  test("appliesWhen gates the rule off a non-local site", () => {
    const meta: SiteMetadata = {
      siteType: "saas",
      businessCategory: null,
      primaryCountry: null,
      audienceScope: null,
      isYMYL: false,
      isLocalBusiness: false,
      hasOwnershipVerified: false,
      confidence: "high",
    };
    const verdict = ruleApplies(napConsistencyRule.meta.appliesWhen, meta);
    expect(verdict.applies).toBe(false);
  });

  test("below the sample floor → skipped with the count in the reason", () => {
    const ctx = siteCtx(repeat(FLOOR - 1, { phone: "+1 (555) 123-4567", business: true }));
    const phone = named(checks(ctx), "phone-consistency");
    expect(phone.status).toBe("skipped");
    expect(phone.message).toContain(`Only ${FLOOR - 1} page(s)`);
    expect(phone.message).toContain(`${FLOOR} needed`);
  });

  test("pages declaring nothing → skipped, not a false 'consistent' pass", () => {
    const ctx = siteCtx(repeat(FLOOR + 5, { business: true }));
    expect(named(checks(ctx), "phone-consistency").status).toBe("skipped");
    expect(named(checks(ctx), "address-consistency").status).toBe("skipped");
  });

  test("no modal norm (below the agreement floor) → skipped, not a fail", () => {
    // 5/12 = 42% for the largest group: a multi-location site, not a broken one.
    const ctx = siteCtx([
      ...repeat(5, { phone: "555-100-0001", business: true }),
      ...repeat(4, { phone: "555-100-0002", business: true }),
      ...repeat(3, { phone: "555-100-0003", business: true }),
    ]);
    const phone = named(checks(ctx), "phone-consistency");
    expect(phone.status).toBe("skipped");
    expect(phone.message).toContain("No dominant phone number");
    expect(phone.message).toContain("42%");
  });
});

describe("local/nap-consistency — pass (no false positives)", () => {
  test("one number and one address, identically rendered everywhere → pass", () => {
    const ctx = siteCtx(repeat(FLOOR + 2, { phone: "+1 (555) 123-4567", street: "123 Main St" }));
    const list = checks(ctx);

    const phone = named(list, "phone-consistency");
    expect(phone.status).toBe("pass");
    expect(phone.value).toBe("+1 (555) 123-4567");
    expect(phone.items).toBeUndefined();

    const address = named(list, "address-consistency");
    expect(address.status).toBe("pass");

    // Nothing in the rule's output is a warn/fail on a consistent site.
    expect(list.some((c) => c.status === "warn" || c.status === "fail")).toBe(false);
  });

  test("a page carrying extra branch numbers does not make the site inconsistent", () => {
    // Every page's PRIMARY (first) number is the same; a footer branch list follows.
    const pages = repeat(FLOOR + 2, { phone: "555-123-4567", business: true });
    const ctx = siteCtx(pages);
    const withExtra = ctx.site!.pages.map((p, i) =>
      i % 2 === 0
        ? p
        : {
            ...p,
            parsed: parsePage(
              `<html><body><a href="tel:555-123-4567">555-123-4567</a>` +
                `<a href="tel:555-999-0000">555-999-0000</a></body></html>`,
              p.url,
            ) as ParsedPage,
          },
    );
    ctx.site!.pages = withExtra;
    expect(named(checks(ctx), "phone-consistency").status).toBe("pass");
  });
});

describe("local/nap-consistency — warn (format drift)", () => {
  test("one number rendered two ways → warn listing both renderings", () => {
    const ctx = siteCtx([
      ...repeat(8, { phone: "+1 (555) 123-4567", business: true }),
      ...repeat(4, { phone: "555.123.4567", business: true }),
    ]);
    const phone = named(checks(ctx), "phone-consistency");

    expect(phone.status).toBe("warn");
    expect(phone.message).toBe(
      "The same phone number is formatted 2 different ways across 12 pages",
    );
    expect(phone.value).toBe("+1 (555) 123-4567");
    expect(phone.items?.map((i) => i.id)).toEqual(["+1 (555) 123-4567", "555.123.4567"]);
    expect(phone.items?.map((i) => i.meta?.pageCount)).toEqual([8, 4]);
    expect(phone.details).toEqual({
      norm: "+1 (555) 123-4567",
      formats: 2,
      samplePages: 12,
    });
  });

  test("'123 Main St' vs '123 Main Street' is drift, not a different address", () => {
    const ctx = siteCtx([
      ...repeat(8, { street: "123 Main St" }),
      ...repeat(4, { street: "123 Main Street" }),
    ]);
    const address = named(checks(ctx), "address-consistency");
    expect(address.status).toBe("warn");
    expect(address.message).toContain("formatted 2 different ways");
  });
});

describe("local/nap-consistency — fail (conflicting NAP)", () => {
  test("a genuinely different number on a minority of pages → fail", () => {
    const ctx = siteCtx([
      ...repeat(10, { phone: "555-123-4567", business: true }),
      ...repeat(2, { phone: "555-987-6543", business: true }),
    ]);
    const phone = named(checks(ctx), "phone-consistency");

    expect(phone.status).toBe("fail");
    expect(phone.message).toBe(
      '2 page(s) show a different phone number to the site norm "555-123-4567"',
    );
    expect(phone.items).toHaveLength(1);
    expect(phone.items?.[0]?.label).toBe('"555-987-6543" on 2 page(s)');
    expect(phone.items?.[0]?.sourcePages).toHaveLength(2);
    expect(phone.details).toEqual({
      norm: "555-123-4567",
      normPages: 10,
      deviantValues: 1,
      deviantPages: 2,
      samplePages: 12,
    });
  });

  test("a conflicting address outranks its own format drift", () => {
    const ctx = siteCtx([
      ...repeat(10, { street: "123 Main St" }),
      ...repeat(2, { street: "77 Other Rd" }),
    ]);
    const address = named(checks(ctx), "address-consistency");
    expect(address.status).toBe("fail");
    expect(address.details?.deviantPages).toBe(2);
  });
});

describe("local/nap-consistency — presence checks are preserved", () => {
  test("LocalBusiness schema present → local-business-schema passes with the name", () => {
    const list = checks(siteCtx(repeat(3, { business: true })));
    expect(named(list, "local-business-schema")).toEqual({
      name: "local-business-schema",
      status: "pass",
      message: "LocalBusiness/Organization schema found",
      value: "Acorn Hardware",
    });
  });

  test("no business schema → informational, never a failure", () => {
    const list = checks(siteCtx(repeat(3, { phone: "555-123-4567" })));
    expect(named(list, "local-business-schema").status).toBe("info");
  });

  test("a /contact page with contact links → contact-info passes", () => {
    const ctx = siteCtx(repeat(2, { phone: "555-123-4567" }));
    ctx.site!.pages[1]!.url = "https://example.com/contact";
    ctx.site!.pages[1]!.parsed = parsePage(
      `<html><body><a href="tel:555-123-4567">call</a><a href="mailto:hi@example.com">mail</a></body></html>`,
      "https://example.com/contact",
    ) as ParsedPage;
    expect(named(checks(ctx), "contact-info").status).toBe("pass");
  });
});

describe("NAP comparison keys", () => {
  test("punctuation and country-code variants key to the same phone", () => {
    const key = napPhoneKey("+1 (555) 123-4567");
    expect(key).toBe("1234567");
    expect(napPhoneKey("555.123.4567")).toBe(key);
    expect(napPhoneKey("5551234567")).toBe(key);
  });

  test("too few digits is not a phone number", () => {
    expect(napPhoneKey("ext. 4567")).toBeNull();
    expect(napPhoneKey("no digits here")).toBeNull();
  });

  test("street-type abbreviations fold into their long form", () => {
    expect(napAddressKey("123 Main St.")).toBe(napAddressKey("123 Main Street"));
    expect(napAddressKey("5 N. Oak Ave")).toBe("5 north oak avenue");
  });

  test("prototype-chain tokens stay literal (no inherited lookup)", () => {
    // A `TABLE[token]` lookup on a plain object would fold in `Object`'s source.
    expect(napAddressKey("1 constructor st")).toBe("1 constructor street");
    expect(napAddressKey("7 prototype rd")).toBe("7 prototype road");
  });

  test("keyless input is null, not an empty string", () => {
    expect(napAddressKey("   ...   ")).toBeNull();
  });
});
