// #1583: a cover rule whose type selector or attribute carries a namespace separator (`*|iframe`, `|iframe`, `[*|id=x]`) is still
// a cover rule: Chrome applies these to an HTML iframe. A named namespace (`h|x`) needs an `@namespace` rule, so it stays doubtful.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePage } from "@squirrelscan/parser";

import { isCover, overlayGeometryFor, selectorListState } from "../src/integrity/overlay-style";
import { detectFakeAuthOverlay } from "../src/integrity/signals";
import type { RuleContext } from "../src/types";

const url = "https://example.com/";
const FIXED = "position:fixed;inset:0;z-index:9999;width:100%;height:100%";
const STATIC = "position:static";
const COVER_FRAME = '<iframe id="google-auth" class="cover" srcdoc=""></iframe>';
const NAMESPACE = "@namespace h url(http://www.w3.org/1999/xhtml);";

function parse(css: string) {
  const html = `<!doctype html><html><head><title>F</title><style>${css}</style></head><body><main><h1>F</h1>${COVER_FRAME}</main></body></html>`;
  return { html, parsed: parsePage(html, url) };
}
const fires = (css: string): boolean => {
  const { html, parsed } = parse(css);
  const ctx = { page: { url, html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} } as unknown as RuleContext;
  return detectFakeAuthOverlay(ctx) !== null;
};
/** The tokens reading only: the other two split nested rules at their first `}`. */
const nestedCover = (css: string): boolean => {
  const doc = parse(css).parsed.document!;
  const el = doc.querySelector("iframe")!;
  return (["decided", "all"] as const).some((mode) => isCover(overlayGeometryFor(doc, el, "tokens", mode)));
};

/** Selectors Chrome accepts and applies to the cover iframe above. */
const ACCEPTED = [
  "*|iframe.cover",
  "*|*.cover",
  "*|iframe[id=google-auth]",
  "*|iframe#google-auth",
  "[*|id=google-auth]",
  "[|id=google-auth]",
  "[ *|id = google-auth ]",
  "*|IFRAME.cover",
  "iframe[*|id=google-auth]",
  '.cover[*|id="google-auth" i]',
];

/** Accepted by Chrome but not applied to an HTML iframe (the no-namespace type): read as undecided, so never silent and never a hiding decoy. */
const ACCEPTED_NOT_APPLIED = ["|iframe.cover", "|*.cover", "|iframe#google-auth"];

