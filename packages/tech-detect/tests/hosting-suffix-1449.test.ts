// #1449: hosting platforms that live on a host suffix are read from the page's own host, not from a URL in the page
// HTML (see #1448). A third-party script or link on the suffix says where THAT is hosted. Synthetic fixtures.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";

const CASES: Array<{ id: string; suffix: string; header?: [string, string] }> = [
  { id: "surge-sh", suffix: "surge.sh", header: ["server", "Surge"] },
  { id: "railway-app", suffix: "railway.app", header: ["server", "railway"] },
  { id: "aws-amplify-hosting", suffix: "amplifyapp.com" },
  { id: "activecampaign", suffix: "ac-page.com" },
];

const page = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
const ids = (url: string, headers: Record<string, string>, html: string): string[] =>
  detectTechnologies({ url, headers, html }).map((t) => t.id);

for (const { id, suffix, header } of CASES) {
  describe(`${id} (${suffix})`, () => {
    test("a page on its own domain that loads a script or links to the suffix is not hosted there", () => {
      const html = page(`<script src="https://example-app.${suffix}/main.js"></script><a href="https://docs.${suffix}/">docs</a><p>see https://x.${suffix}</p>`);
      expect(ids("https://www.example.com/", {}, html)).not.toContain(id);
    });

    test("a host that only contains the suffix is not it", () => {
      for (const url of [`https://evil-${suffix}/`, `https://${suffix}.example.net/`, `https://notreally.${suffix}.example.com/`]) {
        expect(ids(url, {}, page(""))).not.toContain(id);
      }
    });

    test("the platform's own host is, with a trailing dot too", () => {
      for (const url of [`https://my-site.${suffix}/`, `https://a.b.${suffix}/page`, `https://my-site.${suffix}./`]) {
        expect(ids(url, {}, page(""))).toContain(id);
      }
    });

    if (header) {
      test("its own response header is, on any host", () => {
        expect(ids("https://www.example.com/", { [header[0]]: header[1] }, page(""))).toContain(id);
      });
    }
  });
}

// #1504: Railway's edge proxies send `server: railway`, `railway-hikari` and (the v3 proxy, per Railway's changelog) `railway-edge`.
describe("railway-app Server header values (#1504)", () => {
  for (const value of ["railway", "railway-hikari", "railway-edge", "Railway-Edge", "RAILWAY"]) {
    test(`Server: ${value} on a custom domain`, () => {
      expect(ids("https://www.example.com/", { server: value }, page(""))).toContain("railway-app");
    });
  }
  for (const value of ["railway-edge-x", "xrailway", "not-railway-edge", "railway-edges", "railway edge", "railway-"]) {
    test(`Server: ${value} is not Railway`, () => {
      expect(ids("https://www.example.com/", { server: value }, page(""))).not.toContain("railway-app");
    });
  }
});
