// #1565: the collected page signal is kept until the site rules run, so its fields must not keep the pages they were read from.
// scriptSrcs, fingerprint and anchors hold attribute values and text cut from the page, and a cut keeps its parent alive.
// Measured with a forced GC and no timing: the heap kept for N pages' field stays near the heap of parsing alone.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { buildCollectedPageSignal, detachAnchors, detachFingerprint, detachHreflang } from "../src/collected-signals";
import { pageScriptSrcs } from "../src/adblock/blocked-links";
import { buildHreflangSignal } from "../src/i18n/hreflang-signal";
import { fingerprintPage, type PageFingerprint } from "../src/integrity/fingerprint";
import type { HreflangPageSignal } from "../src/i18n/hreflang-signal";
import { buildPageAnchorSignal, type PageAnchorSignal } from "../src/links/page-anchors";
import { detachedList } from "../src/shared/detach";

const PAGES = 100;
const PAD = 2_000_000;
const MARGIN_MB = 12;
const url = (i: number) => `https://shop.example/p${i}`;

/** A page of small attribute values inside about 1 MB of comment padding and inline script. */
function page(i: number): string {
  const pad = `<!-- ${"padding ".repeat(Math.floor(PAD / 8))}-->`;
  const script = `<script>var filler="${"x".repeat(PAD / 4)}";</script>`;
  const anchors = Array.from({ length: 30 }, (_, k) => `<h2 id="sec-${i}-${k}">S</h2><a href="#sec-${i}-${k}">go</a>`).join("");
  const scripts = Array.from({ length: 20 }, (_, k) => `<script src="https://cdn${k}.example/p${i}/app-${k}.js"></script>`).join("");
  return `<!doctype html><html><head><title>P${i}</title><link rel="stylesheet" href="https://static.example/p${i}/theme.css"><style>:root{--brand-${i}:red}</style>${scripts}</head><body class="theme-${i} wide">${pad}${script}<nav>n</nav>${anchors}<footer>f</footer></body></html>`;
}

/** About 1 MB of comment around many small values: 500 ids and fragments, 100 stylesheets, css variables and body classes, 100 scripts. */
function heavyPage(i: number): string {
  const pad = `<!-- ${"padding ".repeat(1_000_000 / 8)}-->`;
  const n = 100;
  const links = Array.from({ length: n }, (_, k) => `<link rel="stylesheet" href="https://static.example/p${i}/theme-${k}.css">`).join("");
  const vars = Array.from({ length: n }, (_, k) => `--v${i}-${k}:1;`).join("");
  const scripts = Array.from({ length: n }, (_, k) => `<script src="https://cdn${k}.example/p${i}/app-${k}.js"></script>`).join("");
  const classes = Array.from({ length: 50 }, (_, k) => `c${i}-${k}`).join(" ");
  const anchors = Array.from({ length: 500 }, (_, k) => `<h2 id="section-heading-${i}-${k}">S</h2><a href="#section-heading-${i}-${k}">go</a><a name="legacy-${i}-${k}"></a>`).join("");
  const alternates = Array.from({ length: n }, (_, k) => `<link rel="alternate" hreflang="x-${k}" href="https://alt${k}.example/p${i}/page-${k}">`).join("");
  return `<!doctype html><html><head><title>P${i}</title>${links}${alternates}<style>:root{${vars}}</style>${scripts}</head><body class="${classes}">${pad}<nav>n</nav>${anchors}<footer>f</footer></body></html>`;
}

const heapMb = (): number => {
  Bun.gc(true);
  Bun.gc(true);
  return process.memoryUsage().heapUsed / 1_048_576;
};

type Extract = (parsed: ReturnType<typeof parsePage>, i: number) => unknown;
const raw: Record<string, Extract> = {
  scriptSrcs: (p) => pageScriptSrcs(p.document!),
  fingerprint: (p, i) => fingerprintPage(p, url(i)),
  anchors: (p) => buildPageAnchorSignal({ parsed: p, rendered: false }),
  hreflang: (p, i) => buildHreflangSignal(p, {}, url(i)),
};
const copied: Record<string, Extract> = {
  scriptSrcs: (p, i) => detachedList(raw.scriptSrcs!(p, i) as string[]),
  fingerprint: (p, i) => detachFingerprint(raw.fingerprint!(p, i) as PageFingerprint),
  anchors: (p, i) => detachAnchors(raw.anchors!(p, i) as PageAnchorSignal),
  hreflang: (p, i) => detachHreflang(raw.hreflang!(p, i) as HreflangPageSignal),
};

