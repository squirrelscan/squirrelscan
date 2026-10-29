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
    ).toContain("imperva-incapsula");
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

describe("a provider is one technology, not a fingerprint and a waf- twin", () => {
  test("DataDome, Sucuri and Imperva each appear once", () => {
    const found = ids({
      "x-datadome": "protected",
      "x-sucuri-id": "1",
      "x-iinfo": "1-1-1",
    });
    for (const id of ["datadome", "sucuri-firewall", "imperva-incapsula"]) {
      expect(found.filter((x) => x === id)).toHaveLength(1);
    }
    for (const twin of ["waf-datadome", "waf-sucuri", "waf-imperva"])
      expect(found).not.toContain(twin);
  });
});

describe("F5 BIG-IP", () => {
  test("from its persistence cookie or Server header", () => {
    expect(ids({ "set-cookie": "BIGipServerpool_web=\nTS0123=" })).toContain("f5-big-ip");
    expect(ids({ server: "BigIP" })).toContain("f5-big-ip");
  });

  test("not from a page that mentions it", () => {
    const html = `<html><body><p>Set the BIGipServer cookie on the pool.</p></body></html>`;
    expect(ids({ server: "nginx" }, html)).not.toContain("f5-big-ip");
  });
});

describe("the other providers from their documented signals", () => {
  test("HUMAN from its cookie, AWS WAF from its action header and token cookie", () => {
    expect(ids({ "set-cookie": "_pxvid=; _px3=" })).toContain("human-perimeterx");
    expect(ids({ "x-amzn-waf-action": "challenge" })).toContain("waf-aws-waf");
    expect(ids({ "set-cookie": "aws-waf-token=" })).toContain("waf-aws-waf");
  });
});

describe("Vercel BotID", () => {
  const html = `${CONTENT}<script>if(!window.KPSDK)throw Error("KPSDK is not loaded");KPSDK.configure([])</script>`;
  const headers = { server: "Vercel", "x-vercel-id": "sfo1::TEST" };

  test("is reported as Vercel BotID on top of Vercel, not as Kasada", () => {
    const found = ids(headers, html);
    expect(found).toContain("vercel-botid");
    expect(found).toContain("vercel");
    expect(found).not.toContain("kasada");
    expect(found).not.toContain("waf-kasada");
  });

  test("a Kasada client off Vercel stays Kasada, once", () => {
    const found = ids({ server: "nginx" }, html);
    expect(found).toContain("kasada");
    expect(found).not.toContain("waf-kasada");
    expect(found).not.toContain("vercel-botid");
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
