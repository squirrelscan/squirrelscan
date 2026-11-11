// links/anchor-mismatch: inbound anchor text vs the target's title, H1 and slug (#110).

import { describe, expect, test } from "bun:test";

import { MAX_ANCHOR_PART_LENGTH, MAX_ANCHOR_PARTS, parsePage } from "@squirrelscan/parser";

import {
  AnchorGraphBuilder,
  anchorMismatchRule,
  evaluateAnchorGraph,
  meaningfulTokens,
  tokenize,
  tokensMatch,
} from "../src/links/anchor-mismatch";
import type { CheckResult, ParsedPage, RuleContext } from "../src/types";
import type { LinkData } from "@squirrelscan/core-contracts";

const BASE = "https://example.com/";

function body(url: string, text: string): LinkData {
  return { url, text, isInternal: true, isChrome: false };
}
function chrome(url: string, text: string): LinkData {
  return { url, text, isInternal: true, isChrome: true };
}

interface PageSpec {
  url: string;
  title?: string;
  h1?: string[];
  links?: LinkData[];
}

function ctx(pages: PageSpec[], extra: Record<string, unknown> = {}): RuleContext {
  return {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: BASE,
      pages: pages.map((p) => ({
        url: p.url,
        finalUrl: p.url,
        statusCode: 200,
        parsed: {
          meta: { title: p.title ?? null },
          h1: { count: p.h1?.length ?? 0, texts: p.h1 ?? [] },
          links: p.links ?? [],
        } as unknown as ParsedPage,
      })),
      robotsTxt: null,
      sitemaps: null,
      ...extra,
    },
    options: {},
  } as unknown as RuleContext;
}

function check(pages: PageSpec[], extra?: Record<string, unknown>): CheckResult {
  const result = anchorMismatchRule.run(ctx(pages, extra));
  return (result as { checks: CheckResult[] }).checks[0]!;
}

const HOME: PageSpec = { url: BASE, title: "Home" };

describe("links/anchor-mismatch tokens", () => {
  test("plurals and short brands match", () => {
    expect(tokensMatch("fridges", "fridge")).toBe(true);
    expect(tokensMatch("lg", "lg")).toBe(true);
    expect(tokensMatch("lg", "lgs")).toBe(false);
    expect(tokensMatch("car", "carpentry")).toBe(false);
    expect(meaningfulTokens("LG")).toEqual(["lg"]);
    expect(meaningfulTokens("a b")).toEqual([]);
  });
});

describe("links/anchor-mismatch hyphenated compounds (#1598)", () => {
  test("Online-Shop Umsetzung -> /onlineshop-agentur does not warn (German pair from the report)", () => {
    const c = check([
      { ...HOME, links: [body("/onlineshop-agentur", "Online-Shop Umsetzung")] },
      {
        url: "https://example.com/onlineshop-agentur",
        title: "Onlineshop Agentur: Shopsystem, Relaunch, Betreuung | ONEDOT",
      },
    ]);
    expect(c.status).toBe("pass");
  });

  test("E-Mail and Web-Seite match their closed forms in the title", () => {
    for (const [anchor, title] of [
      ["E-Mail Versand", "Email Marketing Tool"],
      ["Web-Seite erstellen", "Webseite Baukasten"],
    ] as const) {
      const c = check([
        { ...HOME, links: [body("/t", anchor)] },
        { url: "https://example.com/t", title },
      ]);
      expect(c.status).toBe("pass");
    }
  });

  test("the reverse: a closed anchor word matches a hyphenated title word", () => {
    const c = check([
      { ...HOME, links: [body("/shop", "Onlineshop Umsetzung")] },
      { url: "https://example.com/shop", title: "Online-Shop Agentur Berlin" },
    ]);
    expect(c.status).toBe("pass");
  });

  test("the reverse against a hyphenated slug inside a longer slug", () => {
    const c = check([
      { ...HOME, links: [body("/online-shop-agentur", "Onlineshop")] },
      { url: "https://example.com/online-shop-agentur", title: "Ihre Agentur" },
    ]);
    expect(c.status).toBe("pass");
  });

  test("a hyphenated anchor that only shares a short prefix still warns", () => {
    const c = check([
      { ...HOME, links: [body("/onlineshop-agentur", "Online-Marketing Umsetzung")] },
      { url: "https://example.com/onlineshop-agentur", title: "Onlineshop Agentur" },
    ]);
    expect(c.status).toBe("warn");
  });

  test("joined forms are kept apart from the tokens; the parts stay tokens", () => {
    expect(meaningfulTokens("Online-Shop")).toEqual(["online", "shop"]);
    expect(tokenize("Online-Shop")).toEqual({
      tokens: ["online", "shop"],
      joined: ["onlineshop"],
      lost: false,
    });
    expect(meaningfulTokens("E-Mail")).toEqual(["mail"]);
    expect(tokenize("E-Mail").joined).toEqual(["email"]);
  });

  test("a joined form matches by equality only, never by prefix or suffix", () => {
    // "foobar" is neither part of the target, and is not equal to its word "foobarxyz".
    const c = check([
      { ...HOME, links: [body("/t", "Foo-Bar")] },
      { url: "https://example.com/t", title: "Foobarxyz" },
    ]);
    expect(c.status).toBe("warn");
    // The reverse: a hyphenated target word must equal the anchor word.
    const r = check([
      { ...HOME, links: [body("/t", "Foobarxyz")] },
      { url: "https://example.com/t", title: "Foo-Bar" },
    ]);
    expect(r.status).toBe("warn");
  });

  test("a joined form still equals a closed word, and an ordinary token keeps its tolerance", () => {
    const eq = check([
      { ...HOME, links: [body("/t", "Foo-Bar")] },
      { url: "https://example.com/t", title: "Foobar" },
    ]);
    expect(eq.status).toBe("pass");
    const tol = check([
      { ...HOME, links: [body("/t", "Fridges")] },
      { url: "https://example.com/t", title: "Fridge repairs" },
    ]);
    expect(tol.status).toBe("pass");
  });
});

