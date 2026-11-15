// content/near-duplicate (repo#1369): groups indexable pages whose main text is nearly identical.
// Pages are real parsePage HTML with nav, header and footer chrome. Every cluster case runs through
// BOTH paths (legacy ctx.site.pages, streaming siteQuery + collectedSignals) where it matters.

import { describe, expect, test } from "bun:test";

import type { CheckResult, PageFeatureRow, SiteQuery } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { duplicateContentRule, fingerprintForPage } from "../src/content/duplicate-content";
import {
  MAX_URLS_PER_CLUSTER,
  NEAR_DUP_FAIL_CLUSTER,
  NEAR_DUP_MAX_DISTANCE,
  NEAR_DUP_MAX_TOKENS,
  NEAR_DUP_MIN_WORDS,
  nearDuplicateRule,
  pageContentSimhash,
  simhashDistance,
} from "../src/content/near-duplicate";
import { seoDoorwayRule } from "../src/integrity/seo-doorway";
import { noindexSource } from "../src/shared/noindex";
import type { RuleContext } from "../src/types";

// ---- deterministic, varied English -------------------------------------------------------

const SUBJECTS = [
  "The village bakery",
  "A careful gardener",
  "Our regional office",
  "Every new customer",
  "The local council",
  "A retired engineer",
  "The evening class",
  "Most small farms",
  "The harbour authority",
  "An experienced guide",
  "The community library",
  "A young violinist",
  "The weekend market",
  "Several nearby schools",
  "The repair workshop",
  "A patient teacher",
  "The old railway line",
  "Each volunteer crew",
  "The valley brewery",
  "A visiting surveyor",
];
const VERBS = [
  "prepares",
  "restores",
  "documents",
  "arranges",
  "inspects",
  "rebuilds",
  "supports",
  "measures",
  "records",
  "teaches",
  "delivers",
  "improves",
  "protects",
  "schedules",
  "explains",
  "maintains",
  "reviews",
  "plans",
  "tests",
  "organises",
];
const OBJECTS = [
  "the timber frames",
  "a detailed seasonal calendar",
  "several fragile maps",
  "the copper pipework",
  "an updated safety manual",
  "the northern footpaths",
  "a shared tool library",
  "the stone bridges",
  "every incoming parcel",
  "a long waiting list",
  "the heating controls",
  "a modest grant",
  "the original floor plans",
  "two spare ladders",
  "the drainage channels",
  "a fresh set of notes",
  "the loading bays",
  "an unusual weather pattern",
  "the glass roof panels",
  "a thorough budget",
];
const TAILS = [
  "before the autumn rains arrive",
  "with help from neighbouring towns",
  "after years of slow progress",
  "using methods passed down by hand",
  "while the roads are quiet",
  "for anyone who asks politely",
  "throughout the long winter months",
  "despite a tight schedule",
  "in plain and honest language",
  "well ahead of the spring rush",
  "under clear and simple rules",
  "without any unnecessary fuss",
  "as the summer visitors depart",
  "in small and careful steps",
  "during the first week of term",
  "on the quieter side of the river",
  "to keep costs predictable",
  "with a steady and patient routine",
  "across several rural districts",
  "just as the old guidebook suggests",
];

