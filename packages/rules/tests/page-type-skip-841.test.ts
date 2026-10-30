// Rules read the page type (pub#841): a contact or legal page is short on purpose, so the
// thin-content floor, the short title and description floors, and (legal) keyword density skip
// it. Only a MODEL label at or above 0.9 counts; a rules label, a low confidence or no
// classification keeps today's verdict.
//
// The fixtures mirror pages from real audits of four small sites (a contact page of 93 and of 250
// words, privacy and terms pages of 140 to 218 words with titles such as "Privacy"), run with the
// shipped classifier: each was reported as thin or too short by these rules.

import { describe, expect, test } from "bun:test";

import type { CheckResult, PageClassification } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { loadAllRules } from "../src/loader";
import { RuleRunner, type RulesConfig } from "../src/runner";
import { resolutionCheckKey, resolutionUrlHash } from "@squirrelscan/core-contracts/resolution";
import { normalizeUrl } from "@squirrelscan/utils/url";

import { buildResolutionSignal } from "../src/resolution";
import { PAGE_TYPE_TRUST_CONFIDENCE, bodyCorroboratesPageType, trustedPageType } from "../src/shared/page-type";
import type { PageData, ParsedPage } from "../src/types";

const RULES = ["content/word-count", "core/meta-title", "core/meta-description", "content/keyword-stuffing", "core/h1"];

function cls(label: string, confidence: number, source: "model" | "rules" = "model"): PageClassification {
  return { pageType: { label, confidence, source }, degraded: "" };
}

const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

function page(opts: { title: string; description: string; body: string; classification?: PageClassification }): PageData {
  const url = "https://example.com/page";
  const html = `<!doctype html><html lang="en"><head><title>${opts.title}</title><meta name="description" content="${opts.description}"></head><body><h1>${opts.title}</h1><p>${opts.body}</p></body></html>`;
  const parsed = parsePage(html, url) as ParsedPage;
  return {
    url,
    html,
    statusCode: 200,
    loadTime: 0,
    headers: {},
    parsed: opts.classification ? { ...parsed, classification: opts.classification } : parsed,
  };
}

async function run(data: PageData): Promise<(id: string) => CheckResult[]> {
  const config: RulesConfig = { rule_options: {}, rules: { enable: RULES } };
  const { ruleResults } = await new RuleRunner({ config }).runPageRules(data, {
    baseUrl: "https://example.com",
    pages: [],
    robotsTxt: null,
    sitemaps: null,
  });
  return (id) => ruleResults.get(id)?.checks ?? [];
}

// A 93-word contact page: short title, short description.
const CONTACT = { title: "Contact", description: "Get in touch.", body: `${words(80)} Email us at hello@example.com` };
// A 218-word privacy page.
const POLICY = "This privacy policy explains the personal data we collect and how cookies are used by third parties. Last updated today.";
const LEGAL = { title: "Privacy", description: "Privacy policy.", body: `${POLICY} ${words(200)}` };

const statuses = (checks: CheckResult[]): string[] => checks.map((c) => c.status);

describe("before: no trusted label keeps today's findings", () => {
  for (const [name, classification] of [
    ["no classification", undefined],
    ["a rules label", cls("contact", 1, "rules")],
    ["a model label below 0.9", cls("contact", 0.89)],
    ["a NaN confidence", cls("contact", Number.NaN)],
  ] as const) {
    test(`${name}: thin, short title and short description are still reported`, async () => {
      const get = await run(page({ ...CONTACT, classification }));
      expect(get("content/word-count")[0]?.status).toBe("warn");
      expect(get("core/meta-title")[0]?.message).toBe("Title too short");
      expect(get("core/meta-description")[0]?.message).toBe("Description too short");
    });
  }
});

