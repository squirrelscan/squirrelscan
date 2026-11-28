// #2423: third-party script hosts that loaded often in crawl samples and matched no fingerprint.
// One positive per fingerprint (new or widened) and a near-miss that must not match.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";

const detect = (html: string, scripts?: string[]): string[] =>
  detectTechnologies({
    url: "https://www.example.com/",
    headers: {},
    html,
    scripts: scripts?.map((url) => ({ url })),
  }).map((t) => t.id);

const page = (src: string) =>
  `<!doctype html><html><head><title>T</title><script async src="${src}"></script></head><body><p>Hi</p></body></html>`;

// [id, script url that must match, near-miss that must not]
const CASES: Array<[string, string, string]> = [
  [
    "ahrefs-analytics",
    "https://analytics.ahrefs.com/analytics.js",
    "https://analytics.ahrefs.com.example.net/analytics.js",
  ],
  [
    "datafast",
    "https://datafa.st/js/script.js",
    "https://datafa.st/blog/script.js",
  ],
  [
    "openpanel",
    "https://openpanel.dev/op1.js?v=1.2.0",
    "https://openpanel.dev/op1.json",
  ],
  [
    "statcounter",
    "https://www.statcounter.com/counter/counter.js",
    "https://gs.statcounter.com/chart.js",
  ],
  [
    "metricool",
    "https://tracker.metricool.com/resources/be.js",
    "https://tracker.metricool.com/other.js",
  ],
  [
    "apollo-io",
    "https://assets.apollo.io/micro/website-tracker/tracker.iife.js?nocache=1",
    "https://assets.apollo.io/developer/js/bundle.js",
  ],
  [
    "impact-com",
    "https://utt.impactcdn.com/A1234567-abcd-4ef0-8123-0123456789ab.js",
    "https://impactcdn.com/A1234567.js",
  ],
  [
    "firstpromoter",
    "https://cdn.firstpromoter.com/fpr.js",
    "https://webcdn.firstpromoter.com/fpr.js",
  ],
  ["tolt", "https://cdn.tolt.io/tolt.js", "https://cdn.tolt.io/logo.png"],
  [
    "highlevel",
    "https://widgets.leadconnectorhq.com/loader.js",
    "https://leadconnectorhq.com.example.net/loader.js",
  ],
  [
    "highlevel",
    "https://stcdn.leadconnectorhq.com/_preview/fZtq4m04.js",
    "https://www.leadconnectorhq.com/page.html",
  ],
  [
    "trustindex",
    "https://cdn.trustindex.io/loader.js?662400c4314a960f55262c4ec0a",
    "https://cdn.trustindex.io/assets/img/favicon.png",
  ],
  [
    "hostinger-reach",
    "https://cdn-reach.hostinger.com/embed.js",
    "https://reach.hostinger.com/embed.js",
  ],
  [
    "emergent",
    "https://assets.emergent.sh/scripts/emergent-main.js",
    "https://app.emergent.sh/scripts/emergent-main.js",
  ],
  [
    "google-maps",
    "https://maps.googleapis.com/maps/api/js?key=K&callback=init",
    "https://maps.googleapis.com/maps/api/geocode/json",
  ],
  [
    "google-maps",
    "https://maps.google.com/maps/api/js?sensor=false",
    "https://maps.google.com/maps?q=Paris",
  ],
  [
    "google-identity-services",
    "https://accounts.google.com/gsi/client",
    "https://accounts.google.com/signin/v2",
  ],
  [
    "google-funding-choices",
    "https://fundingchoicesmessages.google.com/i/pub-1234567890123456?ers=1",
    "https://fundingchoicesmessages.google.com/",
  ],
  [
    "godaddy",
    "https://img1.wsimg.com/blobby/go/abc/gpub/def/script.js",
    "https://img1.wsimg.com/blobby/go/abc/photo.jpg",
  ],
  // widened existing fingerprints
  [
    "wordpress",
    "https://stats.wp.com/e-202648.js",
    "https://stats.wp.com/n.gif",
  ],
  [
    "posthog",
    "https://us-assets.i.posthog.com/static/array.js",
    "https://us-assets.i.posthog.com.example.net/static/array.js",
  ],
  [
    "hubspot-chat",
    "https://js-na2.hs-scripts.com/123456.js",
    "https://js-na2.hs-scripts.example.net/123456.js",
  ],
  [
    "hubspot-cms",
    "https://js-eu1.hs-scripts.com/123456.js",
    "https://js-eu1.hs-script.com/123456.js",
  ],
  [
    "sentry",
    "https://js.sentry-cdn.com/0123456789abcdef0123456789abcdef.min.js",
    "https://js.sentry-cdn.com/docs.html",
  ],
  [
    "webflow",
    "https://cdn.prod.website-files.com/686294e263eb7e215bd232f7/js/site.abc.js",
    "https://cdn.prod.website-files.com/686294e263eb7e215bd232f7/img.png",
  ],
  [
    "squarespace",
    "https://definitions.sqspcdn.com/website-component-definition/static-assets/website.components.form/visitor.js",
    "https://definitionsXsqspcdn.com/visitor.js",
  ],
  [
    "squarespace",
    "https://assets.squarespace.com/universal/scripts-compressed/common.js",
    "https://assets.squarespace.com.example.net/common.js",
  ],
  [
    "jquery",
    "https://code.jquery.com/jquery-4.1.0.min.js",
    "https://code.jquery.com/ui/1.13.2/themes/base/jquery-ui.css",
  ],
  [
    "lemon-squeezy",
    "https://assets.lemonsqueezy.com/lemon.js",
    "https://assets.lemonsqueezy.com/logo.png",
  ],
  [
    "lemon-squeezy",
    "https://app.lmsqueezy.com/affiliate.js",
    "https://lmsqueezy.com.example.net/affiliate.js",
  ],
  [
    "shop-pay",
    "https://shop.app/checkouts/internal/preloads.js?locale=en",
    "https://shop.app/checkouts/internal/preloads.json",
  ],
  [
    "microsoft-uet",
    "https://bat.bing.net/bat.js",
    "https://bat.bing.net/bat.json",
  ],
  [
    "vercel-web-analytics",
    "https://va.vercel-scripts.com/v1/script.debug.js",
    "https://va.vercel-scripts.com/v1/other.js",
  ],
];

describe("#2423 script hosts", () => {
  for (const [id, url, nearMiss] of CASES) {
    test(`${id}: ${url}`, () => {
      expect(detect(page(url))).toContain(id);
      expect(
        detect("<html><head></head><body></body></html>", [url])
      ).toContain(id);
    });
    test(`${id}: near miss ${nearMiss}`, () => {
      expect(detect(page(nearMiss))).not.toContain(id);
      expect(
        detect("<html><head></head><body></body></html>", [nearMiss])
      ).not.toContain(id);
    });
  }

  test("a code sample or link in prose does not match", () => {
    const html =
      '<html><body><pre>&lt;script src="https://analytics.ahrefs.com/analytics.js"&gt;</pre><a href="https://datafa.st/js/script.js">x</a></body></html>';
    const ids = detect(html);
    expect(ids).not.toContain("ahrefs-analytics");
    expect(ids).not.toContain("datafast");
  });
});
