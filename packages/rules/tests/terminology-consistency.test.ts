// content/terminology-consistency: minority spellings against the site's dominant one.
// Pages are real parsed HTML, so the legacy path derives the counts with the same function the
// streaming engine stores; the streaming ctx is fed those stored maps.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import type { CheckResult, PageFeatureRow, SiteQuery } from "@squirrelscan/core-contracts";

import {
  pageTerminologyVariants,
  terminologyConsistencyRule,
  TERM_KEY_COUNT,
  TERM_MIN_PAGES,
} from "../src/content/terminology-consistency";
import type { RuleContext } from "../src/types";

interface Spec {
  path: string;
  html: string;
  status?: number;
  noindex?: boolean;
}

function page(body: string, head = ""): string {
  return `<!DOCTYPE html><html><head><title>t</title>${head}</head><body><main>${body}</main></body></html>`;
}

/** A page that says "Sign in" twice. */
const signIn = (i: number): Spec => ({
  path: `/p${String(i).padStart(3, "0")}`,
  html: page('<a href="/a">Sign in</a><p>Please sign in to continue.</p>'),
});

const spec = (i: number, body: string, head = ""): Spec => ({
  path: `/p${String(i).padStart(3, "0")}`,
  html: page(body, head),
});

const u = (path: string) => `https://example.com${path}`;