describe("after: a trusted contact or legal label skips them, and counts the skip", () => {
  test("contact (model 0.9): word-count is skipped rule-wide, the title and description floors per check", async () => {
    const get = await run(page({ ...CONTACT, classification: cls("contact", 0.9) }));
    const wc = get("content/word-count")[0]!;
    expect(wc.status).toBe("skipped");
    expect(wc.skipReason).toBe("page-type");
    expect(wc.details).toMatchObject({ pageType: "contact", skippedByType: 1, foldKey: "page-type" });
    // The in-rule skips carry the check's REAL name: the resolution signal keys on ruleId|checkName.
    for (const [id, name] of [
      ["core/meta-title", "meta-title"],
      ["core/meta-description", "meta-description"],
    ] as const) {
      const check = get(id).find((c) => c.name === name)!;
      expect(check.status).toBe("skipped");
      expect(check.skipReason).toBe("not-applicable");
      expect(check.details).toMatchObject({ pageType: "contact", skippedByType: 1, foldKey: "not-applicable" });
    }
  });

  test("legal: also skips keyword density; contact does not", async () => {
    const repeated = `${POLICY} ${Array.from({ length: 60 }, () => "data information service").join(" ")}`;
    const legal = await run(page({ title: "Privacy", description: "Privacy.", body: repeated, classification: cls("legal", 0.99) }));
    expect(legal("content/keyword-stuffing")[0]?.status).toBe("skipped");
    const contact = await run(page({ title: "Contact", description: "Contact.", body: repeated, classification: cls("contact", 0.99) }));
    expect(contact("content/keyword-stuffing")[0]?.status).not.toBe("skipped");
  });

  test("a title or description that is too LONG still applies on a contact page", async () => {
    const long = "x".repeat(200);
    const get = await run(page({ title: long, description: long, body: CONTACT.body, classification: cls("contact", 0.99) }));
    expect(get("core/meta-title")[0]?.message).toBe("Title too long");
    expect(get("core/meta-description")[0]?.message).toBe("Description too long");
  });

  test("a missing title or description is still reported on a legal page", async () => {
    const data = page({ ...LEGAL, classification: cls("legal", 0.99) });
    const bare = { ...data, html: "<html><body><p>x</p></body></html>" };
    const parsed = { ...(parsePage(bare.html, bare.url) as ParsedPage), classification: cls("legal", 0.99) };
    const get = await run({ ...bare, parsed });
    expect(get("core/meta-title")[0]?.status).toBe("fail");
    expect(get("core/meta-description")[0]?.status).toBe("fail");
  });
});

describe("pages of other types are unchanged", () => {
  for (const label of ["article", "docs", "product_detail", "pricing", "about", "homepage", "other"]) {
    test(`${label} (model 0.99) keeps the 300-word floor and the length floors`, async () => {
      const get = await run(page({ ...CONTACT, classification: cls(label, 0.99) }));
      expect(statuses(get("content/word-count"))).toEqual(["warn"]);
      expect(get("core/meta-title")[0]?.message).toBe("Title too short");
      expect(get("core/meta-description")[0]?.message).toBe("Description too short");
    });
  }
});

describe("the skip list is explicit", () => {
  test("exactly word-count (contact, legal) and keyword-stuffing (legal) declare skipOnPageType", () => {
    const declared = [...loadAllRules().values()]
      .filter((r) => r.meta.skipOnPageType)
      .map((r) => [r.meta.id, [...r.meta.skipOnPageType!]])
      .sort();
    expect(declared).toEqual([
      ["content/keyword-stuffing", ["legal"]],
      ["content/word-count", ["contact", "legal"]],
    ]);
  });

  test("the trust bar is 0.9, the same as schema/expected-type", () => {
    expect(PAGE_TYPE_TRUST_CONFIDENCE).toBe(0.9);
    expect(trustedPageType(page({ ...CONTACT, classification: cls("contact", 0.9) }).parsed)).toBe("contact");
    expect(trustedPageType(page({ ...CONTACT, classification: cls("contact", 0.9, "rules") }).parsed)).toBeNull();
    expect(trustedPageType(undefined)).toBeNull();
  });
});

// The resolution signal over REAL runner output: an earlier audit's finding on a page that is now
// skipped by type must RESOLVE, not be carried (a carried finding would keep the contact page
// "thin" forever). Pages: a thin contact page, a thin marketing page, a fine page.
describe("resolution signal: a page-type skip resolves the earlier finding, it does not carry it", () => {
  const CONTACT_URL = "https://example.com/contact";
  const MARKETING_URL = "https://example.com/features";
  const FINE_URL = "https://example.com/guide";
  const LEGAL_URL = "https://example.com/privacy";
  const h = (url: string) => resolutionUrlHash(normalizeUrl(url));

  async function collect() {
    const make = (url: string, o: Parameters<typeof page>[0]): PageData => ({ ...page(o), url });
    const pages: Array<[string, PageData]> = [
      [CONTACT_URL, make(CONTACT_URL, { ...CONTACT, classification: cls("contact", 0.99) })],
      [MARKETING_URL, make(MARKETING_URL, { ...CONTACT, title: "Features", classification: cls("other", 0.99) })],
      [FINE_URL, make(FINE_URL, { title: "A long and useful guide to the thing you wanted to read about", description: "x".repeat(130), body: words(500), classification: cls("article", 0.99) })],
    ];
    pages.push([
      LEGAL_URL,
      make(LEGAL_URL, {
        title: "Privacy",
        description: "Privacy.",
        body: `${POLICY} ${Array.from({ length: 80 }, () => "data information service").join(" ")}`,
        classification: cls("legal", 0.99),
      }),
    ]);
    const results: Record<string, { checks: CheckResult[] }> = {};
    for (const [url, data] of pages) {
      const config: RulesConfig = { rule_options: {}, rules: { enable: RULES } };
      const { ruleResults } = await new RuleRunner({ config }).runPageRules(data, {
        baseUrl: "https://example.com",
        pages: [],
        robotsTxt: null,
        sitemaps: null,
      });
      for (const [ruleId, rr] of ruleResults) {
        for (const check of rr.checks) if (!check.pageUrl) check.pageUrl = url;
        (results[ruleId] ??= { checks: [] }).checks.push(...rr.checks);
      }
    }
    return buildResolutionSignal(results, [CONTACT_URL, MARKETING_URL, FINE_URL, LEGAL_URL])!;
  }

  test("word-count: the marketing page keeps failing, the contact page is neither failing nor not-evaluated", async () => {
    const signal = await collect();
    const key = resolutionCheckKey("content/word-count", "word-count");
    expect(signal.failing[key]).toEqual([h(MARKETING_URL)]);
    expect(signal.notEvaluated?.[key] ?? []).not.toContain(h(CONTACT_URL));
  });

  test("the title and description floors resolve on the contact page, keyword-stuffing on the legal page", async () => {
    const signal = await collect();
    for (const check of ["meta-title", "meta-description"]) {
      const key = resolutionCheckKey(`core/${check}`, check);
      expect(signal.notEvaluated?.[key] ?? []).not.toContain(h(CONTACT_URL));
    }
    const stuffing = resolutionCheckKey("content/keyword-stuffing", "keyword-stuffing");
    expect(signal.notEvaluated?.[stuffing] ?? []).not.toContain(h(LEGAL_URL));
    expect(signal.failing[stuffing] ?? []).not.toContain(h(LEGAL_URL));
    // The marketing page's short title is still a finding.
    expect(signal.failing[resolutionCheckKey("core/meta-title", "meta-title")]).toContain(h(MARKETING_URL));
  });
});

