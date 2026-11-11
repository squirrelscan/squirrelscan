// #1691: the same analytics tag installed twice counts every hit twice.

import { describe, expect, test } from "bun:test";

import { parseHTML } from "@squirrelscan/parser/dom";
import { duplicateTagsRule } from "../src/analytics/duplicate-tags";
import type { RuleContext } from "../src/types";

async function run(head: string, body = "") {
  const html = `<html><head>${head}</head><body>${body}</body></html>`;
  const ctx = { page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} }, parsed: { document: parseHTML(html).document }, options: {} } as unknown as RuleContext;
  return (await duplicateTagsRule.run(ctx)).checks;
}
const s = (src: string, attrs = "") => `<script async src="${src}" ${attrs}></script>`;
const inline = (code: string) => `<script>${code}</script>`;
const warns = (c: { status: string }[]) => c.filter((x) => x.status === "warn");

const GTM_SNIPPET = (id: string) =>
  inline(`(function(w,d,s,l,i){var j=d.createElement(s);j.src='https://www.googletagmanager.com/gtm.js?id='+i;})(window,document,'script','dataLayer','${id}');`);
const GTM_NS = (id: string) => `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${id}" height="0" width="0"></iframe></noscript>`;

describe("analytics/duplicate-tags (#1691)", () => {
  test("GA4: the same ID loaded twice warns with the ID and count", async () => {
    const c = warns(await run(s("https://www.googletagmanager.com/gtag/js?id=G-ABC1234") + s("https://www.googletagmanager.com/gtag/js?id=G-ABC1234")));
    expect(c).toHaveLength(1);
    expect(c[0]!.message).toContain("G-ABC1234");
    expect(c[0]!.message).toContain("2 times");
  });
  test("GA4: a loader plus its own config is one install, a single install passes", async () => {
    const c = await run(s("https://www.googletagmanager.com/gtag/js?id=G-ABC1234") + inline("gtag('config', 'G-ABC1234');"));
    expect(c).toHaveLength(1);
    expect(c[0]!.status).toBe("pass");
  });
  test("GA4: a loader plus two configs for the same ID warns", async () => {
    const c = warns(await run(s("https://www.googletagmanager.com/gtag/js?id=G-ABC1234") + inline("gtag('config', 'G-ABC1234');gtag('config', 'G-ABC1234');")));
    expect(c).toHaveLength(1);
  });
  test("GA4: two different IDs are not flagged", async () => {
    const c = await run(s("https://www.googletagmanager.com/gtag/js?id=G-AAAA111") + s("https://www.googletagmanager.com/gtag/js?id=G-BBBB222"));
    expect(warns(c)).toHaveLength(0);
  });
  test("GTM: one script plus one noscript frame is one install", async () => {
    expect(warns(await run(GTM_SNIPPET("GTM-ABC123"), GTM_NS("GTM-ABC123")))).toHaveLength(0);
    expect(warns(await run(s("https://www.googletagmanager.com/gtm.js?id=GTM-ABC123"), GTM_NS("GTM-ABC123")))).toHaveLength(0);
  });
  test("GTM: the same container twice warns, inline or by src", async () => {
    const a = warns(await run(GTM_SNIPPET("GTM-ABC123") + GTM_SNIPPET("GTM-ABC123"), GTM_NS("GTM-ABC123") + GTM_NS("GTM-ABC123")));
    expect(a).toHaveLength(1);
    expect(a[0]!.message).toContain("GTM-ABC123");
    const b = warns(await run(s("https://www.googletagmanager.com/gtm.js?id=GTM-ABC123") + GTM_SNIPPET("GTM-ABC123")));
    expect(b).toHaveLength(1);
  });
  test("GTM: two different containers are not flagged", async () => {
    expect(warns(await run(GTM_SNIPPET("GTM-AAA111") + GTM_SNIPPET("GTM-BBB222"), GTM_NS("GTM-AAA111") + GTM_NS("GTM-BBB222")))).toHaveLength(0);
  });
  test("preload and preconnect hints are not installs", async () => {
    const c = await run(
      '<link rel="preconnect" href="https://www.googletagmanager.com"><link rel="preload" as="script" href="https://www.googletagmanager.com/gtag/js?id=G-ABC1234">' +
        s("https://www.googletagmanager.com/gtag/js?id=G-ABC1234"),
    );
    expect(warns(c)).toHaveLength(0);
  });
  test("an ID only mentioned in JSON or a comment is not an install", async () => {
    const c = await run('<script type="application/ld+json">{"a":"gtag(\'config\', \'G-ABC1234\')"}</script><!-- <script src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234"></script> -->' + s("https://www.googletagmanager.com/gtag/js?id=G-ABC1234"));
    expect(warns(c)).toHaveLength(0);
  });

  // [platform label, single install, double install, id]
  const cases: [string, string, string, string][] = [
    ["Plausible", s("https://plausible.io/js/script.js", 'data-domain="example.com"'), s("https://plausible.io/js/script.js", 'data-domain="example.com"').repeat(2), "example.com"],
    ["Fathom", s("https://cdn.usefathom.com/script.js", 'data-site="ABCDEFGH"'), s("https://cdn.usefathom.com/script.js", 'data-site="ABCDEFGH"').repeat(2), "ABCDEFGH"],
    ["Matomo", inline("var _paq=window._paq=[];_paq.push(['setSiteId', '7']);var u='//m.example.com/matomo.js';"), inline("_paq.push(['setSiteId', '7']);var u='//m.example.com/matomo.js';").repeat(2), "7"],
    ["Segment", inline("analytics.load(\"WRITEKEY12\");"), inline("analytics.load(\"WRITEKEY12\");").repeat(2), "WRITEKEY12"],
    ["Mixpanel", inline("mixpanel.init(\"tok123abc\");"), inline("mixpanel.init(\"tok123abc\");").repeat(2), "tok123abc"],
    ["Amplitude", s("https://cdn.amplitude.com/script/KEY123.js") + inline("amplitude.init('KEY123');"), s("https://cdn.amplitude.com/script/KEY123.js").repeat(2), "KEY123"],
    ["Heap", inline("heap.load(\"1234567890\");"), inline("heap.load(\"1234567890\");").repeat(2), "1234567890"],
    ["Hotjar", inline("h._hjSettings={hjid:3456789,hjsv:6};r.src='https://static.hotjar.com/c/hotjar-3456789.js';"), inline("h._hjSettings={hjid:3456789,hjsv:6};").repeat(2), "3456789"],
    ["Microsoft Clarity", inline('(function(c,l,a,r,i,t,y){t.src="https://www.clarity.ms/tag/"+i;})(window, document, "clarity", "script", "abc123xyz9");'), s("https://www.clarity.ms/tag/abc123xyz9").repeat(2), "abc123xyz9"],
  ];
  for (const [label, single, double, id] of cases) {
    test(`${label}: single install passes, double warns naming the platform and ID`, async () => {
      expect(warns(await run(single))).toHaveLength(0);
      const c = warns(await run(double));
      expect(c).toHaveLength(1);
      expect(c[0]!.message).toContain(label);
      expect(c[0]!.message).toContain(id);
    });
  }

  test("different IDs for one platform are not flagged", async () => {
    expect(warns(await run(inline("mixpanel.init(\"aaa\");") + inline("mixpanel.init(\"bbb\");")))).toHaveLength(0);
  });

  test("is deterministic and orders findings by platform then ID", async () => {
    const head = inline("mixpanel.init('b1');mixpanel.init('b1');") + s("https://www.googletagmanager.com/gtag/js?id=G-ZZZZ999").repeat(2) + s("https://www.googletagmanager.com/gtag/js?id=G-AAAA111").repeat(2);
    const a = await run(head);
    expect(a.map((x) => x.message)).toEqual((await run(head)).map((x) => x.message));
    expect(a.map((x) => x.items![0]!.id)).toEqual(["G-AAAA111", "G-ZZZZ999", "b1"]);
  });

  test("IDs keep the page's casing and a page without tags passes", async () => {
    const c = warns(await run(s("https://www.googletagmanager.com/gtag/js?id=G-abcd1234").repeat(2)));
    expect(c[0]!.message).toContain("G-abcd1234");
    expect((await run(""))[0]!.status).toBe("pass");
  });

  describe("lookalike Google Tag Manager URLs are not loaders (CodeQL missing-regexp-anchor)", () => {
    const GTM_LOOKALIKES = [
      "https://evil.example/?x=googletagmanager.com/gtm.js&id=GTM-ABCD123",
      "https://googletagmanager.com.evil.example/gtm.js?id=GTM-ABCD123",
      "https://evil-googletagmanager.com/gtm.js?id=GTM-ABCD123",
      "https://evil.example/googletagmanager.com/gtm.js?id=GTM-ABCD123",
      "https://sub.googletagmanager.com/gtm.js?id=GTM-ABCD123",
      "https://www.googletagmanager.com/gtm.json?id=GTM-ABCD123",
      "https://www.googletagmanager.com/other/gtm.js?id=GTM-ABCD123",
    ];
    for (const src of GTM_LOOKALIKES) {
      test(`GTM script ${src} is not counted`, async () => {
        const c = await run(s(src) + s(src));
        expect(warns(c)).toHaveLength(0);
      });
    }

    test("GA4 lookalikes are not counted", async () => {
      for (const src of [
        "https://evil.example/?x=googletagmanager.com/gtag/js&id=G-ABC1234",
        "https://googletagmanager.com.evil.example/gtag/js?id=G-ABC1234",
        "https://www.googletagmanager.com/gtag/jsx?id=G-ABC1234",
      ]) {
        expect(warns(await run(s(src) + s(src)))).toHaveLength(0);
      }
    });

    test("a lookalike ns.html iframe is not counted", async () => {
      const frame = (src: string) => `<noscript><iframe src="${src}"></iframe></noscript>`;
      for (const src of [
        "https://evil.example/?x=googletagmanager.com/ns.html&id=GTM-ABCD123",
        "https://googletagmanager.com.evil.example/ns.html?id=GTM-ABCD123",
      ]) {
        expect(warns(await run("", frame(src) + frame(src)))).toHaveLength(0);
      }
    });

    test("an inline script that only mentions a lookalike gtm.js URL does not count its container", async () => {
      const mention = (url: string) =>
        inline(`var x='${url}'; (function(i){})('GTM-ABCD123');`);
      for (const url of [
        "https://evil.example/?x=googletagmanager.com/gtm.js",
        "https://googletagmanager.com.evil.example/gtm.js",
        "see googletagmanager.com/gtm.js for details",
      ]) {
        expect(warns(await run(mention(url) + mention(url)))).toHaveLength(0);
      }
    });

    test("the real hosts still count: bare, www, protocol-relative, uppercase, and a port-less https URL", async () => {
      for (const src of [
        "https://googletagmanager.com/gtm.js?id=GTM-ABCD123",
        "https://www.googletagmanager.com/gtm.js?id=GTM-ABCD123",
        "//www.googletagmanager.com/gtm.js?id=GTM-ABCD123",
        "HTTPS://WWW.GOOGLETAGMANAGER.COM/GTM.JS?id=GTM-ABCD123",
        "https://www.googletagmanager.com/gtm.js?l=dataLayer&id=GTM-ABCD123#x",
      ]) {
        expect(warns(await run(s(src) + s(src)))).toHaveLength(1);
      }
    });

    test("the standard inline snippet in both quote styles still counts", async () => {
      const dq = (id: string) => inline(`j.src="https://www.googletagmanager.com/gtm.js?id="+i;})(window,document,"script","dataLayer","${id}");`);
      expect(warns(await run(GTM_SNIPPET("GTM-ABCD123") + dq("GTM-ABCD123")))).toHaveLength(1);
    });
  });

  describe("follow-ups: id case, host shapes, template literals, other vendors", () => {
    test("the id parameter is read in any letter case", async () => {
      for (const key of ["id", "ID", "Id"]) {
        const gtm = `https://www.googletagmanager.com/gtm.js?${key}=GTM-ABCD123`;
        expect(warns(await run(s(gtm) + s(gtm)))).toHaveLength(1);
        const ga4 = `https://www.googletagmanager.com/gtag/js?${key}=G-ABC1234`;
        expect(warns(await run(s(ga4) + s(ga4)))).toHaveLength(1);
        const ns = GTM_NS("GTM-ABCD123").replace("?id=", `?${key}=`);
        expect(warns(await run("", ns + ns))).toHaveLength(1);
      }
    });

    test("a port, userinfo or leading whitespace on the real host still counts", async () => {
      for (const src of [
        "https://www.googletagmanager.com:443/gtm.js?id=GTM-ABCD123",
        "https://user:pw@www.googletagmanager.com/gtm.js?id=GTM-ABCD123",
        "   https://www.googletagmanager.com/gtm.js?id=GTM-ABCD123",
        "\thttps://www.googletagmanager.com/gtm.js?id=GTM-ABCD123",
      ]) {
        expect(warns(await run(s(src) + s(src)))).toHaveLength(1);
      }
    });

    test("a host that only looks like the vendor's through userinfo or a port does not count", async () => {
      for (const src of [
        "https://www.googletagmanager.com@evil.example/gtm.js?id=GTM-ABCD123",
        "https://www.googletagmanager.com:pw@evil.example/gtm.js?id=GTM-ABCD123",
        "https://evil.example:443/www.googletagmanager.com/gtm.js?id=GTM-ABCD123",
        "https://evil.example\\@www.googletagmanager.com/gtm.js?id=GTM-ABCD123",
      ]) {
        expect(warns(await run(s(src) + s(src)))).toHaveLength(0);
      }
    });

    test("a template-literal inline snippet counts like a quoted one", async () => {
      const tpl = (id: string) =>
        inline("j.src=`https://www.googletagmanager.com/gtm.js?id=${i}`;})(window,document,'script','dataLayer','" + id + "');");
      expect(warns(await run(tpl("GTM-ABCD123") + tpl("GTM-ABCD123")))).toHaveLength(1);
      const lookalike = inline("j.src=`https://evil.example/?x=googletagmanager.com/gtm.js`;})(window,document,'script','dataLayer','GTM-ABCD123');");
      expect(warns(await run(lookalike + lookalike))).toHaveLength(0);
    });

    const VENDORS: Array<[string, string, string]> = [
      ["Segment", "https://cdn.segment.com/analytics.js/v1/WRITEKEY123/analytics.min.js", "https://evil.example/?x=cdn.segment.com/analytics.js/v1/WRITEKEY123/analytics.min.js"],
      ["Segment (.io)", "https://cdn.segment.io/analytics.js/v1/WRITEKEY123/analytics.js", "https://cdn.segment.io.evil.example/analytics.js/v1/WRITEKEY123/analytics.js"],
      ["Amplitude", "https://cdn.amplitude.com/script/APIKEY123.js", "https://evil.example/cdn.amplitude.com/script/APIKEY123.js"],
      ["Amplitude (EU)", "https://cdn.eu.amplitude.com/script/APIKEY123.js", "https://cdn.eu.amplitude.com.evil.example/script/APIKEY123.js"],
      ["Heap", "https://cdn.heapanalytics.com/js/heap-1234567.js", "https://evil-heapanalytics.com/js/heap-1234567.js"],
      ["Hotjar", "https://static.hotjar.com/c/hotjar-123456.js", "https://static.hotjar.com.evil.example/c/hotjar-123456.js"],
      ["Clarity", "https://www.clarity.ms/tag/abc123xyz", "https://evil.example/?x=clarity.ms/tag/abc123xyz"],
    ];
    for (const [name, real, fake] of VENDORS) {
      test(`${name}: the real loader counts twice as a duplicate, a lookalike does not`, async () => {
        expect(warns(await run(s(real) + s(real)))).toHaveLength(1);
        expect(warns(await run(s(fake) + s(fake)))).toHaveLength(0);
      });
    }

    test("an inline Clarity snippet needs the loader URL as a quoted host, not a mention", async () => {
      const snippet = (host: string) =>
        inline(`(function(c,l,a,r,i,t,y){t=l.createElement(r);t.src="${host}/tag/"+i;})(window,document,"clarity","script","abc123xyz");`);
      const real = snippet("https://www.clarity.ms");
      expect(warns(await run(real + real))).toHaveLength(1);
      const fake = snippet("https://evil.example/?x=clarity.ms");
      expect(warns(await run(fake + fake))).toHaveLength(0);
    });
  });
});