function lcg(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function sentence(next: () => number): string {
  const pick = (a: readonly string[]) => a[Math.floor(next() * a.length)]!;
  return `${pick(SUBJECTS)} ${pick(VERBS)} ${pick(OBJECTS)} ${pick(TAILS)}.`;
}

/** Paragraphs for a topic seed: 8 paragraphs of 7 varied sentences, about 600 words. */
function paragraphs(seed: number): string[] {
  const next = lcg(seed);
  return Array.from({ length: 8 }, () => Array.from({ length: 7 }, () => sentence(next)).join(" "));
}

interface Variant {
  city?: string;
  date?: string;
  /** Replace paragraph 5 with this text. */
  replaceParagraph?: string;
  /** Replace only the first sentence of paragraph 5 with this text. */
  replaceSentence?: string;
}

function mainText(seed: number, v: Variant = {}): string {
  const paras = paragraphs(seed);
  if (v.replaceParagraph) paras[5] = v.replaceParagraph;
  if (v.replaceSentence)
    paras[5] = `${v.replaceSentence} ${paras[5]!.split(". ").slice(1).join(". ")}`;
  if (v.city) {
    paras[0] = `Our team serves ${v.city} and the surrounding area every week. ${paras[0]}`;
    paras[7] = `${paras[7]} Call today to book a visit in ${v.city}.`;
  }
  if (v.date) paras[2] = `${paras[2]} This guide was last reviewed on ${v.date}.`;
  return paras.map((p) => `<p>${p}</p>`).join("\n");
}

function chrome(label: string): { nav: string; footer: string } {
  const links = Array.from(
    { length: 12 },
    (_, i) => `<a href="/${label}/${i}">Menu ${label} item ${i}</a>`,
  );
  return {
    nav: `<header><nav>${links.join(" ")}</nav></header>`,
    footer: `<footer><p>Copyright ${label} company, all rights reserved. Terms, privacy, cookies, careers, press, contact, sitemap.</p></footer>`,
  };
}

interface Spec {
  path: string;
  main: string;
  chromeLabel?: string;
  status?: number;
  noindex?: boolean;
  canonical?: string;
  finalUrl?: string;
}

const u = (p: string) => `https://example.com${p}`;

function html(s: Spec): string {
  const c = chrome(s.chromeLabel ?? "shared");
  const head = [
    `<title>${s.path}</title>`,
    s.canonical ? `<link rel="canonical" href="${s.canonical}">` : "",
    s.noindex ? `<meta name="robots" content="noindex">` : "",
  ].join("");
  return `<!doctype html><html><head>${head}</head><body>${c.nav}<main>${s.main}</main>${c.footer}</body></html>`;
}

const parsedOf = (s: Spec) => parsePage(html(s), u(s.path));
const hashOf = (s: Spec) => pageContentSimhash(parsedOf(s).document, u(s.path), s.finalUrl);

const baseCtx = {
  page: { url: u("/"), html: "", statusCode: 200, loadTime: 0, headers: {} },
  parsed: {} as never,
  options: {},
};

function legacyCtx(specs: Spec[]): RuleContext {
  return {
    ...baseCtx,
    site: {
      baseUrl: u("/"),
      pages: specs.map((s) => ({
        url: u(s.path),
        ...(s.finalUrl ? { finalUrl: s.finalUrl } : {}),
        statusCode: s.status ?? 200,
        parsed: parsedOf(s),
      })),
      robotsTxt: null,
      sitemaps: null,
    },
  };
}

function fakeSiteQuery(rows: PageFeatureRow[]): SiteQuery {
  const unused = (): never => {
    throw new Error("near-duplicate must not use this SiteQuery method");
  };
  return {
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
  };
}

function streamingCtx(specs: Spec[]): RuleContext {
  const rows = specs.map((s) => {
    const parsed = parsedOf(s);
    return {
      normalizedUrl: u(s.path),
      status: s.status ?? 200,
      robotsNoindex: noindexSource(parsed, undefined) !== null,
      canonical: parsed.meta.canonical ?? null,
      hreflangAlternates: parsed.hreflangAlternates ?? null,
      contentSimhash: pageContentSimhash(parsed.document, u(s.path), s.finalUrl),
    } as unknown as PageFeatureRow;
  });
  return {
    ...baseCtx,
    site: { baseUrl: u("/"), pages: [], robotsTxt: null, sitemaps: null },
    siteQuery: fakeSiteQuery(rows),
    collectedSignals: {
      pages: specs.map(
        (s) =>
          ({
            url: u(s.path),
            contentFingerprint: fingerprintForPage(parsedOf(s).document, u(s.path), s.finalUrl),
          }) as never,
      ),
    },
  };
}

async function check(ctx: RuleContext): Promise<CheckResult> {
  const out = await Promise.resolve(nearDuplicateRule.run(ctx));
  expect(out.checks).toHaveLength(1);
  return out.checks[0]!;
}

/** Both paths, deep-equal on the whole RuleResult. */
async function both(specs: Spec[]): Promise<CheckResult> {
  const legacy = await Promise.resolve(nearDuplicateRule.run(legacyCtx(specs)));
  const streaming = await Promise.resolve(nearDuplicateRule.run(streamingCtx(specs)));
  expect(streaming).toEqual(legacy);
  return legacy.checks[0]!;
}

/** n unrelated pages, each its own topic seed. */
function distinct(n: number, from = 1000): Spec[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `/topic-${String(i).padStart(3, "0")}`,
    main: mainText(from + i),
  }));
}

