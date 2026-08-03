// content/hidden-text — hidden text and link abuse.
//
// The rule has no CSSOM, so the negative cases carry as much weight as the
// positives: every legitimate way of hiding content (screen-reader utilities,
// collapsed interactive UI, print-only rules, fade-in animations, image
// replacement) must come back clean, or the rule libels the sites using them.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { hiddenTextRule, parseColor, parseLengthPx } from "../src/content/hidden-text";
import type { ParsedPage, RuleContext } from "../src/types";

function ctx(html: string, options: Record<string, unknown> = {}): RuleContext {
  const doc = parseHTML(html).document;
  return {
    page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document: doc } as unknown as ParsedPage,
    options,
  } as unknown as RuleContext;
}

function run(html: string, options: Record<string, unknown> = {}) {
  return hiddenTextRule.run(ctx(html, options)).checks[0];
}

/** 60-odd characters, comfortably over the 50-char default payload floor. */
const PAYLOAD = "cheap discount widgets wholesale supplier best prices online now";

/** A link-farm payload: over the 10-link default escalation floor. */
const SPAM_LINKS = [
  '<a href="/casino">online casino bonus</a>',
  '<a href="/loans">payday loans fast</a>',
  '<a href="/pills">cheap pills delivery</a>',
  '<a href="/poker">poker room deposit</a>',
  '<a href="/slots">free slots spins</a>',
  '<a href="/debt">debt consolidation quote</a>',
  '<a href="/insurance">cheap car insurance</a>',
  '<a href="/crypto">crypto trading signals</a>',
  '<a href="/replica">replica watches sale</a>',
  '<a href="/essay">essay writing service</a>',
  '<a href="/vpn">vpn discount code</a>',
  '<a href="/hosting">cheap hosting deal</a>',
].join(" ");

describe("content/hidden-text — meta", () => {
  test("declares the expected identity", () => {
    expect(hiddenTextRule.meta.id).toBe("content/hidden-text");
    expect(hiddenTextRule.meta.name).toBe("Hidden Text & Links");
    expect(hiddenTextRule.meta.category).toBe("content");
    expect(hiddenTextRule.meta.scope).toBe("page");
    expect(hiddenTextRule.meta.severity).toBe("warning");
    expect(hiddenTextRule.meta.weight).toBe(6);
  });

  test("options schema exposes the documented knobs with defaults", () => {
    const parsed = hiddenTextRule.meta.optionsSchema?.parse({}) as Record<string, unknown>;
    expect(parsed.min_hidden_chars).toBe(50);
    expect(parsed.min_hidden_links).toBe(10);
    expect(parsed.offscreen_px_threshold).toBe(-999);
    expect(parsed.a11y_classes).toEqual([]);
    expect(parsed.safe_classes).toEqual([]);
  });
});

describe("content/hidden-text — outcomes", () => {
  test("pass: an ordinary visible page reports nothing", () => {
    const check = run(`<html><body><p>${PAYLOAD}</p></body></html>`);
    expect(check.status).toBe("pass");
  });

  test("skipped: a document with no body is skipped, not passed", () => {
    const doc = parseHTML("<html></html>").document;
    doc.querySelector("body")?.remove();
    const check = hiddenTextRule.run({
      page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: { document: doc } as unknown as ParsedPage,
      options: {},
    } as unknown as RuleContext).checks[0];
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("no-body");
  });

  test("warn: hidden text without links stays a warning", () => {
    const check = run(`<html><body><div style="display:none">${PAYLOAD}</div></body></html>`);
    expect(check.status).toBe("warn");
  });

  test("fail: hidden LINKS escalate the finding above hidden text", () => {
    const check = run(`<html><body><div style="display:none">${SPAM_LINKS}</div></body></html>`);
    expect(check.status).toBe("fail");
    expect(check.details?.hiddenLinks).toBe(12);
  });
});