describe("links/anchor-mismatch joined forms are whole compounds (#1598)", () => {
  test("a run longer than the part cap emits no joined form, never a truncated compound", () => {
    const nine = "one-two-three-four-five-six-sev-ate-nin";
    expect(tokenize(nine).joined).toEqual([]);
    expect(tokenize(nine, { slug: true }).joined).not.toContain("onetwothreefourfivesixsevate");
    const c = check([
      { ...HOME, links: [body("/t", nine)] },
      { url: "https://example.com/t", title: "Onetwothreefourfivesixsevate" },
    ]);
    expect(c.status).toBe("warn");
  });

  test("adjacent-pair joins are for URL slugs only, not anchors or titles", () => {
    expect(tokenize("Online-Shop-Software").joined).toEqual(["onlineshopsoftware"]);
    const anchor = check([
      { ...HOME, links: [body("/t", "Online-Shop-Software")] },
      { url: "https://example.com/t", title: "Onlineshop" },
    ]);
    expect(anchor.status).toBe("warn");
    const title = check([
      { ...HOME, links: [body("/t", "Onlineshop")] },
      { url: "https://example.com/t", title: "Online-Shop-Software" },
    ]);
    expect(title.status).toBe("warn");
  });

  test("a hyphenated URL slug still joins neighbouring parts, kept apart from the tokens", () => {
    const c = check([
      { ...HOME, links: [body("/online-shop-agentur", "Onlineshop")] },
      { url: "https://example.com/online-shop-agentur", title: "Ihre Agentur" },
    ]);
    expect(c.status).toBe("pass");
    expect(meaningfulTokens("online-shop-agentur")).toEqual(["online", "shop", "agentur"]);
  });
});

describe("links/anchor-mismatch hyphen scan stays linear (#1598)", () => {
  const N = 128_000;
  const inputs: Array<[string, string]> = [
    ["one 128k word, no hyphen", "a".repeat(N)],
    ["one 128k run of hyphens between letters", "a-".repeat(N / 2)],
    ["many short hyphen runs", Array.from({ length: N / 8 }, (_, i) => `a${i}-b${i}`).join(" ")],
    ["128k letters then one hyphen", `${"a".repeat(N)}-b`],
    ["many hyphens, no letters", "-".repeat(N)],
  ];
  for (const [name, text] of inputs) {
    test(`${name}: tokenize stays under 500 ms`, () => {
      const start = performance.now();
      tokenize(text);
      expect(performance.now() - start).toBeLessThan(500);
    });
  }

  test("results are unchanged around runs, double hyphens and stray hyphens", () => {
    expect(tokenize("Online-Shop").joined).toEqual(["onlineshop"]);
    expect(tokenize("online-shop-agentur").joined).toEqual(["onlineshopagentur"]);
    expect(tokenize("online-shop-agentur", { slug: true }).joined).toEqual([
      "onlineshopagentur",
      "onlineshop",
      "shopagentur",
    ]);
    expect(tokenize("foo--bar").joined).toEqual([]);
    expect(tokenize("-foo-bar-").joined).toEqual(["foobar"]);
    expect(tokenize("a-b").joined).toEqual([]);
  });
});

