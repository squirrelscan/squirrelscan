// #1864: no rule reads an inline script's text more than once per page.
//
// On a script-heavy page most of the HTML is inline script, so a rule that reads
// each script AND the whole page (serialised, or as the text of an element that
// holds the scripts) pays for that text twice. This counts, for every page rule
// and every page-time collector extractor run on its own fresh copy of a page,
// how many times each inline script's text is taken out of the DOM: through the
// script itself (`textContent`, `innerHTML`, `outerHTML`, `innerText`, `text`,
// `toString()`), or through an ancestor or the document being serialised or
// having its text read. A read made inside another one (the DOM serialising a
// child) counts once, as the outer read.
//
// The raw HTML string (`ctx.page.html`) is not counted here: reading a property
// of a string cannot be told apart from scanning it. The rules that scan the raw
// HTML and also read script text were reviewed by hand (perf/js-libraries now
// blanks the script bodies out of its HTML-marker pass).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import { hasJavaScriptDetections } from "@squirrelscan/utils/cdn";

import { pageScriptSrcs } from "../src/adblock/blocked-links";
import { scanPageForMisspellings } from "../src/content/common-misspellings";
import { fingerprintForPage } from "../src/content/duplicate-content";
import { fingerprintPage } from "../src/integrity/fingerprint";
import { detectPageSignals } from "../src/integrity/signals";
import { hasCommercialOfferLink, matchSubprocessorLink } from "../src/legal/subprocessor-disclosure";
import { buildPageAnchorSignal } from "../src/links/page-anchors";
import { loadAllRules } from "../src/loader";
import { extractPageByteSignal } from "../src/performance/total-byte-weight";
import { scanPageBounded } from "../src/security/leaked-secrets";
import { extractContentSentences } from "../src/shared/content-in-script";
import { buildInPageSectionSignal } from "../src/shared/inpage-section";
import type { ParsedPage, RuleContext } from "../src/types";

const URL_ = "https://store.example.com/products/insole";

const bundle = (seed: string, kb: number) =>
  Array.from({ length: kb * 20 }, (_, i) => `function ${seed}${i}(a,b){return a?b(a):null}`).join("");

// Scripts in the head, the body, nested in containers, before the first heading,
// a JSON-LD block and a JSON data block, an external script, and a Shopify-shaped
// token under a generic key on a page whose markup loads from the Shopify CDN.
const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Gel Insole | Store</title>
<meta name="description" content="A comfortable gel insole for daily wear.">
<link rel="stylesheet" href="https://cdn.shopify.com/s/files/1/0001/theme.css">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Gel Insole","author":{"@type":"Person","name":"A"}}</script>
<script id="shopify-features" type="application/json">{"accessToken":"0123456789abcdef0123456789abcdef","locale":"en"}</script>
<script>/*! jQuery v3.6.0 */window.dataLayer=window.dataLayer||[];${bundle("h", 4)}</script>
<script src="https://cdn.example.com/app.js"></script>
</head><body><header><a href="#main" class="skip-link">Skip to content</a><nav><a href="/a">A</a> <a href="/b">B</a></nav></header>
<main id="main"><div class="wrap"><script>var early=1;${bundle("e", 1)}</script><h1>Gel Insole</h1>
<h2>Why it helps</h2><p>Copyright 2020. Our insoles support the arch and cushion the heel all day.</p>
<div class="cookie-banner"><p>We use cookies.</p><button>Accept</button></div>
<script>
  // readable theme code
  function toggle(el) {
    el.classList.toggle("open");
  }