describe("content/hidden-text — techniques", () => {
  test("display:none from an inline style", () => {
    const check = run(`<html><body><div style="display:none">${PAYLOAD}</div></body></html>`);
    expect(check.status).toBe("warn");
    expect(check.items?.[0].meta?.techniques).toEqual(["display:none"]);
  });

  test("visibility:hidden from a <style> class rule", () => {
    const html = `<html><head><style>.promo-copy { visibility: hidden; }</style></head>
      <body><div class="promo-copy">${PAYLOAD}</div></body></html>`;
    const check = run(html);
    expect(check.status).toBe("warn");
    expect(check.items?.[0].meta?.techniques).toEqual(["visibility:hidden"]);
  });

  test("display:none from a <style> id rule", () => {
    const html = `<html><head><style>#seo-block { display: none }</style></head>
      <body><div id="seo-block">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("warn");
  });

  test("opacity:0", () => {
    const check = run(`<html><body><div style="opacity:0">${PAYLOAD}</div></body></html>`);
    expect(check.status).toBe("warn");
    expect(check.items?.[0].meta?.techniques).toEqual(["opacity:0"]);
  });

  test("font-size:0 on the element carrying the text", () => {
    const check = run(`<html><body><div style="font-size:0">${PAYLOAD}</div></body></html>`);
    expect(check.status).toBe("warn");
    expect(check.items?.[0].meta?.techniques).toEqual(["font-size:0"]);
  });

  test("off-screen text-indent", () => {
    const check = run(`<html><body><div style="text-indent:-9999px">${PAYLOAD}</div></body></html>`);
    expect(check.status).toBe("warn");
    expect(check.items?.[0].meta?.techniques).toEqual(["text-indent off-screen"]);
  });

  test("off-screen absolute positioning", () => {
    const html = `<html><body><div style="position:absolute;left:-9999px;width:400px;height:200px">${PAYLOAD}</div></body></html>`;
    const check = run(html);
    expect(check.status).toBe("warn");
    expect(check.items?.[0].meta?.techniques).toEqual(["position:absolute left:-9999px"]);
  });

  test("off-screen negative margin", () => {
    const check = run(`<html><body><div style="margin-left:-9999px">${PAYLOAD}</div></body></html>`);
    expect(check.status).toBe("warn");
    expect(check.items?.[0].meta?.techniques).toEqual(["margin-left off-screen"]);
  });

  test("zero-size clipping", () => {
    const html = `<html><body><div style="height:0;overflow:hidden">${PAYLOAD}</div></body></html>`;
    const check = run(html);
    expect(check.status).toBe("warn");
    expect(check.items?.[0].meta?.techniques).toEqual(["height:0 with overflow:hidden"]);
  });

  test("colour on the same colour, both inline on the element", () => {
    const html = `<html><body><p style="color:#ffffff;background-color:#fff">${PAYLOAD}</p></body></html>`;
    const check = run(html);
    expect(check.status).toBe("warn");
    expect(String(check.items?.[0].label)).toContain("color #ffffff");
  });

  test("colour matching the nearest painted backdrop", () => {
    const html = `<html><body><div style="background-color:#101010"><p style="color:#111">${PAYLOAD}</p></div></body></html>`;
    expect(run(html).status).toBe("warn");
  });

  test("transparent text colour", () => {
    const html = `<html><body><p style="color:transparent">${PAYLOAD}</p></body></html>`;
    expect(run(html).status).toBe("warn");
  });

  test("the off-screen threshold is configurable", () => {
    const html = `<html><body><div style="text-indent:-200px">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("pass");
    expect(run(html, { offscreen_px_threshold: -100 }).status).toBe("warn");
  });
});

