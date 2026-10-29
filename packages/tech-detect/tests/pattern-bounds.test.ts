import { describe, expect, test } from "bun:test";
import { detectTechnologies } from "../src/detect";
import { ALL_FINGERPRINTS } from "../src/fingerprints";
import type { TechDetectInput } from "../src/types";

// A pattern with an unbounded run after a repeatable literal (`<link[^>]+href=`,
// `<script\b[^>]*\sdata-main`, `x=.*y`) is quadratic on a page that repeats the
// literal and never closes it: requirejs took about 70 s on 1 MB of `<script `.
// Detection scans every stored page, so each pattern gets a generous budget on
// (the meta tags are passed in so the shared meta pre-parse is not counted)
// input built from its own leading literal (and a few generic hostile openers).

const SIZE = 200_000;
const BUDGET_MS = 400;

/** The literal a pattern starts with, up to its first quantifier, class or group. */
function literalPrefix(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string;
    if (c === "\\") {
      const next = source[i + 1] ?? "";
      if (next === "s") {
        out += " ";
        i++;
        continue;
      }
      if (/[./\-"'<>=:_@#]/.test(next)) {
        out += next;
        i++;
        continue;
      }
      break;
    }
    if (/[[(.*+?{|^$]/.test(c)) break;
    out += c;
  }
  return out;
}

function repeated(unit: string): string {
  return unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
}

describe("every pattern is bounded on hostile input", () => {
  test("pattern built from its own literal prefix finishes within the budget", () => {
    const slow: string[] = [];
    for (const fp of ALL_FINGERPRINTS) {
      for (const d of fp.detectors) {
        if (!("pattern" in d)) continue;
        const source = d.pattern.source;
        const prefixes = new Set(source.split("|").map(literalPrefix).concat(literalPrefix(source)));
        for (const prefix of prefixes) {
          if (prefix.length < 2) continue;
          for (const sep of ["", " ", '"']) {
            const html = repeated(prefix + sep);
            const start = performance.now();
            d.pattern.test(html);
            const ms = performance.now() - start;
            if (ms > BUDGET_MS) slow.push(`${fp.id} ${d.type} ${Math.round(ms)}ms ${source.slice(0, 60)}`);
          }
        }
      }
    }
    expect(slow).toEqual([]);
  }, 60_000);

  test("each fingerprint alone finishes within the budget on repeated tag openers", () => {
    const openers = ["<script ", '<script src="', "<link ", "<meta ", "<img ", "<a ", '<div class="'];
    const slow: string[] = [];
    for (const fp of ALL_FINGERPRINTS) {
      for (const opener of openers) {
        const input: TechDetectInput = { url: "https://example.com/", headers: {}, html: repeated(opener), meta: { x: "y" } };
        const start = performance.now();
        detectTechnologies(input, [fp]);
        const ms = performance.now() - start;
        if (ms > BUDGET_MS) slow.push(`${fp.id} ${JSON.stringify(opener)} ${Math.round(ms)}ms`);
      }
    }
    expect(slow).toEqual([]);
  }, 60_000);
});

describe("bounded patterns still match real markup", () => {
  const ids = (html: string, scripts?: Array<{ url: string }>): string[] =>
    detectTechnologies({ url: "https://example.com/", headers: {}, html, scripts }).map((t) => t.id);

  test("link and script attribute patterns", () => {
    expect(ids(`<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bulma@1/css/bulma.min.css">`)).toContain("bulma");
    expect(ids(`<link href="/assets/css/foundation.css" rel="stylesheet">`)).toContain("foundation-sites");
    expect(ids(`<link rel="stylesheet" type="text/css" href="/css/semantic.min.css">`)).toContain("semantic-ui");
    expect(ids(`<link href="css/materialize.css" rel="stylesheet">`)).toContain("materialize-css");
    expect(ids(`<link rel="stylesheet" href="https://cdnjs.cloudflare.com/x/animate.min.css">`)).toContain("animate-css");
    expect(ids(`<script data-main="js/main" src="js/require.js"></script>`)).toContain("requirejs");
    // html-minifier removeTagWhitespace output: no space between attributes.
    expect(ids(`<link rel="stylesheet"href="/css/bulma.min.css">`)).toContain("bulma");
  });

  test("analytics, privacy and widget patterns", () => {
    const plausible = `<script defer data-domain="example.com" src="https://plausible.io/js/script.js"></script>`;
    expect(ids(plausible)).toContain("plausible");
    const fathom = `<script src="https://cdn.usefathom.com/script.js" data-site="ABCDEFGH" defer></script>`;
    expect(ids(fathom)).toContain("fathom");
    const fb = "https://connect.facebook.net/en_US/fbevents.js";
    expect(ids(`<script src="${fb}"></script>`, [{ url: fb }])).toContain("facebook-pixel");
    const rs = "https://cdn.rudderlabs.com/v1.1/rudder-analytics.min.js";
    expect(ids("", [{ url: rs }])).toContain("rudderstack");
    const didomi = "https://sdk.privacy-center.org/abc123/loader.js";
    expect(ids("", [{ url: didomi }])).toContain("didomi");
    expect(ids("", [{ url: "https://nexus.ensighten.com/acme/prod/Bootstrap.js" }])).toContain("ensighten");
    expect(ids("", [{ url: "https://staticw2.yotpo.com/APPKEY/widget.js" }])).toContain("yotpo");
    expect(ids("", [{ url: "https://x.example/ruxitagentjs_ICA7NVfqrux_10279.js" }])).toContain("dynatrace-rum");
    const uw = `<script data-account="AbC123" src="https://cdn.userway.org/widget.js"></script>`;
    expect(ids(uw)).toContain("userway");
  });
});