</script></div></main>
<footer><p>Footer text</p><a href="/policies/privacy-policy">Privacy policy</a></footer>
<script>gtag('config','G-ABC123');${bundle("b", 8)}</script>
<script>window.__cfg={theme:"dawn",access_token:"${"0123456789abcdef".repeat(2)}"};</script></body></html>`;

type Counter = { counts: Map<Element, number> };

/** Instruments a fresh document: every read of an inline script's text, direct or through an ancestor, bumps a count. */
function instrument(doc: Document): Counter {
  const counts = new Map<Element, number>();
  const scripts = Array.from(doc.querySelectorAll("script")).filter(
    (s) => !s.hasAttribute("src") && (s.textContent ?? "").trim() !== ""
  );
  let depth = 0;
  const bump = (root: Node) => {
    if (depth > 0) return;
    for (const s of scripts) {
      if (root === s || root === doc || root.contains(s)) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  };
  const find = (obj: object, prop: string): PropertyDescriptor | undefined => {
    for (let p: object | null = obj; p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, prop);
      if (d) return d;
    }
    return undefined;
  };
  const targets = new Set<Node>([doc, ...scripts]);
  for (const s of scripts) for (let p = s.parentNode; p; p = p.parentNode) targets.add(p);
  for (const node of targets) {
    for (const prop of ["textContent", "innerHTML", "outerHTML", "innerText", "text"]) {
      const d = find(node, prop);
      if (!d?.get) continue;
      Object.defineProperty(node, prop, {
        configurable: true,
        get() {
          bump(node);
          depth++;
          try {
            return d.get!.call(node);
          } finally {
            depth--;
          }
        },
        set(v) {
          d.set?.call(node, v);
        },
      });
    }
    const toString = find(node, "toString")!.value as () => string;
    Object.defineProperty(node, "toString", {
      configurable: true,
      writable: true,
      value() {
        bump(node);
        depth++;
        try {
          return toString.call(node);
        } finally {
          depth--;
        }
      },
    });
  }
  expect(scripts.length).toBeGreaterThanOrEqual(5);
  return { counts };
}

const worst = (c: Counter) => Math.max(0, ...c.counts.values());

describe("#1864: each inline script's text is read at most once per rule per page", () => {
  test("every page rule", async () => {
    const offenders: string[] = [];
    let ran = 0;
    for (const rule of loadAllRules().values()) {
      if (rule.meta.scope !== "page") continue;
      const parsed = parsePage(PAGE, URL_) as ParsedPage;
      const counter = instrument(parsed.document!);
      const options = rule.meta.optionsSchema ? (rule.meta.optionsSchema.parse({}) as Record<string, unknown>) : {};
      const ctx: RuleContext = {
        page: { url: URL_, html: PAGE, statusCode: 200, loadTime: 0, headers: { "content-type": "text/html" } },
        parsed,
        options,
      };
      await rule.run(ctx);
      ran++;
      if (worst(counter) > 1) offenders.push(`${rule.meta.id} read a script ${worst(counter)} times`);
    }
    expect(ran).toBeGreaterThan(200);
    expect(offenders).toEqual([]);
  });

  // The page-time collector's extractors, each one a rule's per-page work (collected-signals.ts).
  const EXTRACTORS: Record<string, (parsed: ParsedPage) => unknown> = {
    "security/leaked-secrets": (p) => scanPageBounded(p.document!, URL_),
    "perf/total-byte-weight": (p) => extractPageByteSignal(p.document!),
    "integrity/template-discontinuity": (p) => fingerprintPage(p, URL_),
    "integrity/orphan-page": (p) => [...detectPageSignals({ parsed: p, page: { url: URL_ } })],
    "adblock/blocked-links": (p) => pageScriptSrcs(p.document!),
    "legal/subprocessor-disclosure": (p) => [matchSubprocessorLink(p.document!, URL_), hasCommercialOfferLink(p.document!)],
    "links/broken-anchors": (p) => buildPageAnchorSignal({ parsed: p, rendered: false }),
    "eeat/about-page": (p) => buildInPageSectionSignal(p.document!),
    "content/common-misspellings": (p) => scanPageForMisspellings(p.document!),
    "perf/content-in-js-bundle": (p) => extractContentSentences(p.document!),
    "perf/bad-caching": (p) => hasJavaScriptDetections(p.document!),
    "content/duplicate-content": (p) => fingerprintForPage(p.document!, URL_, undefined),
  };

  for (const [id, extract] of Object.entries(EXTRACTORS)) {
    test(`collector: ${id}`, () => {
      const parsed = parsePage(PAGE, URL_) as ParsedPage;
      const counter = instrument(parsed.document!);
      extract(parsed);
      expect(worst(counter)).toBeLessThanOrEqual(1);
    });
  }

  // The one read past the first, by design: a Shopify-shaped token under a generic key is public on a page that loads
  // from the Shopify CDN, and a page whose markup does not is asked again with its scripts in, exactly as before.
  test("leaked-secrets reads the scripts again only to settle a Shopify token on a page whose markup has no Shopify CDN", () => {
    const page = PAGE.replace(/<link rel="stylesheet" href="https:\/\/cdn\.shopify\.com[^>]*>/, "");
    expect(page).not.toContain("cdn.shopify.com");
    const parsed = parsePage(page, URL_) as ParsedPage;
    const counter = instrument(parsed.document!);
    scanPageBounded(parsed.document!, URL_);
    expect(worst(counter)).toBe(2);
  });

  test("the counter sees a second read (it would have caught the old leaked-secrets and skip-link)", () => {
    const parsed = parsePage(PAGE, URL_) as ParsedPage;
    const doc = parsed.document!;
    const counter = instrument(doc);
    for (const s of doc.querySelectorAll("script")) void s.textContent;
    void doc.toString();
    expect(worst(counter)).toBe(2);
    const body = parsePage(PAGE, URL_).document!;
    const c2 = instrument(body);
    void body.querySelector("body")!.innerHTML;
    expect(worst(c2)).toBe(1);
  });
});
