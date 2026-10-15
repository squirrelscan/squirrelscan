// pub#813: a public page's link to a local-only name is development leakage.
//
// Since pub#805 the external link check does not request a name public DNS
// never resolves (`myapp.test`, `staging.example`, `x.invalid`, a `.localdomain`
// or `.home` name, a single-label host): it lists it as info under
// `refused-external-links`. Before, the request failed and the link was a broken
// one. A production page linking a developer's local site (a CMS preview's
// `http://myapp.test/`) has to stand out again, so `content/dev-leakage` warns.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import {
  classifyHost,
  devLeakageRule,
  findDevHostsInText,
  isNonProductionSeedHost,
  siteOriginOf,
  type SiteOrigin,
} from "../src/content/dev-leakage";
import type { CheckResult, ParsedPage, RuleContext, SiteData } from "../src/types";

function run(body: string, url = "https://example.com/about", baseUrl?: string): CheckResult {
  const html = `<html><head><title>t</title></head><body>${body}</body></html>`;
  const { document } = parseHTML(html);
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document } as unknown as ParsedPage,
    ...(baseUrl ? { site: { baseUrl } as unknown as SiteData } : {}),
    options: {},
  };
  const { checks } = devLeakageRule.run(ctx);
  expect(checks).toHaveLength(1);
  return checks[0] as CheckResult;
}

const site = siteOriginOf("https://example.com/") as SiteOrigin;

describe("content/dev-leakage — links to local-only names (pub#813)", () => {
  test("a public page linking http://myapp.test/ warns and names the host", () => {
    const check = run('<p>See the <a href="http://myapp.test/">new design</a>.</p>');
    expect(check.status).toBe("warn");
    expect(check.message).toContain("local-name");
    expect(check.message).toContain("http://myapp.test/");
    expect(check.items?.map((i) => i.id)).toEqual(["local-name"]);
  });

  test("every local-only zone, and a single-label host, is a local name", () => {
    for (const host of [
      "myapp.test",
      "staging.example",
      "x.invalid",
      "box.localdomain",
      "router.home",
      "nas.lan",
      "box.local",
      "db.internal",
      "router.home.arpa",
      "intranet",
    ]) {
      expect(classifyHost(host, site)).toEqual({ kind: "local-name", own: false });
    }
  });

  test("an .onion or .alt link is not: those are reachable outside public DNS", () => {
    expect(classifyHost("duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion", site)).toBeNull();
    expect(classifyHost("example.alt", site)).toBeNull();
    const check = run('<a href="http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/">Tor</a>');
    expect(check.status).toBe("pass");
  });

  test("public names that merely contain a local word are not local names", () => {
    for (const host of ["testing.com", "my.local.example.com", "lan.dev", "home.com", "example.com"]) {
      expect(classifyHost(host, site)).toBeNull();
    }
  });

  test("a single-label host: a link warns, a mention in copy cannot match (no dot)", () => {
    const check = run('<a href="http://intranet/tickets">File a ticket</a>');
    expect(check.status).toBe("warn");
    expect(check.message).toContain("http://intranet/tickets");
    expect(findDevHostsInText("File it at http://intranet/tickets today.", site)).toEqual([]);
  });

  test("an images or script src on a local name is reported too", () => {
    const check = run('<img src="http://cms.test/uploads/a.png" alt="a">');
    expect(check.status).toBe("warn");
    expect(check.items?.map((i) => i.id)).toEqual(["local-name"]);
  });

  test("in copy, only a URL with a scheme counts: a file name or a word is not a host", () => {
    expect(findDevHostsInText("Preview it at http://myapp.test/admin first.", site).map((h) => h.kind)).toEqual([
      "local-name",
    ]);
    expect(findDevHostsInText("Edit config.local and rerun app.test before you push.", site)).toEqual([]);
  });

  test("an audit of a local site skips the rule, so its links to other local names are unaffected", () => {
    expect(isNonProductionSeedHost("myapp.test")).toBe(true);
    expect(isNonProductionSeedHost("box.local")).toBe(true);
    expect(isNonProductionSeedHost("example.onion")).toBe(false);
    const check = run(
      '<a href="http://api.test/">API</a><a href="http://localhost:3000/">dev</a>',
      "http://myapp.test/",
      "http://myapp.test/",
    );
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("non-production-origin");
  });
});
