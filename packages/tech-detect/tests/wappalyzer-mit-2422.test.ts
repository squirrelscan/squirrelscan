// #2422: batch 1 of the fingerprints ported from the MIT-licensed Wappalyzer snapshot. Each fingerprint gets one
// positive input (a script URL on the vendor's host) and a near-miss that must not match. Synthetic fixtures on
// example.com: a vendor host is never audited here, only named.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";
import { ALL_FINGERPRINTS } from "../src/fingerprints";
import { WAPPALYZER_MIT_FINGERPRINTS } from "../src/fingerprints/wappalyzer-mit";

const page = (head: string, body = "<p>Hello</p>") =>
  `<!doctype html><html><head><title>T</title>${head}</head><body>${body}</body></html>`;
const detect = (html: string, scripts?: string[]) =>
  detectTechnologies({
    url: "https://www.example.com/",
    headers: {},
    html,
    scripts: scripts?.map((url) => ({ url })),
  });
const ids = (html: string, scripts?: string[]): string[] =>
  detect(html, scripts).map((t) => t.id);
const tag = (src: string) => page(`<script async src="${src}"></script>`);

// [id, a script URL on the vendor, an input that looks close but is not the vendor]. The default near-miss
// keeps the path and puts the vendor's host in front of another domain (`cdn.vendor.com.example.com`).
const CASES: Array<[string, string, string?]> = [
  ["jquery-cdn", "https://code.jquery.com/jquery-3.7.1.min.js"],
  ["rewardful", "https://r.wdfl.co/rw.js"],
  ["contentsquare", "https://t.contentsquare.net/uxa/4a538462d6e27.js"],
  ["clicky", "https://static.getclicky.com/js"],
  ["elfsight", "https://apps.elfsight.com/p/platform.js"],
  ["embedly", "https://cdn.embedly.com/widgets/platform.js"],
  ["tilda", "https://static.tildacdn.com/js/tilda-scripts-3.0.min.js"],
  [
    "sharethis",
    "https://platform-api.sharethis.com/js/sharethis.js#property=x&product=inline-share-buttons",
  ],
  ["ezoic", "https://www.ezojs.com/ezoic/sa.min.js"],
  [
    "socket-io",
    "https://cdn.socket.io/4.7.4/socket.io.min.js",
    "https://cdn.socket.io/4.7.4/socket.io.min.js.map",
  ],
  ["lucky-orange", "https://tools.luckyorange.com/core/lo.js?site-id=a1b2c3d4"],
  ["skimlinks", "https://s.skimresources.com/js/298709X1786299.skimlinks.js"],
  ["awin", "https://www.dwin1.com/6756.js"],
  [
    "uptimerobot",
    "https://stats.uptimerobot.com/build/assets/common-De1gyMia.js",
  ],
  ["leadinfo", "https://cdn.leadinfo.net/ping.js"],
  ["plaid", "https://cdn.plaid.com/link/v2/stable/link-initialize.js"],
  ["inspectlet", "https://cdn.inspectlet.com/inspectlet.js"],
  ["mediavine", "https://scripts.mediavine.com/tags/example-site.js"],
  ["qualified", "https://js.qualified.com/qualified.js?token=AbCdEf123"],
  ["acuity-scheduling", "https://embed.acuityscheduling.com/js/embed.js"],
  ["instant-page", "https://instant.page/5.2.0"],
  [
    "amcharts",
    "https://cdn.amcharts.com/lib/5/index.js",
    "https://cdn.amcharts.com.example.com/lib/5/index.js",
  ],
  ["albacross", "https://serve.albacross.com/track.js"],
  ["branch", "https://cdn.branch.io/branch-latest.min.js"],
  ["moengage", "https://cdn.moengage.com/webpush/moe_webSdk.min.latest.js"],
  ["adthrive", "https://ads.adthrive.com/sites/5a1b2c3d4e/ads.min.js"],
  ["ethicalads", "https://media.ethicalads.io/media/client/ethicalads.min.js"],
  ["manychat", "https://widget.manychat.com/133238760818005.js"],
  [
    "provide-support",
    "https://image.providesupport.com/js/examplecompany/safe-standard.js",
  ],
  ["ketch", "https://global.ketchcdn.com/web/v3/config/example/site/boot.js"],
  ["pingdom", "https://rum-static.pingdom.net/pa-64e61c91eff3250012000030.js"],
  ["6sense", "https://j.6sc.co/j/27bfc750-4d9e-4606-8ecd-611abc8d03de.js"],
  [
    "digistore24",
    "https://www.digistore24.com/service/digistore.js",
    "https://www.digistore24.com.example.com/service/digistore.js",
  ],
  ["clutch", "https://widget.clutch.co/static/js/widget.js"],
  ["jouwweb", "https://assets.jwwb.nl/assets/website-rendering-i18n/en-US.js"],
  [
    "gravitec",
    "https://cdn.gravitec.net/storage/e2df84b6cf24b1e9253195c5234454f3/client.js",
  ],
  [
    "bamboohr",
    "https://examplecompany.bamboohr.com/js/embed.js",
    "https://examplecompany.bamboohr.com/js/embed.js.map",
  ],
  ["fundraise-up", "https://cdn.fundraiseup.com/widget/ABCDEFGH"],
  [
    "highcharts",
    "https://code.highcharts.com/stock/11.2.0/highstock.js",
    "https://code.highcharts.com.example.com/other.js",
  ],
  ["viral-loops", "https://app.viral-loops.com/widgetsV2/core/loader.js"],
  ["fullcontact", "https://tags.fullcontact.com/anon/fullcontact.js"],
  ["getsocial", "https://api.at.getsocial.io/widget/v1/gs_async.js?id=2ed8f9"],
  [
    "quantum-metric",
    "https://cdn.quantummetric.com/qscripts/quantum-example.js",
  ],
  ["exoclick", "https://a.exoclick.com/tag_gen.js"],
  ["nextdoor-ads", "https://ads.nextdoor.com/public/pixel/ndp.js?id=abc"],
  [
    "refersion",
    "https://examplestore.refersion.com/tracker/v3/pub_b7a6bdb31bb0e2033400.js",
  ],
  ["tabby", "https://checkout.tabby.ai/tabby-promo.js"],
  [
    "zip-pay",
    "https://static.zip.co/lib/js/zm-widget-js/dist/zip-widget.min.js",
  ],
  ["ada", "https://static.ada.support/embed2.js"],
  ["octane-ai", "https://app.octaneai.com/abc123/shopify.js"],
  [
    "tencent-waterproof-wall",
    "https://turing.captcha.qcloud.com/TCaptcha.js",
    "https://turing.captcha.qcloud.com/TCaptcha.json",
  ],
  [
    "birdeye",
    "https://birdeye.com/embed/v7/172170446511150/11/1234567893011151831356410",
    "https://birdeye.com/blog/embed.js",
  ],
  ["nudgify", "https://cdn.nudgify.com/nudgify.js"],
  ["postscript", "https://sdk.postscript.io/sdk-script-loader.bundle.js"],
  ["valuecommerce", "https://aml.valuecommerce.com/vcdal.js"],
  ["junip", "https://cdn.juniphq.com/scripts/junip.js"],
  ["attentive", "https://cdn.attn.tv/examplestore/dtag.js"],
  ["embedsocial", "https://embedsocial.com/embedscript/ei.js"],
  ["getsitecontrol", "https://l.getsitecontrol.com/42q2m8e4.js"],
  [
    "hello-bar",
    "https://my.hellobar.com/ad8830587daad80ceb0c6a89aba650cdda1e5f8c.js",
  ],
  ["interact", "https://i.tryinteract.com/embed.js"],
  [
    "bugherd",
    "https://www.bugherd.com/sidebarv2.js?apikey=abc",
    "https://www.bugherd.com/blog/post.js",
  ],
  ["marker-io", "https://edge.marker.io/latest/shim.js"],
  ["optimonk", "https://onsite.optimonk.com/script.js?account=221888"],
  [
    "qualtrics",
    "https://znabc123-example.siteintercept.qualtrics.com/SIE/?Q_ZID=ZN_abc",
  ],
  ["bambuser", "https://one-to-one.bambuser.com/embed.js"],
  ["conveythis", "https://cdn.conveythis.com/javascript/conveythis.js"],
  ["fast-bundle", "https://api.fastbundle.co/scripts/src_script.js"],
  [
    "getyourguide",
    "https://widget.getyourguide.com/dist/pa.umd.production.min.js",
  ],
  [
    "kakao",
    "https://developers.kakao.com/sdk/js/kakao.min.js",
    "https://developers.kakao.com/docs/guide.js",
  ],
  [
    "maxmind",
    "https://js.maxmind.com/js/apis/geoip2/v2.1/geoip2.js",
    "https://js.maxmind.com.example.com/js/apis/geoip2/v2.1/geoip2.js",
  ],
  [
    "searchanise",
    "https://searchanise-ef84.kxcdn.com/widgets/bigcommerce/init.js",
  ],
  ["smile-io", "https://cdn.sweettooth.io/assets/storefront.js"],
];

