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
import { PAGE_TYPE_TRUST_CONFIDENCE, trustedPageType } from "../src/shared/page-type";
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
const CONTACT = { title: "Contact", description: "Get in touch.", body: words(90) };
// A 218-word privacy page.
const LEGAL = { title: "Privacy", description: "Privacy policy.", body: words(215) };

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
  test("contact (model 0.9): word-count, title floor and description floor are skipped by type", async () => {
    const get = await run(page({ ...CONTACT, classification: cls("contact", 0.9) }));
    for (const [id, name] of [
      ["content/word-count", "content/word-count"],
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
    const repeated = Array.from({ length: 60 }, () => "data information service").join(" ");
    const legal = await run(page({ title: "Privacy", description: "Privacy.", body: repeated, classification: cls("legal", 0.99) }));
    expect(legal("content/keyword-stuffing")[0]?.status).toBe("skipped");
    const contact = await run(page({ title: "Contact", description: "Contact.", body: repeated, classification: cls("contact", 0.99) }));
    expect(contact("content/keyword-stuffing")[0]?.status).not.toBe("skipped");
  });

  test("a title or description that is too LONG still applies on a contact page", async () => {
    const long = "x".repeat(200);
    const get = await run(page({ title: long, description: long, body: words(90), classification: cls("contact", 0.99) }));
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