describe("links/anchor-mismatch", () => {
  test("Fridges -> Fridge repairs at /repairs/fridge does not warn", () => {
    const c = check([
      { ...HOME, links: [body("/repairs/fridge", "Fridges")] },
      { url: "https://example.com/repairs/fridge", title: "Fridge repairs" },
    ]);
    expect(c.status).toBe("pass");
  });

  test("LG -> /brands/lg does not warn", () => {
    const c = check([
      { ...HOME, links: [body("/brands/lg", "LG")] },
      { url: "https://example.com/brands/lg", title: "Appliance brand" },
    ]);
    expect(c.status).toBe("pass");
  });

  test("/privacy linked as Privacy from every page does not warn", () => {
    const c = check([
      { ...HOME, links: [body("/privacy", "Legal notes"), body("/fridge", "Fridge")] },
      { url: "https://example.com/fridge", title: "Fridge repairs" },
      {
        url: "https://example.com/a",
        title: "Alpha",
        links: [body("/privacy", "Fine print")],
      },
      { url: "https://example.com/privacy", title: "Our data promise" },
      { url: "https://example.com/contact", title: "Reach us" },
    ]);
    expect(c.status).toBe("pass");
    // Only the fridge pair was judged: the privacy pairs are not targets at all.
    expect((c.details as { judged: number }).judged).toBe(1);
  });

  test("click here -> Commercial freezer repairs warns and names anchor, URL and title", () => {
    const c = check([
      { ...HOME, links: [body("/freezers", "click here")] },
      { url: "https://example.com/freezers", title: "Commercial freezer repairs" },
    ]);
    expect(c.status).toBe("warn");
    expect(c.items?.[0]?.label).toContain('"click here"');
    expect(c.items?.[0]?.label).toContain("https://example.com/freezers");
    expect(c.items?.[0]?.label).toContain("Commercial freezer repairs");
  });

  // #1729: the item id is the "source -> target" pair; the affected PAGE is the source only.
  test("each item names the source page alone as its page, the target stays in the label", () => {
    const c = check([
      { ...HOME, links: [body("/freezers", "click here")] },
      { url: "https://example.com/freezers", title: "Commercial freezer repairs" },
    ]);
    const item = c.items![0]!;
    expect(item.sourcePages).toEqual([HOME.url]);
    expect(item.sourcePages!.join(" ")).not.toContain("->");
    expect(item.id).toContain(" -> ");
    expect(item.label).toContain("https://example.com/freezers");
  });

  test("chrome links are excluded entirely", () => {
    const c = check([
      { ...HOME, links: [chrome("/freezers", "click here"), body("/fridge", "Fridge")] },
      { url: "https://example.com/freezers", title: "Commercial freezer repairs" },
      { url: "https://example.com/fridge", title: "Fridge repairs" },
    ]);
    expect(c.status).toBe("pass");
    expect((c.details as { judged: number }).judged).toBe(1);
  });

  test("the pair's combined anchor text is judged, per pair not per link", () => {
    const c = check([
      {
        ...HOME,
        links: [
          body("/freezers", "click here"),
          body("/freezers", "click here"),
          body("/freezers", "Freezer repair"),
        ],
      },
      { url: "https://example.com/freezers", title: "Commercial freezer repairs" },
    ]);
    expect(c.status).toBe("pass");
  });

  test("a card text with child nodes already separated matches the H1", () => {
    const c = check([
      {
        ...HOME,
        links: [body("/carpentry", "Carpentry Structural & finish carpentry See details")],
      },
      { url: "https://example.com/carpentry", title: "Services", h1: ["Carpentry"] },
    ]);
    expect(c.status).toBe("pass");
  });

  test("escalates when the mismatch is the only contextual anchor text", () => {
    const only = check([
      { ...HOME, links: [body("/engage", "how I work")] },
      { url: "https://example.com/a", title: "Alpha", links: [body("/engage", "how I work")] },
      { url: "https://example.com/engage", title: "Engage a consultant" },
    ]);
    expect(only.status).toBe("warn");
    expect(only.message).toContain("only contextual anchor text");
    expect(only.items?.length).toBe(2);

    const mixed = check([
      { ...HOME, links: [body("/engage", "how I work")] },
      { url: "https://example.com/a", title: "Alpha", links: [body("/engage", "go there")] },
      { url: "https://example.com/engage", title: "Engage a consultant" },
    ]);
    expect(mixed.status).toBe("warn");
    expect(mixed.message).not.toContain("only contextual anchor text");
  });

  test("stop-word-only anchors are counted as not judged, not dropped", () => {
    const c = check([
      { ...HOME, links: [body("/freezers", "the")] },
      { url: "https://example.com/freezers", title: "Commercial freezer repairs" },
    ]);
    expect(c.status).toBe("skipped");
    expect((c.details as { notJudged: number }).notJudged).toBe(1);
  });

  test("skips on a single page", () => {
    expect(check([HOME]).status).toBe("skipped");
  });

  test("skips, not a vacuous pass, when nothing was judged", () => {
    const c = check([
      { ...HOME, links: [body("/privacy", "Legal")] },
      { url: "https://example.com/privacy", title: "Our data promise" },
    ]);
    expect(c.status).toBe("skipped");
  });

  test("non-Latin text is not judged by shared words", () => {
    const cjk = check([
      { ...HOME, links: [body("/tokyo", "东京")] },
      { url: "https://example.com/tokyo", title: "东京旅行指南 | 旅行网站" },
    ]);
    expect(cjk.status).toBe("skipped");
    expect((cjk.details as { notJudged: number }).notJudged).toBe(1);

    const ja = check([
      { ...HOME, links: [body("/plans", "料金")] },
      { url: "https://example.com/plans", title: "料金プラン" },
    ]);
    expect(ja.status).toBe("skipped");

    const th = check([
      { ...HOME, links: [body("/menu", "เมนูอาหาร")] },
      { url: "https://example.com/menu", title: "เมนูอาหารไทย" },
    ]);
    expect(th.status).toBe("skipped");
  });

  test("diacritics are folded", () => {
    const c = check([
      { ...HOME, links: [body("/menu", "Café")] },
      { url: "https://example.com/menu", title: "Cafe menu" },
    ]);
    expect(c.status).toBe("pass");
    expect(meaningfulTokens("Café Zürich")).toEqual(["cafe", "zurich"]);
  });

  test("a matching word past the display clip still counts", () => {
    const long = `${"filler ".repeat(40)}freezer repairs`;
    const c = check([
      { ...HOME, links: [body("/freezers", long)] },
      { url: "https://example.com/freezers", title: "Commercial freezer repairs" },
    ]);
    expect(c.status).toBe("pass");
  });

  test("real HTML through parsePage: a card link separates its words for the rule", () => {
    const page = (url: string, html: string): PageSpec => {
      const parsed = parsePage(html, url);
      return {
        url,
        title: parsed.meta.title ?? undefined,
        h1: parsed.h1.texts,
        links: parsed.links,
      };
    };
    const card =
      '<main><a href="/carpentry"><h3>Carpentry</h3><p>Structural &amp; finish</p></a></main>';
    const good = check([
      page(BASE, `<html><head><title>Home</title></head><body>${card}</body></html>`),
      page(
        "https://example.com/carpentry",
        "<html><head><title>Structural work</title></head><body><h1>Finish</h1></body></html>",
      ),
    ]);
    // "Structural" is a whole word only because the extractor separated the child nodes.
    expect(good.status).toBe("pass");

    const bad = check([
      page(
        BASE,
        '<html><head><title>Home</title></head><body><main><a href="/freezers"><div>click</div><div>here</div></a></main></body></html>',
      ),
      page(
        "https://example.com/freezers",
        "<html><head><title>Commercial freezer repairs</title></head><body></body></html>",
      ),
    ]);
    expect(bad.status).toBe("warn");
    expect(bad.items?.[0]?.label).toContain('"click here"');
  }, 30_000);

  test("any dropped pair turns the only-anchor escalation off and is reported", () => {
    const build = (maxPairs: number) => {
      const b = new AnchorGraphBuilder(maxPairs);
      b.addPage(BASE, {
        title: "Home",
        links: [body("/engage", "how I work"), body("/other", "how I work")],
        status: 200,
      });
      b.addPage("https://example.com/engage", { title: "Engage a consultant", status: 200 });
      b.addPage("https://example.com/other", { title: "Other", status: 200 });
      return evaluateAnchorGraph(b.build(), BASE, [], false);
    };
    expect(build(10).message).toContain("only contextual anchor text");
    const capped = build(1);
    expect(capped.status).toBe("warn");
    expect(capped.message).not.toContain("only contextual anchor text");
    expect((capped.details as { droppedPairs: number }).droppedPairs).toBe(1);
  });

  test("a truncated token list never yields a definitive warning", () => {
    const filler = Array.from(
      { length: 300 },
      (_, i) => `filler${String.fromCharCode(97 + (i % 26))}${i}`,
    ).join(" ");
    const pages = (anchor: string): PageSpec[] => [
      { ...HOME, links: [body("/freezer", anchor), body("/fridge", "Fridge")] },
      { url: "https://example.com/freezer", title: "Freezer repairs" },
      { url: "https://example.com/fridge", title: "Fridge repairs" },
    ];
    const c = check(pages(`${filler} freezer`));
    expect(c.status).toBe("pass");
    const d = c.details as { judged: number; notJudged: number };
    expect(d.notJudged).toBe(1);
    // Without truncation the same mismatch warns.
    expect(check(pages("click here")).status).toBe("warn");
  });

  test("the token budget truncates too, and a refused pair leaves no bucket", () => {
    const b = new AnchorGraphBuilder(1, 1_000);
    const links = Array.from({ length: 100 }, (_, i) => body(`/t${i}`, "x word"));
    b.addPage(BASE, { title: "Home", links, status: 200 });
    for (let i = 0; i < 100; i++)
      b.addPage(`https://example.com/t${i}`, { title: "T", status: 200 });
    const internals = b as unknown as { pairs: Map<string, unknown>; dropped: number };
    expect(internals.pairs.size).toBe(1);
    expect(b.build().droppedPairs).toBe(99);

    const small = new AnchorGraphBuilder(10, 2);
    small.addPage(BASE, { title: "Home", links: [body("/a", "alpha beta gamma")], status: 200 });
    small.addPage("https://example.com/a", { title: "Zeta", status: 200 });
    expect(small.build().pairs[0]).toMatchObject({ truncated: true, tokens: ["alpha", "beta"] });
  });

  test("mixed-script anchor or target title is not judged", () => {
    const mixedAnchor = check([
      { ...HOME, links: [body("/services", "お問い合わせ Contact us")] },
      { url: "https://example.com/services", title: "サービス一覧" },
    ]);
    expect(mixedAnchor.status).toBe("skipped");
    const jaTitle = check([
      { ...HOME, links: [body("/p/123", "Read article")] },
      { url: "https://example.com/p/123", title: "東京の旅行ガイド" },
    ]);
    expect(jaTitle.status).toBe("skipped");
    const latinAnchorJaTitleSlug = check([
      { ...HOME, links: [body("/services", "Services")] },
      { url: "https://example.com/services", title: "サービス一覧" },
    ]);
    expect(latinAnchorJaTitleSlug.status).toBe("skipped");
    expect(meaningfulTokens("Łódź Øre Straße Æble")).toEqual(["lodz", "ore", "strasse", "aeble"]);
  });

  test("only 2xx HTML targets are judged", () => {
    const base: PageSpec[] = [
      {
        ...HOME,
        links: [body("/gone", "click here"), body("/f", "click here"), body("/pdf", "click here")],
      },
    ];
    const c = ctx([
      ...base,
      { url: "https://example.com/gone", title: "404 Not Found" },
      { url: "https://example.com/f", title: "Moved" },
      { url: "https://example.com/pdf", title: "Brochure" },
    ]);
    const pages = (
      c.site as {
        pages: Array<{ url: string; statusCode: number; headers?: Record<string, string> }>;
      }
    ).pages;
    pages[1]!.statusCode = 404;
    pages[2]!.statusCode = 301;
    pages[3]!.headers = { "content-type": "application/pdf" };
    const out = (anchorMismatchRule.run(c) as { checks: CheckResult[] }).checks[0]!;
    expect(out.status).toBe("skipped");
    expect((out.details as { notJudged: number }).notJudged).toBe(3);
  });

  test("fragment links, pagination and nofollow links are not compared", () => {
    const c = check([
      {
        ...HOME,
        links: [
          body("/docs/api#authentication", "Authentication"),
          { ...body("/blog/page/2", "Older"), rel: ["next"] },
          body("/archive/page/3", "More"),
          body("/list?page=4", "Next"),
          { url: "/promo", text: "click here", isInternal: true, isNofollow: true },
          body("/fridge", "Fridge"),
        ],
      },
      { url: "https://example.com/docs/api", title: "API reference" },
      { url: "https://example.com/blog/page/2", title: "Blog archive" },
      { url: "https://example.com/archive/page/3", title: "Archive" },
      { url: "https://example.com/list", title: "Listing" },
      { url: "https://example.com/promo", title: "Promotion" },
      { url: "https://example.com/fridge", title: "Fridge repairs" },
    ]);
    expect(c.status).toBe("pass");
    expect((c.details as { judged: number }).judged).toBe(1);
  });

  test("two different long anchors stay two anchors for the only-anchor escalation", () => {
    const prefix = "filler ".repeat(25);
    const c = check([
      { ...HOME, links: [body("/engage", `${prefix} alpha`)] },
      { url: "https://example.com/a", title: "Alpha", links: [body("/engage", `${prefix} beta`)] },
      { url: "https://example.com/engage", title: "Engage a consultant" },
    ]);
    expect(c.status).toBe("warn");
    expect(c.message).not.toContain("only contextual anchor text");
  });

  test("a card glued by CSS the parse cannot see does not create a warning", () => {
    const glued = { url: "/freezers", text: "Freezerrepairs", isInternal: true, textGlued: true };
    const pages = (link: LinkData): PageSpec[] => [
      { ...HOME, links: [link, body("/fridge", "Fridge")] },
      { url: "https://example.com/freezers", title: "Commercial freezer repairs" },
      { url: "https://example.com/fridge", title: "Fridge repairs" },
    ];
    expect(check(pages(glued)).status).toBe("pass");
    // The same text not flagged as glued is a mismatch.
    expect(check(pages({ ...glued, textGlued: false })).status).toBe("warn");
  });

  test("a bare numeric slug with no title is not judged", () => {
    const c = check([
      { ...HOME, links: [body("/p/123", "Read article"), body("/fridge", "Fridge")] },
      { url: "https://example.com/p/123" },
      { url: "https://example.com/fridge", title: "Fridge repairs" },
    ]);
    expect(c.status).toBe("pass");
    expect(c.details as { judged: number; notJudged: number }).toMatchObject({
      judged: 1,
      notJudged: 1,
    });
  });

  test("refused pairs are counted once each, and uncrawled targets use no capacity", () => {
    const b = new AnchorGraphBuilder(
      1,
      1_000,
      new Set(["https://example.com/", "https://example.com/a", "https://example.com/b"]),
    );
    b.addPage(BASE, {
      title: "Home",
      status: 200,
      links: [
        body("/a", "alpha"),
        body("/gone1", "x"),
        body("/gone2", "x"),
        body("/b", "beta"),
        body("/b", "beta"),
        body("/b", "beta"),
      ],
    });
    b.addPage("https://example.com/a", { title: "A", status: 200 });
    b.addPage("https://example.com/b", { title: "B", status: 200 });
    const graph = b.build();
    expect(graph.pairs).toHaveLength(1);
    expect(graph.droppedPairs).toBe(1);
  });

  test("a title is clipped and the H1 count capped when stored", () => {
    const b = new AnchorGraphBuilder();
    b.addPage(BASE, {
      title: "t".repeat(5_000),
      h1: Array.from({ length: 50 }, () => "h"),
      status: 200,
    });
    const page = b.build().pages.get(BASE)!;
    expect(page.title!.length).toBe(300);
    expect(page.h1).toHaveLength(5);
  });

  test("pages that differ only by query are separate targets", () => {
    const c = check([
      {
        url: BASE,
        title: "Home",
        links: [body("/p?id=1", "Red apple"), body("/p?id=2", "Blue car")],
      },
      { url: "https://example.com/p?id=1", title: "Red apple" },
      { url: "https://example.com/p?id=2", title: "Blue car" },
    ]);
    expect(c.status).toBe("pass");
    expect((c.details as { judged: number }).judged).toBe(2);
  });

  test("the full title and every H1 are tokenised, not the clipped copies", () => {
    const longTitle = `${"word ".repeat(70)}carpentry`;
    const longTitleCheck = check([
      { ...HOME, links: [body("/c", "carpentry"), body("/fridge", "Fridge")] },
      { url: "https://example.com/c", title: longTitle },
      { url: "https://example.com/fridge", title: "Fridge repairs" },
    ]);
    expect(longTitleCheck.status).toBe("pass");
    expect((longTitleCheck.details as { judged: number }).judged).toBe(2);

    const sixthH1 = check([
      { ...HOME, links: [body("/c", "carpentry"), body("/fridge", "Fridge")] },
      {
        url: "https://example.com/c",
        title: "Services",
        h1: ["a1", "b2", "c3", "d4", "e5", "Carpentry"],
      },
      { url: "https://example.com/fridge", title: "Fridge repairs" },
    ]);
    expect(sixthH1.status).toBe("pass");

    const repeated = check([
      { ...HOME, links: [body("/p/123", "Freezer"), body("/fridge", "Fridge")] },
      { url: "https://example.com/p/123", title: `${"Company services ".repeat(25)}Freezer` },
      { url: "https://example.com/fridge", title: "Fridge repairs" },
    ]);
    expect(repeated.status).toBe("pass");
  });

  test("a title cut off by the word cap is not judged when nothing matched", () => {
    const words = Array.from(
      { length: 100 },
      (_, i) => `term${String.fromCharCode(97 + (i % 26))}${i}x`,
    );
    const c = check([
      { ...HOME, links: [body("/t", "click here"), body("/fridge", "Fridge")] },
      { url: "https://example.com/t", title: words.join(" ") },
      { url: "https://example.com/fridge", title: "Fridge repairs" },
    ]);
    expect(c.status).toBe("pass");
    expect(c.details as { judged: number; notJudged: number }).toMatchObject({
      judged: 1,
      notJudged: 1,
    });
  });

  test("an over-long word is dropped and the pair is not judged; the character budget bites", () => {
    const huge = "x".repeat(5_000);
    const c = check([
      { ...HOME, links: [body("/freezers", `${huge} thing`), body("/fridge", "Fridge")] },
      { url: "https://example.com/freezers", title: "Commercial freezer repairs" },
      { url: "https://example.com/fridge", title: "Fridge repairs" },
    ]);
    expect(c.status).toBe("pass");
    expect((c.details as { notJudged: number }).notJudged).toBe(1);
    expect(tokenize(`${huge} word`)).toEqual({ tokens: ["word"], joined: [], lost: true });

    const b = new AnchorGraphBuilder(10, 1_000, undefined, 6);
    b.addPage(BASE, { title: "Home", links: [body("/a", "alpha beta gamma")], status: 200 });
    b.addPage("https://example.com/a", { title: "Zeta", status: 200 });
    const pair = b.build().pairs[0]!;
    expect(pair.truncated).toBe(true);
    expect(pair.tokens.join("").length).toBeLessThanOrEqual(6);
  });

  test("a two-character brand in a glued card matches through the card's own pieces", () => {
    const glued = {
      url: "/brands/lg",
      text: "LGSee details",
      isInternal: true,
      textGlued: true,
      textParts: ["LG", "See details"],
    };
    const pages = (link: LinkData): PageSpec[] => [
      { ...HOME, links: [link, body("/fridge", "Fridge")] },
      { url: "https://example.com/brands/lg", title: "LG" },
      { url: "https://example.com/fridge", title: "Fridge repairs" },
    ];
    expect(check(pages(glued)).status).toBe("pass");
    expect(check(pages({ ...glued, textParts: undefined })).status).toBe("warn");
  });

  test("a glued card whose stored part was clipped is not judged unless a word matched", () => {
    const head = `${"item ".repeat(50)}LG`;
    const glued = (parts: string[]): LinkData => ({
      url: "/brands/lg",
      text: `${head}See details`,
      isInternal: true,
      textGlued: true,
      textParts: parts,
    });
    const pages = (link: LinkData): PageSpec[] => [
      { ...HOME, links: [link, body("/fridge", "Fridge")] },
      { url: "https://example.com/brands/lg", title: "LG" },
      { url: "https://example.com/fridge", title: "Fridge repairs" },
    ];
    // The parser cut the first part at 200 characters: "LG" was in the lost tail.
    const clipped = check(pages(glued([head.slice(0, MAX_ANCHOR_PART_LENGTH), "See details"])));
    expect(clipped.status).toBe("pass");
    expect((clipped.details as { notJudged: number }).notJudged).toBe(1);
    // A part that fits in full is complete evidence, so the same pair warns.
    expect(check(pages(glued(["item", "See details"]))).status).toBe("warn");
    // A list at the part cap may have dropped later parts.
    const full = Array.from({ length: MAX_ANCHOR_PARTS }, (_, i) => `piece${String.fromCharCode(97 + i)}`);
    expect(check(pages(glued(full))).status).toBe("pass");
    // A clipped part that still holds the match is a judged pair.
    const matched = check(pages(glued([`LG ${head}`.slice(0, MAX_ANCHOR_PART_LENGTH), "See details"])));
    expect((matched.details as { judged: number }).judged).toBe(2);
  });

  test("a front door path with a query string is a page, not the homepage", () => {
    for (const target of ["/?p=123", "/?page_id=5"]) {
      const c = check([
        { ...HOME, links: [body(target, "click here")] },
        { url: `https://example.com${target}`, title: "Freezer repairs" },
      ]);
      expect(c.status).toBe("warn");
    }
    // The bare front door, and an entry page that carries a query, stay unjudged.
    const home = check([
      { ...HOME, links: [body("/", "click here"), body("/about", "About")] },
      { url: "https://example.com/about", title: "About us" },
    ]);
    expect(home.status).toBe("pass");
    const entry = check(
      [
        { ...HOME, links: [body("/?lang=en", "click here"), body("/about", "About")] },
        { url: "https://example.com/?lang=en", title: "Freezer repairs" },
        { url: "https://example.com/about", title: "About us" },
      ],
      { entryUrls: ["https://example.com/?lang=en"] },
    );
    expect(entry.status).toBe("pass");
  });

  test("?p=123 is a real WordPress permalink, not pagination", () => {
    const c = check([
      { ...HOME, links: [body("/blog?p=123", "click here")] },
      { url: "https://example.com/blog?p=123", title: "Freezer maintenance" },
    ]);
    expect(c.status).toBe("warn");
  });

  test("blank and stop-word-only anchors do not hide the only-anchor escalation", () => {
    const c = check([
      { ...HOME, links: [body("/engage", "how I work")] },
      { url: "https://example.com/a", title: "Alpha", links: [body("/engage", "")] },
      { url: "https://example.com/b", title: "Beta", links: [body("/engage", "the")] },
      { url: "https://example.com/engage", title: "Engage a consultant" },
    ]);
    expect(c.status).toBe("warn");
    expect(c.message).toContain("only contextual anchor text");
  });
});