const CITIES = [
  "Ashford",
  "Bristol",
  "Carlisle",
  "Durham",
  "Exeter",
  "Falmouth",
  "Gloucester",
  "Harrogate",
  "Ipswich",
  "Jarrow",
  "Kendal",
  "Lancaster",
];
const locations = (n: number): Spec[] =>
  CITIES.slice(0, n).map((city) => ({
    path: `/plumbers/${city.toLowerCase()}`,
    main: mainText(7, { city }),
  }));

// ---- extractor ---------------------------------------------------------------------------

describe("pageContentSimhash", () => {
  const base: Spec = { path: "/a", main: mainText(1) };

  test("identical main text gives an identical 16-char hex hash", () => {
    const h = hashOf(base);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(hashOf({ ...base, path: "/b" })).toBe(h!);
  });

  test("a city swap, a date swap and one replaced sentence stay within the threshold", () => {
    const measured: Record<string, number> = {};
    const a = hashOf({ path: "/a", main: mainText(1, { city: "Ashford" }) })!;
    measured.city = simhashDistance(
      a,
      hashOf({ path: "/b", main: mainText(1, { city: "Bristol" }) })!,
    );
    const d1 = hashOf({ path: "/a", main: mainText(1, { date: "3 March 2025" }) })!;
    measured.date = simhashDistance(
      d1,
      hashOf({ path: "/b", main: mainText(1, { date: "19 October 2026" }) })!,
    );
    const p0 = hashOf(base)!;
    // One short sentence swapped: the realistic small edit.
    const note =
      "A different note appears here about the quarterly accounts and the new parking rules.";
    measured.sentence = simhashDistance(
      p0,
      hashOf({ path: "/b", main: mainText(1, { replaceSentence: note }) })!,
    );
    console.log("near-duplicate measured distances", JSON.stringify(measured));
    expect(measured.city).toBeGreaterThan(0);
    for (const d of Object.values(measured)) expect(d).toBeLessThanOrEqual(NEAR_DUP_MAX_DISTANCE);
  });

  test("a whole rewritten paragraph is beyond the threshold (the documented limit)", () => {
    const para =
      "A different note appears here about the quarterly accounts and the new parking rules. It was written once for this page alone. Opening hours change over the holiday period, so check the notice board before you travel. Volunteers are always welcome at the Saturday workshop, whatever their experience.";
    const d = simhashDistance(
      hashOf({ path: "/a", main: mainText(1) })!,
      hashOf({ path: "/b", main: mainText(1, { replaceParagraph: para }) })!,
    );
    console.log("near-duplicate whole paragraph distance", d);
    expect(d).toBeGreaterThan(NEAR_DUP_MAX_DISTANCE);
  });

  test("unrelated pages are far apart", () => {
    const distances: number[] = [];
    for (let i = 0; i < 6; i++) {
      for (let j = i + 1; j < 6; j++) {
        distances.push(
          simhashDistance(
            hashOf({ path: "/a", main: mainText(100 + i) })!,
            hashOf({ path: "/b", main: mainText(100 + j) })!,
          ),
        );
      }
    }
    console.log("near-duplicate unrelated min distance", Math.min(...distances));
    for (const d of distances) expect(d).toBeGreaterThan(NEAR_DUP_MAX_DISTANCE);
  });

  test("chrome-only difference is distance 0", () => {
    expect(hashOf({ ...base, chromeLabel: "one" })).toBe(hashOf({ ...base, chromeLabel: "two" })!);
  });

  test("a page with no <main> reads the body minus chrome", () => {
    const text = mainText(1);
    const c = chrome("x");
    const noMain = parsePage(
      `<html><body>${c.nav}<div>${text}</div>${c.footer}</body></html>`,
      u("/n"),
    );
    expect(pageContentSimhash(noMain.document, u("/n"), null)).toBe(hashOf(base)!);
  });

  test("chrome inside <main> (nav, aside, form, role, aria-hidden) is not hashed", () => {
    const extras = (n: string) =>
      `<nav><a href="/x">Nav ${n} link</a></nav><aside>Related ${n} things</aside>` +
      `<form><label>Search ${n}</label></form><div role="complementary">Promo ${n}</div>` +
      `<div role="navigation">Crumbs ${n}</div><div aria-hidden="true">Hidden ${n}</div>`;
    const a = hashOf({ path: "/a", main: extras("one") + mainText(1) });
    expect(a).toBe(hashOf({ path: "/b", main: mainText(1) + extras("two") })!);
    expect(a).toBe(hashOf(base)!);
  });

  test("under 100 main words is null", () => {
    const short = `<p>${"alpha beta gamma ".repeat(30)}</p>`;
    expect(hashOf({ path: "/s", main: short })).toBeNull();
    const ok = `<p>${Array.from({ length: NEAR_DUP_MIN_WORDS }, (_, i) => `w${i}`).join(" ")}</p>`;
    expect(hashOf({ path: "/s", main: ok })).not.toBeNull();
  });

  test("a redirect, a missing document and a rootless document are null", () => {
    expect(hashOf({ ...base, finalUrl: u("/elsewhere") })).toBeNull();
    expect(pageContentSimhash(null, u("/a"), null)).toBeNull();
    expect(pageContentSimhash(undefined, u("/a"), null)).toBeNull();
    const rootless = parsePage("", u("/r")).document;
    expect(pageContentSimhash(rootless, u("/r"), null)).toBeNull();
    const throwing = {
      get body(): never {
        throw new Error("no root");
      },
    } as unknown as Document;
    expect(pageContentSimhash(throwing, u("/r"), null)).toBeNull();
  });

  test("a huge page is bounded", () => {
    const words = Array.from({ length: NEAR_DUP_MAX_TOKENS * 3 }, (_, i) => `word${i}`).join(" ");
    const start = performance.now();
    const h = hashOf({ path: "/huge", main: `<p>${words}</p>` });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    // Only the first NEAR_DUP_MAX_TOKENS tokens count: text after them does not move the hash.
    const tail = Array.from({ length: NEAR_DUP_MAX_TOKENS * 3 }, (_, i) =>
      i < NEAR_DUP_MAX_TOKENS ? `word${i}` : `other${i}`,
    ).join(" ");
    expect(hashOf({ path: "/huge2", main: `<p>${tail}</p>` })).toBe(h!);
    expect(performance.now() - start).toBeLessThan(3000);
  });
});