function legacyCtx(specs: Spec[]): RuleContext {
  return {
    page: { url: u("/"), html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {},
    options: {},
    site: {
      baseUrl: u("/"),
      pages: specs.map((s) => ({
        url: u(s.path),
        statusCode: s.status ?? 200,
        parsed: parsePage(
          s.noindex
            ? s.html.replace("<head>", '<head><meta name="robots" content="noindex">')
            : s.html,
          u(s.path),
        ),
        headers: {},
      })),
      robotsTxt: null,
      sitemaps: null,
      siteIndexable: true,
    },
  } as unknown as RuleContext;
}

function row(s: Spec): PageFeatureRow {
  const parsed = parsePage(s.html, u(s.path));
  return {
    normalizedUrl: u(s.path),
    status: s.status ?? 200,
    depth: 1,
    title: null,
    titleHash: null,
    description: null,
    descHash: null,
    contentHash: null,
    wordCount: null,
    pageType: null,
    schemaTypes: [],
    robotsNoindex: !!s.noindex,
    canonical: null,
    visibleAuthor: false,
    visibleDate: false,
    transferBytes: null,
    templateFp: null,
    secretHits: null,
    metaNoindex: false,
    indexableReasons: [],
    richResultTypes: [],
    napName: null,
    napPhones: [],
    napPhoneFormats: [],
    napAddress: null,
    napAddressFormat: null,
    napTelLink: false,
    napMailtoLink: false,
    faviconHref: null,
    themeColor: null,
    ogImage: null,
    hreflangAlternates: null,
    reportScalars: null,
    terminologyVariants: pageTerminologyVariants(parsed),
  } as PageFeatureRow;
}

function streamCtx(specs: Spec[]): RuleContext {
  const rows = specs.map(row);
  const unused = (): never => {
    throw new Error("terminology-consistency must not use this SiteQuery method");
  };
  const siteQuery = {
    pageCount: () => rows.length,
    duplicateGroups: unused,
    incomingLinkCounts: unused,
    contextualIncomingLinkCounts: unused,
    pagesByType: unused,
    templateClusters: unused,
    sumTransferBytes: unused,
    sumSecretHits: unused,
    homepage: unused,
    async *pagesMatching(pred: (r: PageFeatureRow) => boolean) {
      for (const r of rows) if (pred(r)) yield r;
    },
  } as unknown as SiteQuery;
  return {
    page: { url: u("/"), html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {},
    options: {},
    site: { baseUrl: u("/"), pages: [], robotsTxt: null, sitemaps: null, siteIndexable: true },
    siteQuery,
  } as unknown as RuleContext;
}

async function run(ctx: RuleContext): Promise<CheckResult[]> {
  return (await Promise.resolve(terminologyConsistencyRule.run(ctx))).checks;
}

async function bothPaths(specs: Spec[]): Promise<CheckResult> {
  const legacy = await run(legacyCtx(specs));
  const streamed = await run(streamCtx(specs));
  expect(JSON.stringify(streamed)).toBe(JSON.stringify(legacy));
  expect(legacy).toHaveLength(1);
  return legacy[0]!;
}

const consistent = (n: number): Spec[] => Array.from({ length: n }, (_, i) => signIn(i));

describe("pageTerminologyVariants", () => {
  const variants = (body: string, head = "") =>
    pageTerminologyVariants(parsePage(page(body, head), u("/x")));

  test("counts the shipped variants and nothing else", () => {
    expect(
      variants(
        "<a>Log in</a> <a>Login</a> <a>sign-in</a> email e-mail <b>Sign</b> up Register Create an account FAQ FAQs Faq",
      ),
    ).toEqual({
      "signin.sign_in": 1,
      "signin.log_in": 1,
      "signin.login": 1,
      "email.email": 1,
      "email.e_mail": 1,
      "signup.sign_up": 1,
      "signup.register": 1,
      "signup.create_account": 1,
      "faq.upper": 1,
      "faq.upper_s": 1,
      "faq.other": 1,
    });
  });

  test("adjacent links do not glue into one phrase", () => {
    expect(variants('<a href="/a">Sign in</a><a href="/b">Log in</a>')).toEqual({
      "signin.sign_in": 1,
      "signin.log_in": 1,
    });
  });

  test("words inside URLs and email addresses are not counted", () => {
    expect(
      variants(
        "Write to login@example.com or see https://example.com/login and example.com/signup",
      ),
    ).toBeNull();
  });

  test("code is not prose", () => {
    expect(variants("<code>log in</code><pre>sign in</pre>")).toBeNull();
  });

  test("product name casing comes from og:site_name, and sentence starts are ignored", () => {
    const head = '<meta property="og:site_name" content="squirrelscan">';
    expect(
      variants(
        "Welcome to squirrelscan. Squirrelscan is fast. Try SQUIRRELSCAN or SquirrelScan.",
        head,
      ),
    ).toEqual({
      "brand.lower": 1,
      "brand.upper": 1,
      "brand.camel": 1,
    });
    expect(
      variants("Welcome to squirrelscan", '<meta property="og:site_name" content="Two Words">'),
    ).toBeNull();
  });

  test("a brand inside a hostname or address, or Title case at a heading start, is not counted", () => {
    const head = '<meta property="og:site_name" content="squirrelscan">';
    expect(
      variants("<p>Visit squirrelscan.com or mail hi@squirrelscan.com today</p>", head),
    ).toBeNull();
    expect(variants("<h2>Squirrelscan pricing</h2><h2>SquirrelScan plans</h2>", head)).toEqual({
      "brand.camel": 1,
    });
  });

  test("is bounded by the key table and caps each count", () => {
    const map = variants("login ".repeat(1000))!;
    expect(Object.keys(map).length).toBeLessThanOrEqual(TERM_KEY_COUNT);
    expect(map["signin.login"]).toBe(255);
  });
});

describe("content/terminology-consistency", () => {
  test("a consistent site produces no finding", async () => {
    const check = await bothPaths(consistent(14));
    expect(check.status).toBe("pass");
    expect(check.items).toBeUndefined();
  });

  test("a minority spelling is a warning naming the dominant and minority terms", async () => {
    const specs = [
      ...consistent(14),
      spec(14, '<a href="/a">Log in</a>'),
      spec(15, "<p>Login here</p>"),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    expect(check.items).toHaveLength(2);
    expect(check.items?.[0]?.label).toBe(
      'Uses "Log in" where the site mostly says "Sign in" (93% of 30 uses)',
    );
    expect(check.items?.map((i) => i.id)).toEqual(["signin.log_in", "signin.login"]);
    expect(check.items?.[0]?.sourcePages).toEqual([u("/p014")]);
    expect(check.message).toContain('"Log in"');
    expect(check.message).toContain('"Sign in"');
  });

  test("minority email, sign up and FAQ spellings are found against their dominant ones", async () => {
    const base = (i: number) =>
      spec(i, "<p>Email us. Sign up today. See the FAQ.</p><p>Email again.</p>");
    const specs = [
      ...Array.from({ length: 12 }, (_, i) => base(i)),
      spec(12, "<p>Send an e-mail.</p>"),
      spec(13, "<p>Register now. FAQs</p>"),
    ];
    const check = await bothPaths(specs);
    // Three concepts are inconsistent here, which is the fail threshold.
    expect(check.status).toBe("fail");
    const ids = check.items?.map((i) => i.id);
    expect(ids).toEqual(["email.e_mail", "signup.register", "faq.upper_s"]);
  });

  test("product-name casing deviants are flagged", async () => {
    const head = '<meta property="og:site_name" content="squirrelscan">';
    const specs = [
      ...Array.from({ length: 12 }, (_, i) => spec(i, "<p>We use squirrelscan daily.</p>", head)),
      spec(12, "<p>We use SquirrelScan daily.</p>", head),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    expect(check.items?.[0]?.id).toBe("brand.camel");
    expect(check.items?.[0]?.label).toContain('"lowercase"');
  });

  test("three inconsistent concepts fail", async () => {
    const base = (i: number) =>
      spec(
        i,
        "<p>Sign in. Email us. See the FAQ. Sign up.</p><p>Sign in. Email. FAQ. Sign up.</p>",
      );
    const specs = [
      ...Array.from({ length: 12 }, (_, i) => base(i)),
      spec(12, "<p>Log in, e-mail, Faq</p>"),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("fail");
    expect(check.items?.map((i) => i.id)).toEqual(["signin.log_in", "email.e_mail", "faq.other"]);
  });

  test("a crawl below the page floor is skipped", async () => {
    const check = await bothPaths([...consistent(TERM_MIN_PAGES - 2), spec(98, "<p>Log in</p>")]);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain("crawled");
  });

  test("a site with no clear norm (60/40 split) is skipped, not guessed at", async () => {
    const specs = Array.from({ length: 15 }, (_, i) =>
      spec(i, i % 5 < 3 ? "<p>Sign in</p><p>sign in</p>" : "<p>Log in</p><p>log in</p>"),
    );
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain("does not settle");
  });

  test("exactly 70 percent agreement is a norm, 65 percent is not", async () => {
    // One use per page: 14 of 20 uses is exactly 70%, 13 of 20 is 65%.
    const mk = (signs: number, logs: number) => [
      ...Array.from({ length: signs }, (_, i) => spec(i, "<p>Sign in</p>")),
      ...Array.from({ length: logs }, (_, i) => spec(50 + i, "<p>Log in</p>")),
    ];
    expect((await bothPaths(mk(14, 6))).status).toBe("warn");
    expect((await bothPaths(mk(13, 7))).status).toBe("skipped");
  });

  test("too little wording to judge is skipped", async () => {
    const check = await bothPaths(
      Array.from({ length: 12 }, (_, i) => spec(i, "<p>Nothing relevant.</p>")),
    );
    expect(check.status).toBe("skipped");
    expect(check.message).toContain("Too little");
  });

  test("error pages and noindex pages do not vote or get flagged", async () => {
    const specs: Spec[] = [
      ...consistent(14),
      { ...spec(20, "<p>Log in</p><p>Log in</p>"), status: 404 },
      { ...spec(21, "<p>Login</p>"), noindex: true },
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(check.details).toMatchObject({ skippedNoindexPages: 1 });
  });

  test("a row stored without the column is not a sample", async () => {
    const ctx = streamCtx(consistent(14));
    const rows: PageFeatureRow[] = [];
    for await (const r of ctx.siteQuery!.pagesMatching(() => true)) {
      delete (r as { terminologyVariants?: unknown }).terminologyVariants;
      rows.push(r);
    }
    expect(rows).toHaveLength(14);
    expect((await run(ctx))[0]?.status).toBe("skipped");
  });

  test("legacy path with no pages skips", async () => {
    expect((await run(legacyCtx([])))[0]?.status).toBe("skipped");
  });
});