const withHostAfter = (url: string): string =>
  url.replace(/^(https?:\/\/[^/]+)/, "$1.example.com");

describe("the table covers every ported fingerprint", () => {
  test("one case per fingerprint, none missing or unknown", () => {
    const wanted = WAPPALYZER_MIT_FINGERPRINTS.map((f) => f.id).toSorted();
    expect(CASES.map(([id]) => id).toSorted()).toEqual(wanted);
  });
});

describe("each fingerprint: one positive input, one near-miss", () => {
  for (const [id, url, miss] of CASES) {
    test(`${id}: ${new URL(url).host} detects, the near-miss does not`, () => {
      const nearMiss = miss ?? withHostAfter(url);
      // As a script tag in the page, and as an entry of the script list the crawler passes.
      expect(ids(tag(url)), url).toContain(id);
      expect(ids(page(""), [url]), url).toContain(id);
      expect(ids(tag(nearMiss)), nearMiss).not.toContain(id);
      expect(ids(page(""), [nearMiss]), nearMiss).not.toContain(id);
    });
  }

  test("a protocol-relative URL detects, and a name in prose does not", () => {
    expect(ids(tag("//r.wdfl.co/rw.js"))).toContain("rewardful");
    expect(
      ids(page("", "<p>We load <code>https://r.wdfl.co/rw.js</code>.</p>"))
    ).not.toContain("rewardful");
  });

  test("a vendor's own marketing site (www) is not the vendor's script", () => {
    expect(ids(tag("https://www.nudgify.com/_nuxt/B6R-npDC.js"))).not.toContain(
      "nudgify"
    );
    expect(
      ids(tag("https://www.mediavine.com/wp-content/themes/core/view.js"))
    ).not.toContain("mediavine");
  });
});

