// #1253: a provider in front of a site is reported as a technology from its
// headers, cookies and markup whether or not it blocked us, and a provider is
// only attributed on its own markers: Sucuri never on a Vercel or GitHub Pages
// site, and Vercel BotID (Kasada underneath) is a technology, never a block.

import { describe, expect, test } from "bun:test";

import { inspectWafChallengePage } from "@squirrelscan/waf-detect";

import { detectReportTechnologies } from "../src/technologies";

const CONTENT = `<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1>${"<p>Real content for the page.</p>".repeat(30)}</body></html>`;

function ids(
  headers: Record<string, string>,
  html = CONTENT,
  scripts: { url: string }[] = [],
): string[] {
  return detectReportTechnologies({
    url: "https://example.com/",
    headers,
    html,
    scripts,
  }).items.map((t) => t.id);
}

describe("a provider behind a 200 content page is still a technology", () => {
  test("Akamai from its request id header", () => {
    expect(ids({ "x-akamai-request-id": "0.1", server: "TLB" })).toContain("waf-akamai");
  });

  test("DataDome from its header", () => {
    expect(ids({ "x-datadome": "protected" })).toContain("datadome");
  });

  test("Imperva from its info header and cookies", () => {
    expect(
      ids({ "x-iinfo": "1-1-1 NNNN CT", "set-cookie": "visid_incap_1=; incap_ses_1_1=" }),
    ).toContain("waf-imperva");
  });

  test("Sucuri from its own headers", () => {
    const found = ids({
      server: "Sucuri/Cloudproxy",
      "x-sucuri-id": "12345",
      "x-sucuri-cache": "MISS",
    });
    expect(found).toContain("sucuri-firewall");
  });

  test("Cloudflare from the JavaScript Detections page", () => {
    const jsd = `${CONTENT}<script>var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js'</script>`;
    expect(ids({ server: "cloudflare", "cf-ray": "0-SYD" }, jsd)).toContain("waf-cloudflare");
  });
});

describe("Vercel BotID", () => {
  const html = `${CONTENT}<script>if(!window.KPSDK)throw Error("KPSDK is not loaded");KPSDK.configure([])</script>`;
  const headers = { server: "Vercel", "x-vercel-id": "sfo1::TEST" };

  test("is reported as the Kasada technology on top of Vercel", () => {
    const found = ids(headers, html);
    expect(found).toContain("kasada");
    expect(found).toContain("vercel");
  });

  test("is never a block when the response is 200 content", () => {
    expect(
      inspectWafChallengePage({ status: 200, headers: { server: "Vercel", raw: headers }, html })
        .detected,
    ).toBe(false);
  });
});

describe("Sucuri is only attributed on Sucuri's own markers", () => {
  test("not on a Vercel site", () => {
    expect(
      ids({
        server: "Vercel",
        "x-vercel-id": "sfo1::TEST",
        "x-vercel-cache": "HIT",
        "set-cookie": "authjs.csrf-token=",
      }),
    ).not.toContain("sucuri-firewall");
    expect(ids({ server: "Vercel", "x-vercel-id": "sfo1::TEST" })).not.toContain("waf-sucuri");
  });

  test("not on a GitHub Pages site", () => {
    const headers = {
      server: "GitHub.com",
      "x-github-request-id": "ABCD:1234",
      via: "1.1 varnish",
      "x-served-by": "cache-syd10000-SYD",
    };
    expect(ids(headers)).not.toContain("sucuri-firewall");
    expect(ids(headers)).not.toContain("waf-sucuri");
  });

  test("not on a page that talks about Sucuri", () => {
    const html = `<html><body><h1>Is Sucuri worth it?</h1><p>Sucuri WebSite Firewall can show an Access Denied page.</p></body></html>`;
    expect(ids({ server: "nginx" }, html)).not.toContain("waf-sucuri");
  });
});