/** Heap kept by holding `extract`'s result for PAGES freshly parsed pages (the document itself is dropped each time). */
function retained(extract: Extract, build: (i: number) => string = page): number {
  for (let i = 0; i < 10; i++) extract(parsePage(build(i), url(i)), i);
  const base = heapMb();
  const kept: unknown[] = [];
  for (let i = 0; i < PAGES; i++) kept.push(extract(parsePage(build(i), url(i)), i));
  const grown = heapMb() - base;
  expect(kept.length).toBe(PAGES);
  return grown;
}

/** Heap kept by holding nothing of the page but its index: what parsing N padded pages alone leaves behind. */
let parseOnlyMb: number | undefined;
/** Measured once per file: the baseline does not depend on the field, so each field compares against the same number. */
const parseOnly = (): number => (parseOnlyMb ??= retained((_p, i) => i));

// The collector's secrets scan serialises the document first, which flattens attribute strings, so a build through
// `buildCollectedPageSignal` hides most of this on some engine versions. Measuring the fields off an unserialised document
// shows what the copy is for. Each field is held to the parse-only heap (plus a margin for the copy's own strings), and the raw
// extractor is the control that the fixture can see retention at all, so removing a copy fails its own test.
describe("a collected signal field does not keep its page", () => {
  for (const field of ["scriptSrcs", "fingerprint", "anchors", "hreflang"]) {
    test(`${field}: the copy keeps close to the parse-only heap, the uncopied field keeps clearly more`, () => {
      const base = parseOnly();
      const copy = retained(copied[field]!, heavyPage);
      const uncopied = retained(raw[field]!, heavyPage);
      const floor = Math.max(base, 0);
      const msg = `${field}: parse-only ${base.toFixed(1)} MB, copy ${copy.toFixed(1)} MB, uncopied ${uncopied.toFixed(1)} MB`;
      expect(copy, msg).toBeLessThan(floor + MARGIN_MB);
      expect(uncopied, msg).toBeGreaterThan(copy + MARGIN_MB);
    }, 300_000);
  }

  test("the collector's record carries the copied fields", () => {
    const html = page(1);
    const signal = buildCollectedPageSignal({ url: url(1), parsed: parsePage(html, url(1)), htmlBytes: html.length });
    expect(signal.scriptSrcs.length).toBe(20);
    expect(signal.anchors?.ids.length).toBe(30);
    expect(signal.fingerprint?.stylesheetHrefs.size).toBe(1);
    expect(signal.hreflang).toBeDefined();
  }, 30_000);
});

describe("the copy is the same record", () => {
  test("a lone surrogate in a script source, anchor id and class survives; the values match a second build", () => {
    const lone = String.fromCharCode(0xd83d);
    const html = `<!doctype html><html><head><script src="https://a.example/x${lone}.js"></script></head><body class="c${lone}"><h2 id="i${lone}">h</h2><nav>n</nav><footer>f</footer></body></html>`;
    const a = buildCollectedPageSignal({ url: url(1), parsed: parsePage(html, url(1)), htmlBytes: html.length });
    const b = buildCollectedPageSignal({ url: url(1), parsed: parsePage(html, url(1)), htmlBytes: html.length });
    expect(a.scriptSrcs.some((s) => s.includes(lone))).toBe(true);
    expect([...(a.fingerprint?.bodyClasses ?? [])].some((s) => s.includes(lone))).toBe(true);
    expect((a.anchors?.ids ?? []).some((s) => s.includes(lone))).toBe(true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.fingerprint?.hasNav).toBe(true);
  });

  test("a fingerprint handed in is kept as handed in; one computed here is a copy of the extractor's", () => {
    const html = `<!doctype html><html><body class="a b"><nav>n</nav></body></html>`;
    const parsed = parsePage(html, url(3));
    const computed = buildCollectedPageSignal({ url: url(3), parsed, htmlBytes: 1 }).fingerprint!;
    // the streaming loop detaches the shared fingerprint where it builds it, so the collector must not copy it again
    const out = buildCollectedPageSignal({ url: url(3), parsed, htmlBytes: 1, fingerprint: computed });
    expect(out.fingerprint).toBe(computed);
    // one computed in here is a new object with the same values as the extractor's
    const again = buildCollectedPageSignal({ url: url(3), parsed, htmlBytes: 1 }).fingerprint!;
    expect(again).not.toBe(computed);
    expect([...again.bodyClasses]).toEqual([...computed.bodyClasses]);
  });
});