/** Asks headless Chrome which selectors it accepts and which match the cover iframe; undefined when Chrome is not installed. */
function chromeVerdicts(selectors: readonly string[]): Record<string, { supported: boolean; matches: boolean }> | undefined {
  const bin = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => Bun.which(name) !== null);
  if (!bin) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "overlay-ns-"));
  try {
    const file = join(dir, "page.html");
    const script = `const out={};const f=document.querySelector('iframe');for(const s of ${JSON.stringify(selectors)}){let m=false;try{m=f.matches(s)}catch{}out[s]={supported:CSS.supports('selector('+s+')'),matches:m}}document.getElementById('r').textContent=JSON.stringify(out)`;
    writeFileSync(file, `<!doctype html><html><body>${COVER_FRAME}<pre id="r"></pre><script>${script}</script></body></html>`);
    const run = Bun.spawnSync([bin, "--headless=new", "--no-sandbox", "--disable-gpu", "--dump-dom", `file://${file}`], { stdout: "pipe", stderr: "ignore", timeout: 30_000 });
    const dom = run.stdout.toString();
    const match = /<pre id="r">([\s\S]*?)<\/pre>/.exec(dom);
    if (!match) return undefined;
    const json = match[1]!.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
    return JSON.parse(json) as Record<string, { supported: boolean; matches: boolean }>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a namespace separator on a type or an attribute does not keep a cover rule silent (#1583)", () => {
  for (const sel of ACCEPTED) {
    test(`${sel} fires at top level, in @media and nested`, () => {
      expect(selectorListState(sel, false), "valid, not an error").toBe("valid");
      expect(fires(`${sel}{${FIXED}}`)).toBe(true);
      expect(fires(`.cover, ${sel}{${FIXED}}`)).toBe(true);
      expect(fires(`@media screen{${sel}{${FIXED}}}`)).toBe(true);
      expect(fires(`@layer a{@supports (position:fixed){${sel}{${FIXED}}}}`)).toBe(true);
      expect(nestedCover(`main{${STATIC};${sel}{${FIXED}}}`)).toBe(true);
      expect(nestedCover(`.cover{${STATIC};&, ${sel}{${FIXED}}}`)).toBe(true);
    });

    test(`${sel} is a rule that applies: as a decoy it hides the cover`, () => {
      expect(fires(`.cover{${FIXED}}${sel}{${STATIC}}`)).toBe(false);
    });
  }

  for (const sel of ACCEPTED_NOT_APPLIED) {
    test(`${sel} (no namespace) is read as undecided: it fires, and as a decoy it does not hide the cover`, () => {
      expect(selectorListState(sel, false), "valid, not an error").toBe("valid");
      expect(fires(`${sel}{${FIXED}}`)).toBe(true);
      expect(fires(`.cover, ${sel}{${FIXED}}`)).toBe(true);
      expect(fires(`@media screen{${sel}{${FIXED}}}`)).toBe(true);
      expect(nestedCover(`main{${STATIC};${sel}{${FIXED}}}`)).toBe(true);
      expect(fires(`.cover{${FIXED}}${sel}{${STATIC}}`)).toBe(true);
    });
  }

  test("a named namespace stays doubtful: the rule is read as of unknown applicability, as in v0.0.162", () => {
    for (const sel of ["h|x", "h|iframe.cover", "h|*.cover", "[h|id=google-auth]", "iframe[h|id=google-auth]"]) {
      expect(selectorListState(sel, false), sel).toBe("doubtful");
    }
    for (const sel of ["h|iframe.cover", "h|*.cover", "iframe[h|id=google-auth]"]) {
      expect(fires(`${NAMESPACE}${sel}{${FIXED}}`), sel).toBe(true);
      expect(fires(`${NAMESPACE}.cover, ${sel}{${FIXED}}`), `list ${sel}`).toBe(true);
      // undecided: a decoy written with it cannot hide a cover
      expect(fires(`.cover{${FIXED}}${NAMESPACE}${sel}{${STATIC}}`), `decoy ${sel}`).toBe(true);
    }
  });

  test("a namespace separator that selects nothing is not a cover", () => {
    for (const sel of ["*|div.cover", "|div.cover", "*|iframe.other", "[*|id=other]", "*|"]) {
      expect(fires(`${sel}{${FIXED}}`), sel).toBe(false);
    }
  });

  test("a table of forms against headless Chrome: every form it accepts and applies is not silent", () => {
    const verdicts = chromeVerdicts([...ACCEPTED, ...ACCEPTED_NOT_APPLIED]);
    if (!verdicts) {
      console.warn("headless Chrome is not available: the browser comparison is skipped");
      return;
    }
    for (const sel of ACCEPTED) {
      const v = verdicts[sel];
      expect(v, sel).toBeDefined();
      if (v!.supported && v!.matches) expect(fires(`${sel}{${FIXED}}`), `Chrome applies ${sel}`).toBe(true);
      // the table lists only forms Chrome accepts: a form it no longer accepts is a stale row
      expect(v!.supported, `Chrome accepts ${sel}`).toBe(true);
      expect(v!.matches, `Chrome applies ${sel}`).toBe(true);
    }
    for (const sel of ACCEPTED_NOT_APPLIED) {
      const v = verdicts[sel]!;
      expect(v.supported, `Chrome accepts ${sel}`).toBe(true);
      // the table row documents why these are undecided: Chrome accepts them and does not apply them to an HTML element
      expect(v.matches, `Chrome does not apply ${sel}`).toBe(false);
      expect(fires(`${sel}{${FIXED}}`), `${sel} is not silent`).toBe(true);
    }
  }, 60_000);
});