describe("inline loader snippets", () => {
  const loader = (src: string) =>
    page(
      `<script>(function(){var s=document.createElement("script");s.async=true;s.src="${src}";document.head.appendChild(s);})();</script>`
    );

  test("a src assignment in an inline script detects", () => {
    expect(ids(loader("https://cdn.branch.io/branch-latest.min.js"))).toContain(
      "branch"
    );
    expect(
      ids(loader("https://cdn.fundraiseup.com/widget/ABCDEFGH"))
    ).toContain("fundraise-up");
    expect(ids(loader("https://edge.marker.io/latest/shim.js"))).toContain(
      "marker-io"
    );
  });

  test("setAttribute('src', ...) detects", () => {
    expect(
      ids(
        page(
          `<script>var s=document.createElement("script");s.setAttribute("src","https://ads.nextdoor.com/public/pixel/ndp.js?id=x");</script>`
        )
      )
    ).toContain("nextdoor-ads");
  });

  test("a different host, a lookalike host and a code sample do not", () => {
    expect(ids(loader("https://cdn.branch.io.example.com/x.js"))).not.toContain(
      "branch"
    );
    expect(ids(loader("https://example.com/cdn.branch.io/x.js"))).not.toContain(
      "branch"
    );
    expect(
      ids(
        page(
          "",
          `<pre>s.src = "https://cdn.branch.io/branch-latest.min.js"</pre>`
        )
      )
    ).not.toContain("branch");
    expect(
      ids(
        page(
          `<script type="application/json">{"a":"s.src = \\"https://cdn.branch.io/x.js\\""}</script>`
        )
      )
    ).not.toContain("branch");
  });

  test("a commented-out loader is no evidence", () => {
    expect(
      ids(
        page(
          `<!-- <script>s.src="https://cdn.branch.io/branch-latest.min.js"</script> -->`
        )
      )
    ).not.toContain("branch");
  });

  test("snippets that pass the URL as an argument or a string", () => {
    expect(
      ids(
        page(
          `<script>(function(w,d,s,u,n,k){})(window,document,"script","https://cdn.leadinfo.net/ping.js","leadinfo","LI-ABC");</script>`
        )
      )
    ).toContain("leadinfo");
    expect(
      ids(
        page(
          `<script>w.adthrive.host = 'ads.adthrive.com'; w.adthrive.threshold = 1;</script>`
        )
      )
    ).toContain("adthrive");
    expect(
      ids(
        page(
          `<script>var cfg = {"sdkUrl":"https:\\/\\/tags.fullcontact.com\\/anon\\/fullcontact.js"};</script>`
        )
      )
    ).toContain("fullcontact");
    expect(
      ids(
        page(
          `<script>const apiURL = 'https://api.fastbundle.co'; const x = 1;</script>`
        )
      )
    ).toContain("fast-bundle");
    expect(
      ids(
        page(
          `<script>try{(new g(100,"r","QSI_S_ZN_abc","//znabc-example.siteintercept.qualtrics.com/WRSiteInterceptEngine/?Q_ZID=ZN_abc")).start()}catch(i){}</script>`
        )
      )
    ).toContain("qualtrics");
    expect(
      ids(
        page(
          `<script>var urls = ["https:\\/\\/sdk.postscript.io\\/sdk-script-loader.bundle.js?shopId=1"];</script>`
        )
      )
    ).toContain("postscript");
    expect(
      ids(
        page(
          `<script>var urls = ["http:\\/\\/octaneai.com\\/abc123\\/shopify.js?x=1"];</script>`
        )
      )
    ).toContain("octane-ai");
  });

  test("a docs sentence that names those hosts does not detect", () => {
    expect(
      ids(
        page(
          "",
          "<p>Add https://cdn.leadinfo.net/ping.js, ads.adthrive.com and sdk.postscript.io to your allow list.</p>"
        )
      )
    ).toEqual(
      expect.not.arrayContaining(["leadinfo", "adthrive", "postscript"])
    );
  });
});

