// #1565: the collected page signal is kept until the site rules run, so its fields must not keep the pages they were read from.
// scriptSrcs, fingerprint and anchors hold attribute values and text cut from the page, and a cut keeps its parent alive.
// Measured with a forced GC and no timing: the heap kept for N pages' field stays near the heap of parsing alone.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { buildCollectedPageSignal, detachAnchors, detachFingerprint } from "../src/collected-signals";
import { pageScriptSrcs } from "../src/adblock/blocked-links";
import { fingerprintPage, type PageFingerprint } from "../src/integrity/fingerprint";
import { buildPageAnchorSignal, type PageAnchorSignal } from "../src/links/page-anchors";
import { detachedList } from "../src/shared/detach";

const PAGES = 100;
const PAD = 2_000_000;
const LIMIT_MB = 40;
const url = (i: number) => `https://shop.example/p${i}`;

/** A page of small attribute values inside about 1 MB of comment padding and inline script. */
function page(i: number): string {
  const pad = `<!-- ${"padding ".repeat(Math.floor(PAD / 8))}-->`;
  const script = `<script>var filler="${"x".repeat(PAD / 4)}";</script>`;
  const anchors = Array.from({ length: 30 }, (_, k) => `<h2 id="sec-${i}-${k}">S</h2><a href="#sec-${i}-${k}">go</a>`).join("");
  const scripts = Array.from({ length: 20 }, (_, k) => `<script src="https://cdn${k}.example/p${i}/app-${k}.js"></script>`).join("");
  return `<!doctype html><html><head><title>P${i}</title><link rel="stylesheet" href="https://static.example/p${i}/theme.css"><style>:root{--brand-${i}:red}</style>${scripts}</head><body class="theme-${i} wide">${pad}${script}<nav>n</nav>${anchors}<footer>f</footer></body></html>`;
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
};
const copied: Record<string, Extract> = {
  scriptSrcs: (p, i) => detachedList(raw.scriptSrcs!(p, i) as string[]),
  fingerprint: (p, i) => detachFingerprint(raw.fingerprint!(p, i) as PageFingerprint),
  anchors: (p, i) => detachAnchors(raw.anchors!(p, i) as PageAnchorSignal),
};

/** Heap kept by holding `extract`'s result for PAGES freshly parsed pages (the document itself is dropped each time). */
function retained(extract: Extract): number {
  for (let i = 0; i < 10; i++) extract(parsePage(page(i), url(i)), i);
  const base = heapMb();
  const kept: unknown[] = [];
  for (let i = 0; i < PAGES; i++) kept.push(extract(parsePage(page(i), url(i)), i));
  const grown = heapMb() - base;
  expect(kept.length).toBe(PAGES);
  return grown;
}

// The collector's secrets scan serialises the document first, which flattens attribute strings, so a build through
// `buildCollectedPageSignal` hides most of this on some engine versions. Measuring the fields off an unserialised document
// shows what the copy is for; the raw extractor is the control that the test can see retention at all.
describe("a collected signal field does not keep its page", () => {
  for (const field of ["scriptSrcs", "fingerprint", "anchors"]) {
    test(`${field}: the copy keeps under ${LIMIT_MB} MB of ${PAGES} pages of about ${(PAD * 1.25) / 1e6} MB each`, () => {
      const grown = retained(copied[field]!);
      expect(grown, `${field} copy kept ${grown.toFixed(1)} MB`).toBeLessThan(LIMIT_MB);
    }, 180_000);
  }

  test("control: the uncopied script sources do keep their pages", () => {
    const grown = retained(raw.scriptSrcs!);
    expect(grown, `raw kept ${grown.toFixed(1)} MB`).toBeGreaterThan(LIMIT_MB);
  }, 180_000);

  test("the collector's record carries the copied fields", () => {
    const html = page(1);
    const signal = buildCollectedPageSignal({ url: url(1), parsed: parsePage(html, url(1)), htmlBytes: html.length });
    expect(signal.scriptSrcs.length).toBe(20);
    expect(signal.anchors?.ids.length).toBe(30);
    expect(signal.fingerprint?.stylesheetHrefs.size).toBe(1);
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

  test("a fingerprint handed in is copied, not changed", () => {
    const html = `<!doctype html><html><body class="a b"><nav>n</nav></body></html>`;
    const parsed = parsePage(html, url(3));
    const given = buildCollectedPageSignal({ url: url(3), parsed, htmlBytes: 1 }).fingerprint!;
    const out = buildCollectedPageSignal({ url: url(3), parsed, htmlBytes: 1, fingerprint: given });
    expect(out.fingerprint).not.toBe(given);
    expect([...out.fingerprint!.bodyClasses]).toEqual([...given.bodyClasses]);
  });
});