describe("links/anchor-mismatch compounds and listing labels (#1626)", () => {
  test("Handschuhe -> Fahrradhandschuhe does not warn (suffix compound)", () => {
    const c = check([
      { ...HOME, links: [body("/gloves", "Handschuhe")] },
      { url: "https://example.com/gloves", title: "Fahrradhandschuhe" },
    ]);
    expect(c.status).toBe("pass");
  });

  test("the target's word inside a longer anchor word is not a compound match", () => {
    const c = check([
      { ...HOME, links: [body("/gloves", "Fahrradhandschuhe")] },
      { url: "https://example.com/gloves", title: "Handschuhe" },
    ]);
    expect(c.status).toBe("warn");
  });

  test("a short ending or a short prefix is not a compound", () => {
    expect(tokensMatch("care", "healthcare")).toBe(false);
    const c = check([
      { ...HOME, links: [body("/health", "Care")] },
      { url: "https://example.com/health", title: "Healthcare plans" },
    ]);
    expect(c.status).toBe("warn");
    // A two-character prefix is too little in front of the ending.
    expect(tokensMatch("shoes", "ab" + "shoes")).toBe(false);
    const d = check([
      { ...HOME, links: [body("/x", "Shoes")] },
      { url: "https://example.com/x", title: "Abshoes" },
    ]);
    expect(d.status).toBe("warn");
  });

  test("Alle Artikel -> an article listing is not judged, not a mismatch", () => {
    const c = check([
      { ...HOME, links: [body("/articles", "Alle Artikel"), body("/gloves", "Handschuhe")] },
      { url: "https://example.com/articles", title: "Tipps & Tricks rund ums Radfahren" },
      { url: "https://example.com/gloves", title: "Fahrradhandschuhe" },
    ]);
    expect(c.status).toBe("pass");
    const details = c.details as { judged: number; notJudged: number };
    expect(details.judged).toBe(1);
    expect(details.notJudged).toBe(1);
  });

  test("View all posts -> /blog is not judged; alone it skips rather than passes", () => {
    const c = check([
      { ...HOME, links: [body("/blog", "View all posts")] },
      { url: "https://example.com/blog", title: "Notes from the workshop" },
    ]);
    expect(c.status).toBe("skipped");
    expect((c.details as { notJudged: number }).notJudged).toBe(1);
  });

  test("a listing label pointing at a page that is not a listing still warns", () => {
    const c = check([
      { ...HOME, links: [body("/gloves", "Alle Artikel")] },
      { url: "https://example.com/gloves", title: "Fahrradhandschuhe" },
    ]);
    expect(c.status).toBe("warn");
  });

  test("positive control: an unrelated visible anchor on a listing page still warns", () => {
    const c = check([
      { ...HOME, links: [body("/articles", "Gartenmoebel")] },
      { url: "https://example.com/articles", title: "Tipps & Tricks rund ums Radfahren" },
    ]);
    expect(c.status).toBe("warn");
  });

  test("a listing word mixed with an unrelated word is still judged", () => {
    const c = check([
      { ...HOME, links: [body("/articles", "Gartenmoebel Artikel")] },
      { url: "https://example.com/articles", title: "Tipps & Tricks rund ums Radfahren" },
    ]);
    expect(c.status).toBe("warn");
  });

  test("one article under a listing section is a real target, so a listing label still warns", () => {
    const cases: [string, string, string][] = [
      ["View all posts", "/blog/how-to-fix-roof", "How to fix a roof"],
      ["Alle Artikel", "/news/acme-acquires-foo", "Acme acquires Foo"],
      ["More news", "/products/blog-widget", "Blog widget"],
    ];
    for (const [text, path, title] of cases) {
      const c = check([
        { ...HOME, links: [body(path, text)] },
        { url: `https://example.com${path}`, title },
      ]);
      expect(c.status).toBe("warn");
    }
  });

  test("a listing may carry a page number or a trailing slash (/page/N is dropped before this as pagination)", () => {
    for (const path of ["/blog/", "/blog/2", "/articles.html", "/en/news"]) {
      const c = check([
        { ...HOME, links: [body(path, "View all posts")] },
        { url: `https://example.com${path}`, title: "Notes from the workshop" },
      ]);
      expect([path, (c.details as { notJudged: number }).notJudged]).toEqual([path, 1]);
    }
  });

  // Known limitation: the anchor graph carries no page language, so the compound match is not
  // gated to compounding languages and English look-alikes pass too.
  test("known limitation: English suffix look-alikes match as compounds", () => {
    for (const [text, title] of [
      ["Press", "Compress images"],
      ["Stand", "Understand taxes"],
      ["Board", "Dashboard tour"],
    ] as const) {
      const c = check([
        { ...HOME, links: [body("/t", text)] },
        { url: "https://example.com/t", title },
      ]);
      expect(c.status).toBe("pass");
    }
  });
});