describe("markup that is not a script", () => {
  test("ExoClick's verification meta tag", () => {
    expect(
      ids(page(`<meta name="exoclick-site-verification" content="abc123">`))
    ).toContain("exoclick");
    expect(ids(page(`<meta name="exoclick" content="abc123">`))).not.toContain(
      "exoclick"
    );
  });

  test("Inspectlet's embed comment", () => {
    expect(ids(page("<!-- Begin Inspectlet Embed Code -->"))).toContain(
      "inspectlet"
    );
    expect(ids(page("<!-- Inspectlet is great -->"))).not.toContain(
      "inspectlet"
    );
  });

  test("Tilda stylesheets", () => {
    expect(
      ids(
        page(
          `<link rel="stylesheet" href="https://static.tildacdn.com/css/tilda-grid-3.0.min.css">`
        )
      )
    ).toContain("tilda");
    expect(
      ids(
        page(
          `<link rel="stylesheet" href="https://static.tildacdn.com.example.com/x.css">`
        )
      )
    ).not.toContain("tilda");
  });

  test("Junip's review widget block", () => {
    expect(
      ids(
        page(
          "",
          `<span data-star-template-url="https://api.juniphq.com/images/star_options/1/template"></span>`
        )
      )
    ).toContain("junip");
    expect(
      ids(
        page(
          "",
          `<span data-star-template-url="https://api.juniphq.com.example.com/images/star_options/1/template"></span>`
        )
      )
    ).not.toContain("junip");
  });

  test("amCharts and Highcharts SVG descriptions", () => {
    expect(
      ids(
        page(
          "",
          `<svg width="10" height="10"><desc>JavaScript chart by amCharts 3.21.15</desc></svg>`
        )
      )
    ).toContain("amcharts");
    expect(
      ids(
        page(
          "",
          `<svg width="10" height="10"><desc>Created with Highcharts 10.2.0</desc></svg>`
        )
      )
    ).toContain("highcharts");
    expect(
      ids(page("", `<p>Created with Highcharts 10.2.0</p>`))
    ).not.toContain("highcharts");
  });
});