// The label is a URL-and-title reading, so the page body has to bear it out (pub#841 review).
describe("the body must corroborate a contact or legal label", () => {
  const law = `${"Our attorneys advise on contracts and disputes. ".repeat(6)}`;
  const run1 = async (body: string, label: string, html?: string) => {
    const data = page({ title: "X", description: "Y", body, classification: cls(label, 0.99) });
    const real = html ? { ...data, html, parsed: { ...(parsePage(html, data.url) as ParsedPage), classification: cls(label, 0.99) } } : data;
    return (await run(real))("content/word-count")[0]!;
  };

  test("a law-firm landing page at /solutions/legal (no policy text) keeps its thin-content finding", async () => {
    expect((await run1(law, "legal")).status).toBe("warn");
  });

  test("a marketing page at /contact with no way to reach anyone keeps its finding", async () => {
    expect((await run1(`${words(70)} Book a demo and see the product tour today.`, "contact")).status).toBe("warn");
  });

  test("a client-rendered shell at /privacy with no text is not exempt: word-count reports it", async () => {
    const shell = `<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>`;
    const check = await run1("", "legal", shell);
    expect(check.status).toBe("warn");
    expect(check.message).toContain("0 words");
  });

  test("a newsletter field or a site search is not a way to contact the organisation", async () => {
    const html = `<!doctype html><html><head><title>Contact</title></head><body><form><input type="email" name="email"><button>Subscribe</button></form><p>${words(60)}</p></body></html>`;
    expect((await run1("", "contact", html)).status).toBe("warn");
  });

  test("a message box, a mailto or tel link, an email address or a phone number does corroborate", async () => {
    const form = `<!doctype html><html><head><title>Contact</title></head><body><form><textarea name="message"></textarea></form><p>${words(60)}</p></body></html>`;
    const mail = `<!doctype html><html><head><title>Contact</title></head><body><p>${words(60)}</p><a href="mailto:hi@example.com">Write to us</a></body></html>`;
    const tel = `<!doctype html><html><head><title>Contact</title></head><body><p>${words(60)}</p><a href="tel:+31201234567">Call us</a></body></html>`;
    const phone = `<!doctype html><html><head><title>Contact</title></head><body><p>${words(60)} Call +31 20 123 4567 any weekday.</p></body></html>`;
    for (const html of [form, mail, tel, phone]) {
      expect((await run1("", "contact", html)).status).toBe("skipped");
    }
  });

  test("policy text in another language corroborates (German, French, Spanish)", async () => {
    for (const body of [
      "Datenschutzerklärung: wir verarbeiten personenbezogene Daten nach den Nutzungsbedingungen. Haftung ausgeschlossen.",
      "Politique de confidentialité: vos données personnelles sont traitées selon les conditions générales. Mentions légales.",
      "Política de privacidad: tratamos sus datos personales según el aviso legal y la responsabilidad del titular.",
    ]) {
      expect((await run1(body, "legal")).status).toBe("skipped");
    }
  });

  test("a year range or a price is not a phone number", async () => {
    expect((await run1(`${words(70)} Open 2019-2024 at price 1999.99`, "contact")).status).toBe("warn");
  });

  test("hostile text costs a fixed amount: many @ signs or long separator runs", () => {
    const text = `${"a@".repeat(50_000)} ${"1 ".repeat(50_000)}`;
    const parsed = { content: { textContent: text, wordCount: 100_000 }, contactLinks: [] } as unknown as ParsedPage;
    const started = performance.now();
    expect(bodyCorroboratesPageType(parsed, "contact")).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