// ---- the rule ----------------------------------------------------------------------------

describe("content/near-duplicate", () => {
  test("warn: 3 near-identical pages among distinct pages: one cluster listing every URL", async () => {
    const trio: Spec[] = [
      { path: "/guide/ashford", main: mainText(7, { city: "Ashford" }) },
      { path: "/guide/bristol", main: mainText(7, { city: "Bristol" }) },
      { path: "/guide/carlisle", main: mainText(7, { city: "Carlisle" }) },
    ];
    const res = await both([...distinct(10), ...trio]);
    expect(res.status).toBe("warn");
    expect(res.message).toBe("1 near-duplicate cluster(s) found across 3 pages");
    expect(res.items).toHaveLength(1);
    expect(res.items![0]!.sourcePages).toEqual(trio.map((s) => u(s.path)));
    expect(res.items![0]!.id).toBe(u("/guide/ashford"));
    expect(res.items![0]!.label).toBe("3 pages have nearly identical main text");
    expect(res.items![0]!.meta).toMatchObject({ pageCount: 3, distinctTexts: 3, exactCopies: 0 });
  });

  test("fail: 12 location pages cluster at doorway scale", async () => {
    const res = await both([...distinct(10), ...locations(12)]);
    expect(NEAR_DUP_FAIL_CLUSTER).toBe(10);
    expect(res.status).toBe("fail");
    expect(res.items).toHaveLength(1);
    expect(res.items![0]!.sourcePages).toHaveLength(12);
    expect(res.details).toMatchObject({ totalClusters: 1, totalPages: 12, comparedPages: 22 });
  });

  test("pass: distinct pages sharing identical heavy chrome are not clustered", async () => {
    const res = await both(distinct(12));
    expect(res.status).toBe("pass");
    expect(res.message).toBe("No pages have nearly identical main text");
    expect(res.details).toMatchObject({
      comparedPages: 12,
      minWords: 100,
      maxDistance: NEAR_DUP_MAX_DISTANCE,
    });
  });

  test("pass: short pages sharing chrome are not clustered", async () => {
    const short = Array.from({ length: 12 }, (_, i) => ({
      path: `/short-${i}`,
      main: `<p>${"A brief note about topic " + i + ". "}${"We keep it short here. ".repeat(10)}</p>`,
    }));
    const res = await both(short);
    expect(res.status).toBe("skipped");
    expect(res.message).toBe("Fewer than 2 pages have enough main text to compare");
    const withLong = await both([...short, ...distinct(3)]);
    expect(withLong.status).toBe("pass");
    expect(withLong.details).toMatchObject({ excluded: { unhashed: 12 }, comparedPages: 3 });
  });

  test("pass: pages built from one sentence template with different slot words do not cluster", async () => {
    const adjectives = [
      "quiet",
      "bright",
      "sturdy",
      "modern",
      "gentle",
      "rapid",
      "plain",
      "clever",
      "warm",
      "tidy",
      "rugged",
      "sleek",
    ];
    const nouns = [
      "kettle",
      "ladder",
      "garden",
      "bicycle",
      "lantern",
      "cabinet",
      "harbour",
      "journal",
      "compass",
      "blanket",
      "teapot",
      "window",
    ];
    const verbs = [
      "supports",
      "improves",
      "protects",
      "frames",
      "carries",
      "restores",
      "guides",
      "lights",
      "shapes",
      "holds",
      "mends",
      "shelters",
    ];
    const topics = [
      "morning routines",
      "winter evenings",
      "small kitchens",
      "busy streets",
      "family trips",
      "quiet study",
      "weekend repairs",
      "garden work",
      "long walks",
      "shared meals",
      "late deliveries",
      "spring cleaning",
    ];
    const specs: Spec[] = Array.from({ length: 12 }, (_, page) => {
      const next = lcg(900 + page);
      const pick = (a: string[]) => a[Math.floor(next() * a.length)]!;
      const sentences = Array.from(
        { length: 45 },
        () =>
          `The ${pick(adjectives)} ${pick(nouns)} ${pick(verbs)} ${pick(topics)} for everyday use.`,
      );
      return { path: `/templated/${page}`, main: `<p>${sentences.join(" ")}</p>` };
    });
    expect(hashOf(specs[0]!)).not.toBeNull();
    const res = await both(specs);
    expect(res.status).toBe("pass");
    expect(res.details).toMatchObject({ comparedPages: 12 });
  });

  test("skipped: fewer than 10 pages", async () => {
    const res = await both([...distinct(4), ...locations(3)]);
    expect(res.status).toBe("skipped");
    expect(res.message).toBe(
      "Only 7 page(s) crawled; 10 needed to compare pages for near-duplicate content",
    );
  });

  test("exact duplicates alone are left to content/duplicate-content (no double report)", async () => {
    const specs: Spec[] = [
      ...distinct(10),
      { path: "/copy-a", main: mainText(7, { city: "Ashford" }) },
      { path: "/copy-b", main: mainText(7, { city: "Ashford" }) },
    ];
    const res = await both(specs);
    expect(res.status).toBe("pass");
    const dup = await Promise.resolve(duplicateContentRule.run(legacyCtx(specs)));
    expect(dup.checks[0]!.status).toBe("warn");
    expect(dup.checks[0]!.items![0]!.sourcePages).toEqual([u("/copy-a"), u("/copy-b")]);
  });

  test("two exact copies plus a near variant: one cluster, exact copies counted", async () => {
    const specs: Spec[] = [
      ...distinct(10),
      { path: "/copy-a", main: mainText(7, { city: "Ashford" }) },
      { path: "/copy-b", main: mainText(7, { city: "Ashford" }) },
      { path: "/variant", main: mainText(7, { city: "Bristol" }) },
    ];
    const res = await both(specs);
    expect(res.status).toBe("warn");
    expect(res.items![0]!.sourcePages).toEqual([u("/copy-a"), u("/copy-b"), u("/variant")]);
    expect(res.items![0]!.label).toBe(
      "3 pages have nearly identical main text (2 are exact copies, also reported by content/duplicate-content)",
    );
    expect(res.items![0]!.meta).toMatchObject({ pageCount: 3, distinctTexts: 2, exactCopies: 2 });
    const dup = await Promise.resolve(duplicateContentRule.run(legacyCtx(specs)));
    expect(dup.checks[0]!.items![0]!.sourcePages).toEqual([u("/copy-a"), u("/copy-b")]);
  });

  test("a cluster whose pages all point to one canonical is not reported", async () => {
    const canonical = u("/guide/ashford");
    const specs: Spec[] = [
      ...distinct(10),
      ...["ashford", "bristol", "carlisle"].map((c) => ({
        path: `/guide/${c}`,
        main: mainText(7, { city: c }),
        canonical,
      })),
    ];
    const res = await both(specs);
    expect(res.status).toBe("pass");
    expect(res.details).toMatchObject({ canonicalisedClusters: 1 });
  });

  test("noindex, non-2xx and paginated pages are excluded", async () => {
    const specs: Spec[] = [
      ...distinct(10),
      { path: "/a", main: mainText(7, { city: "Ashford" }), noindex: true },
      { path: "/b", main: mainText(7, { city: "Bristol" }), status: 404 },
      { path: "/c/page/2", main: mainText(7, { city: "Carlisle" }) },
      { path: "/d", main: mainText(7, { city: "Durham" }) },
    ];
    const res = await both(specs);
    expect(res.status).toBe("pass");
    expect(res.details).toMatchObject({ excluded: { noindex: 1, notOk: 1, pagination: 1 } });
  });

  test("lists at most MAX_URLS_PER_CLUSTER urls and counts the rest", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      path: `/loc/${String(i).padStart(2, "0")}`,
      main: mainText(7, { city: `Town${String.fromCharCode(65 + i)}` }),
    }));
    const res = await both([...distinct(3), ...many]);
    expect(res.items![0]!.sourcePages).toHaveLength(MAX_URLS_PER_CLUSTER);
    expect(res.items![0]!.meta).toMatchObject({ pageCount: 25, listedUrls: 20, omittedUrls: 5 });
  });

  test("a legacy page without a document is not hashed and not a candidate", async () => {
    const ctx = legacyCtx(distinct(11));
    ctx.site!.pages[0]!.parsed = { ...ctx.site!.pages[0]!.parsed, document: undefined } as never;
    const res = await check(ctx);
    expect(res.status).toBe("pass");
    expect(res.details).toMatchObject({ excluded: { unhashed: 1 } });
  });
});