describe("content/hidden-text — accessibility allowlist", () => {
  test("the sr-only clip idiom is not flagged", () => {
    const html = `<html><head><style>.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip: rect(0 0 0 0); }</style></head>
      <body><span class="sr-only">${PAYLOAD}</span></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("clip-path visually-hidden is not flagged", () => {
    const html = `<html><body><span style="position:absolute;left:-9999px;clip-path:inset(50%)">${PAYLOAD}</span></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("a 1x1 off-screen box is read as the visually-hidden idiom", () => {
    const html = `<html><body><span style="position:absolute;left:-10000px;width:1px;height:1px">${PAYLOAD}</span></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test.each(["sr-only", "visually-hidden", "visuallyhidden", "screen-reader-text"])(
    "the %s class name is exempt even with a hard display:none",
    (cls) => {
      const html = `<html><body><div class="${cls}" style="display:none">${PAYLOAD}</div></body></html>`;
      expect(run(html).status).toBe("pass");
    },
  );

  test("a project-specific class can be added via a11y_classes", () => {
    const html = `<html><body><div class="acme-offscreen" style="display:none">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("warn");
    expect(run(html, { a11y_classes: ["acme-offscreen"] }).status).toBe("pass");
  });

  test("safe_classes exempts an arbitrary class", () => {
    const html = `<html><body><div class="legacy-template" style="display:none">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("warn");
    expect(run(html, { safe_classes: ["legacy-template"] }).status).toBe("pass");
  });
});

describe("content/hidden-text — interactive UI allowlist", () => {
  test("an aria-hidden tab panel is not flagged", () => {
    const html = `<html><body><div role="tabpanel" aria-hidden="true" style="display:none">${PAYLOAD} ${SPAM_LINKS}</div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("a tab panel with no aria-hidden, hidden by a class rule, is not flagged", () => {
    const html = `<html><head><style>.tab-panel { display: none }</style></head>
      <body><div class="tab-panel">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("a cookie consent banner is not flagged", () => {
    const html = `<html><head><style>.cookie-banner { display: none }</style></head>
      <body><div class="cookie-banner">${PAYLOAD} <a href="/privacy">privacy policy</a></div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("collapsed off-canvas navigation with its links is not flagged", () => {
    const html = `<html><body><nav class="offcanvas-menu" style="display:none">${SPAM_LINKS}</nav></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("the hidden attribute exempts an element", () => {
    const html = `<html><body><div hidden>${PAYLOAD} ${SPAM_LINKS}</div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("an accordion body inside a marked container is not flagged", () => {
    const html = `<html><body><div class="accordion"><div class="item-body" style="display:none">${PAYLOAD}</div></div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("a Bootstrap-style data-bs-toggle target is not flagged", () => {
    const html = `<html><body><div data-bs-toggle="collapse" style="display:none">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("a <dialog> is not flagged", () => {
    const html = `<html><body><dialog style="display:none">${PAYLOAD}</dialog></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("a state class such as .is-active marks the element script-driven", () => {
    const html = `<html><body><div class="promo is-active" style="display:none">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("pass");
  });
});

describe("content/hidden-text — cascade and idiom guards", () => {
  test("a rule inside @media print does not hide anything on screen", () => {
    const html = `<html><head><style>@media print { .no-print { display: none } }</style></head>
      <body><div class="no-print">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("a class also targeted by a compound selector may be revealed by JS", () => {
    // The class name is deliberately neutral (no interactive/state token), so
    // the only thing holding the finding back is the unresolved second rule.
    const hiddenOnly = `<html><head><style>.detail-copy { display: none }</style></head>
      <body><div class="detail-copy">${PAYLOAD}</div></body></html>`;
    expect(run(hiddenOnly).status).toBe("warn");

    const alsoToggled = `<html><head><style>.detail-copy { display: none } .detail-copy.wide { display: block }</style></head>
      <body><div class="detail-copy">${PAYLOAD}</div></body></html>`;
    expect(run(alsoToggled).status).toBe("pass");
  });

  test("a descendant selector leaves the same doubt as a compound one", () => {
    const html = `<html><head><style>.detail-copy { display: none } .layout .detail-copy { display: block }</style></head>
      <body><div class="detail-copy">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("an inline style is never second-guessed by an unresolved selector", () => {
    const html = `<html><head><style>.detail-copy.wide { display: block }</style></head>
      <body><div class="detail-copy" style="display:none">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("warn");
  });

  test("opacity:0 with a transition is a fade-in, not spam", () => {
    const html = `<html><body><div style="opacity:0;transition:opacity .3s ease">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("text-indent with a background image is image replacement", () => {
    const html = `<html><body><h1 style="text-indent:-9999px;background-image:url(/logo.svg)">${PAYLOAD}</h1></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("max-height:0 with overflow:hidden and a transition is a collapsing accordion", () => {
    const html = `<html><body><div style="max-height:0;overflow:hidden;transition:max-height .4s">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("font-size:0 as the inline-block whitespace hack is not flagged", () => {
    const html = `<html><body><div style="font-size:0"><span style="font-size:16px">${PAYLOAD}</span></div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("an unitless offset is invalid CSS and hides nothing", () => {
    const html = `<html><body><div style="position:absolute;left:-9999">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("transparent text with a clipped gradient fill is not flagged", () => {
    const html = `<html><body><h2 style="color:transparent;background-clip:text;background-image:linear-gradient(90deg,#f00,#00f)">${PAYLOAD}</h2></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("white caption text over an image backdrop is not flagged", () => {
    const html = `<html><body style="background-color:#ffffff"><div style="background-image:url(/hero.jpg)"><p style="color:#ffffff">${PAYLOAD}</p></div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("white text on a positioned overlay is not flagged", () => {
    const html = `<html><body style="background:#fff"><p style="position:absolute;top:20px;left:20px;color:#fff">${PAYLOAD}</p></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("white text over a gradient banner is not flagged", () => {
    const html = `<html><body style="background-color:#ffffff"><div style="background:linear-gradient(90deg,#004,#008)"><p style="color:#ffffff">${PAYLOAD}</p></div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("a page-wide background image leaves the backdrop unknown", () => {
    const html = `<html><body style="background-color:#ffffff;background-image:url(/paper.png)"><p style="color:#ffffff">${PAYLOAD}</p></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("a descendant painting its own backdrop escapes an inherited colour", () => {
    const html = `<html><body><div style="color:#ffffff;background-color:#ffffff"><p style="background-color:#111111">${PAYLOAD}</p></div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("a wrapper whose children re-declare colour is not hiding them", () => {
    const html = `<html><body><div style="color:#ffffff;background-color:#ffffff"><p style="color:#111">${PAYLOAD}</p></div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("a descendant setting visibility:visible comes back into view", () => {
    const html = `<html><body><div style="visibility:hidden"><p style="visibility:visible">${PAYLOAD}</p></div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("display:none still takes the whole subtree with it", () => {
    const html = `<html><body><div style="display:none"><p style="color:#111;visibility:visible">${PAYLOAD}</p></div></body></html>`;
    expect(run(html).status).toBe("warn");
  });

  test("white text on a resolved dark button is not flagged", () => {
    const html = `<html><head><style>.btn-primary { background-color: #0d6efd }</style></head>
      <body style="background:#fff"><a class="btn-primary" href="/x" style="color:#fff">${PAYLOAD}</a></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("a class the responsive sheet revives inside @media is not flagged", () => {
    // The desktop copy of a responsive footer: hidden at the top level, shown
    // again in a media query we deliberately refuse to evaluate.
    const html = `<html><head><style>
        .footer-desktop { display: none }
        @media (min-width: 900px) { .footer-desktop { display: block } }
      </style></head>
      <body><div class="footer-desktop">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test.each(["nomobile", "desktop-only", "noprint"])(
    "the %s viewport-variant class is exempt",
    (cls) => {
      const html = `<html><body><div class="${cls}" style="display:none">${PAYLOAD}</div></body></html>`;
      expect(run(html).status).toBe("pass");
    },
  );

  test("a transition declared on a compound selector still reads as a fade-in", () => {
    // The resting `opacity:0` is on the element's own class; only the reveal
    // rule carries the transition, and that selector is one we cannot resolve.
    const html = `<html><head><style>
        .reveal-card { opacity: 0 }
        .reveal-card.in-view { opacity: 1; transition: opacity .4s ease }
      </style></head>
      <body><div class="reveal-card">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("opacity:0 beside a displacing transform is an entrance animation", () => {
    const html = `<html><body><div style="opacity:0;transform:translateY(25px)">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("a transform that is itself an off-screen shove is no defence", () => {
    const html = `<html><body><div style="opacity:0;transform:translateX(-9999px)">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("warn");
  });
});

describe("content/hidden-text — CSS parsing", () => {
  test("a semicolon inside a data URL does not manufacture a declaration", () => {
    const html = `<html><body><div style='background-image:url("data:image/svg+xml;display:none;base64,PHN2Zz48L3N2Zz4=")'>${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("an @ inside a declaration value does not swallow the rest of the sheet", () => {
    const html = `<html><head><style>
        .badge::before { content: "@" }
        .promo-copy { position: absolute; left: -9999px }
      </style></head>
      <body><div class="promo-copy">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("warn");
  });

  test("class selectors are matched case-sensitively", () => {
    const html = `<html><head><style>.Promo { display: none }</style></head>
      <body><div class="promo">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("an id rule outranks a class rule", () => {
    const html = `<html><head><style>.detail-copy { display: none } #shown { display: block }</style></head>
      <body><div id="shown" class="detail-copy">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("two bare class rules disagreeing on a property are not guessed at", () => {
    const html = `<html><head><style>.detail-copy { display: none } .detail-copy { display: block }</style></head>
      <body><div class="detail-copy">${PAYLOAD}</div></body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("malformed CSS is parsed in linear time", () => {
    // The regex form of this scan backtracked quadratically: 200KB of
    // brace-less CSS took 26 seconds, stalling the whole crawl.
    const html = `<html><head><style>${"/*" + "a".repeat(200_000)}</style></head>
      <body><div style="text-indent:-9999px">${PAYLOAD}</div></body></html>`;
    const started = performance.now();
    expect(run(html).status).toBe("warn");
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("content/hidden-text — script-controlled elements", () => {
  test("an element the page's own script addresses by id is not flagged", () => {
    const html = `<html><body>
      <div id="newsletter-thanks" style="display:none">${PAYLOAD}</div>
      <script>document.getElementById("newsletter-thanks").style.display = "block";</script>
      </body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("an element addressed by class name is not flagged", () => {
    const html = `<html><body>
      <div class="submit-confirmation" style="display:none">${PAYLOAD}</div>
      <script>document.querySelector(".submit-confirmation").hidden = false;</script>
      </body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("a script mentioning an unrelated element does not launder the page", () => {
    const html = `<html><body>
      <div class="promo-copy" style="display:none">${PAYLOAD}</div>
      <script>document.querySelector(".carousel-track").scrollLeft = 0;</script>
      </body></html>`;
    expect(run(html).status).toBe("warn");
  });

  test("the script guard does not rescue an off-screen block", () => {
    // No toggle library ships `text-indent:-9999px`; a script naming the element
    // says nothing about a technique that has no legitimate scripted use.
    const html = `<html><body>
      <div class="promo-copy" style="text-indent:-9999px">${PAYLOAD}</div>
      <script>document.querySelector(".promo-copy").dataset.seen = "1";</script>
      </body></html>`;
    expect(run(html).status).toBe("warn");
  });
});

describe("content/hidden-text — page-level fade-in wrappers", () => {
  // Regression: sweetgreen.com ships `<main class="main page-catering"
  // style="opacity: 0">` around the whole page and reveals it from an external
  // bundle. The script guard cannot see that bundle, so the rule failed the page
  // over its own visible marketing copy, links and all.
  test("a main landmark at opacity:0 is a load transition, not concealment", () => {
    const html = `<html><body>
      <header><a href="/">home</a></header>
      <main id="main" class="main page-catering" style="opacity: 0">
        <h1>Cater your next event</h1><p>${PAYLOAD}</p>${SPAM_LINKS}
      </main>
      </body></html>`;
    expect(run(html).status).toBe("pass");
  });

  test("the landmark guard does not rescue an off-screen main", () => {
    const html = `<html><body>
      <main style="text-indent:-9999px"><p>${PAYLOAD}</p></main>
      </body></html>`;
    expect(run(html).status).toBe("warn");
  });

  test("a hidden wrapper div is still reported", () => {
    // Only the semantic landmark is exempt. A div doing the same fade stays
    // flagged rather than inviting a guessed size threshold.
    const html = `<html><body>
      <div class="page-wrapper" style="opacity: 0"><p>${PAYLOAD}</p></div>
      </body></html>`;
    expect(run(html).status).toBe("warn");
  });
});

describe("content/hidden-text — payload thresholds and reporting", () => {
  test("a tiny hidden string with no link payload is not worth reporting", () => {
    expect(run(`<html><body><div style="display:none">Loading</div></body></html>`).status).toBe(
      "pass",
    );
  });

  test("min_hidden_chars is configurable", () => {
    const html = `<html><body><div style="display:none">Loading the next page of results</div></body></html>`;
    expect(run(html).status).toBe("pass");
    expect(run(html, { min_hidden_chars: 10 }).status).toBe("warn");
  });

  test("hidden links below min_hidden_links warn rather than fail", () => {
    const html = `<html><body><div style="display:none">${PAYLOAD} <a href="/a">one</a></div></body></html>`;
    const check = run(html);
    expect(check.status).toBe("warn");
    expect(check.details?.hiddenLinks).toBe(1);
  });

  test("only http(s) and relative hrefs count as indexable links", () => {
    // An allow-list: anything a crawler will not follow carries no link equity
    // and must not inflate the tally that escalates the check to a failure.
    const html = `<html><body><div style="display:none">${PAYLOAD}
      <a href="#top">top</a><a href="javascript:void(0)">x</a><a href="">y</a>
      <a href="mailto:a@b.com">mail</a><a href="tel:+1234">call</a>
      <a href="data:text/html,<b>hi</b>">data</a><a href="vbscript:msgbox">vb</a>
      <a href="ftp://example.com/f">ftp</a></div></body></html>`;
    const check = run(html);
    expect(check.status).toBe("warn");
    expect(check.details?.hiddenLinks).toBe(0);
  });

  test("relative, scheme-relative and https hrefs all count", () => {
    const html = `<html><body><div style="display:none">${PAYLOAD}
      <a href="/a">a</a><a href="b.html">b</a><a href="//cdn.example.com/c">c</a>
      <a href="https://example.com/d">d</a><a href="HTTP://example.com/e">e</a></div></body></html>`;
    expect(run(html).details?.hiddenLinks).toBe(5);
  });

  test("items name the offending element, the technique and a snippet", () => {
    const html = `<html><body><div id="kw" class="seo-block" style="display:none">${PAYLOAD}</div></body></html>`;
    const check = run(html);
    expect(check.items).toHaveLength(1);
    expect(check.items?.[0].id).toBe("div#kw.seo-block");
    expect(check.items?.[0].label).toBe("div#kw.seo-block — display:none");
    expect(check.items?.[0].meta?.chars).toBe(PAYLOAD.length);
    expect(String(check.items?.[0].meta?.snippet)).toContain("cheap discount widgets");
  });

  test("only the outermost hidden element is reported, not every descendant", () => {
    const html = `<html><body><div style="display:none"><section><p>${PAYLOAD}</p><p>${PAYLOAD}</p></section></div></body></html>`;
    const check = run(html);
    expect(check.items).toHaveLength(1);
    expect(check.details?.hiddenElements).toBe(1);
  });

  test("the item list is capped and the overflow reported in details", () => {
    const blocks = Array.from(
      { length: 13 },
      (_, i) => `<div style="display:none">${PAYLOAD} block ${i}</div>`,
    ).join("\n");
    const check = run(`<html><body>${blocks}</body></html>`);
    expect(check.items).toHaveLength(10);
    expect(check.details?.hiddenElements).toBe(13);
    expect(check.details?.additional).toBe(3);
  });

  test("visible siblings of a hidden block are still walked", () => {
    const html = `<html><body><div class="wrapper"><p>${PAYLOAD}</p>
      <div style="display:none">${PAYLOAD}</div></div></body></html>`;
    const check = run(html);
    expect(check.status).toBe("warn");
    expect(check.details?.hiddenElements).toBe(1);
  });
});

describe("content/hidden-text — parsing helpers", () => {
  test("parseColor covers hex, rgb(), named and transparent", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#FFFFFF")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("rgb(255, 255, 255)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("rgba(0 0 0 / 0)")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor("white")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("transparent")?.a).toBe(0);
    expect(parseColor("var(--brand)")).toBeNull();
  });

  test("parseLengthPx rejects unitless non-zero values", () => {
    expect(parseLengthPx("-9999px")).toBe(-9999);
    expect(parseLengthPx("0")).toBe(0);
    expect(parseLengthPx("-9999")).toBeNull();
    expect(parseLengthPx("-100%")).toBeNull();
    expect(parseLengthPx("-10rem")).toBe(-160);
  });
});