describe("file names end at a URL boundary and need the whole name", () => {
  const FILES: Array<[string, (ext: string) => string]> = [
    ["socket-io", (e) => `/socket.io/socket.io${e}`],
    ["highcharts", (e) => `/assets/js/highcharts${e}`],
    ["amcharts", (e) => `/js/amcharts${e}`],
    [
      "tencent-waterproof-wall",
      (e) => `https://turing.captcha.qcloud.com/TCaptcha${e}`,
    ],
    ["bamboohr", (e) => `https://acme.bamboohr.com/js/embed${e}`],
  ];
  for (const [id, url] of FILES) {
    test(`${id}: .js, .js?v=1 and .js#x detect; .json, .jsx and .js.map do not`, () => {
      for (const ext of [".js", ".js?v=1", ".js#x"]) {
        expect(ids(tag(url(ext))), url(ext)).toContain(id);
      }
      for (const ext of [".json", ".jsx", ".js.map", ".jsonp"]) {
        expect(ids(tag(url(ext))), url(ext)).not.toContain(id);
      }
    });
  }

  test("a file that only contains the library name is not the library", () => {
    expect(ids(tag("/js/my-highcharts-wrapper.js"))).not.toContain(
      "highcharts"
    );
    expect(ids(tag("/js/socket.io-client-wrapper.js"))).not.toContain(
      "socket-io"
    );
    expect(ids(tag("/js/notamcharts.js"))).not.toContain("amcharts");
  });
});

describe("versions", () => {
  const version = (html: string, id: string, scripts?: string[]) =>
    detect(html, scripts).find((t) => t.id === id)?.version ?? null;

  test("Highcharts reads the CDN path and the SVG description", () => {
    expect(
      version(
        tag("https://code.highcharts.com/11.2.0/highcharts.js"),
        "highcharts"
      )
    ).toBe("11.2.0");
    expect(
      version(
        tag("https://code.highcharts.com/stock/13.1.1/highstock.js"),
        "highcharts"
      )
    ).toBe("13.1.1");
    expect(
      version(
        page("", `<svg><desc>Created with Highcharts 10.2.0</desc></svg>`),
        "highcharts"
      )
    ).toBe("10.2.0");
    expect(
      version(tag("https://code.highcharts.com/highcharts.js"), "highcharts")
    ).toBeNull();
  });

  test("amCharts reads the SVG description", () => {
    expect(
      version(
        page(
          "",
          `<svg><desc>JavaScript chart by amCharts 3.21.15</desc></svg>`
        ),
        "amcharts"
      )
    ).toBe("3.21.15");
  });

  test("Branch reads the SDK query and MaxMind the API path", () => {
    expect(
      version(page(""), "branch", [
        "https://abc12.app.link/_r?sdk=web2.78.0&key=1",
      ])
    ).toBe("2.78.0");
    expect(
      version(
        tag("https://js.maxmind.com/js/apis/geoip2/v2.1/geoip2.js"),
        "maxmind"
      )
    ).toBe("2.1");
  });
});

describe("registry rules for the ported set", () => {
  const ported = WAPPALYZER_MIT_FINGERPRINTS;

  test("at most 80, ids unique across the whole catalogue", () => {
    expect(ported.length).toBeLessThanOrEqual(80);
    const all = ALL_FINGERPRINTS.map((f) => f.id);
    expect(new Set(all).size).toBe(all.length);
  });

  test("no icon, a website, and no dom detector", () => {
    for (const fp of ported) {
      expect(fp.icon, fp.id).toBeUndefined();
      expect(fp.website, fp.id).toMatch(/^https:\/\//);
      expect(
        fp.detectors.some((d) => d.type === "dom"),
        fp.id
      ).toBe(false);
    }
  });

  test("registered after every curated and generated fingerprint", () => {
    const order = ALL_FINGERPRINTS.map((f) => f.id);
    const firstPorted = Math.min(...ported.map((f) => order.indexOf(f.id)));
    expect(firstPorted).toBe(order.length - ported.length);
  });

  test("no script-url pattern accepts a vendor host with a suffix", () => {
    for (const fp of ported) {
      for (const d of fp.detectors) {
        if (d.type !== "script-url") continue;
        expect(d.pattern.source.startsWith("^"), fp.id).toBe(true);
      }
    }
  });
});