// ---- overlap with integrity/seo-doorway --------------------------------------------------

describe("content/near-duplicate and integrity/seo-doorway", () => {
  test("a templated location cluster is one near-duplicate finding and no doorway finding", async () => {
    const pages = locations(12);
    const res = await check(legacyCtx([...pages, ...distinct(2)]));
    expect(res.status).toBe("fail");
    expect(res.items).toHaveLength(1);
    for (const s of pages) {
      const parsed = parsedOf(s);
      const out = await Promise.resolve(
        seoDoorwayRule.run({
          page: {
            url: u(s.path),
            html: html(s),
            statusCode: 200,
            loadTime: 0,
            headers: {},
            parsed,
          },
          parsed,
          options: {},
        }),
      );
      expect(out.checks.filter((c) => c.status !== "pass")).toEqual([]);
    }
  });
});

// ---- parity and event-loop behaviour -----------------------------------------------------

describe("both paths", () => {
  test("warn fixture: whole RuleResult is deep-equal", async () => {
    const specs: Spec[] = [...distinct(10), ...locations(4)];
    const res = await both(specs);
    expect(res.status).toBe("warn");
  });

  test("fail fixture with exact copies and a canonicalised cluster: deep-equal", async () => {
    const specs: Spec[] = [
      ...distinct(10),
      ...locations(12),
      { path: "/plumbers/ashford-copy", main: mainText(7, { city: "Ashford" }) },
      ...["x", "y"].map((c) => ({
        path: `/other/${c}`,
        main: mainText(9, { city: c }),
        canonical: u("/other/x"),
      })),
    ];
    const res = await both(specs);
    expect(res.status).toBe("fail");
    expect(res.details).toMatchObject({ canonicalisedClusters: 1 });
  });

  test("streaming path with 4000 unique simhashes yields to timers", async () => {
    let seed = 12345;
    const nextHex = (): string => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const a = seed;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return a.toString(16).padStart(8, "0") + seed.toString(16).padStart(8, "0");
    };
    const rows = Array.from({ length: 4000 }, (_, i) => ({
      normalizedUrl: u(`/p/${i}`),
      status: 200,
      robotsNoindex: false,
      canonical: null,
      hreflangAlternates: null,
      contentSimhash: nextHex(),
    })) as unknown as PageFeatureRow[];
    const ctx: RuleContext = {
      ...baseCtx,
      site: { baseUrl: u("/"), pages: [], robotsTxt: null, sitemaps: null },
      siteQuery: fakeSiteQuery(rows),
    };
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      const res = await check(ctx);
      expect(res.status).toBe("pass");
      expect(res.details).toMatchObject({ comparedPages: 4000 });
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });

  test("legacy path over 300 parsed pages yields to timers", async () => {
    const ctx = legacyCtx(distinct(300, 5000));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      const res = await check(ctx);
      expect(res.status).toBe("pass");
      expect(res.details).toMatchObject({ comparedPages: 300 });
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  }, 20000);
});
