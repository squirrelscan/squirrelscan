// images/hotlinked (pub#932): content images loaded from other sites' servers.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { hotlinkedRule } from "../src/images/hotlinked";
import type { ParsedPage, RuleContext } from "../src/types";

function run(
  body: string,
  opts: { head?: string; options?: Record<string, unknown>; url?: string } = {},
): CheckResult[] {
  const url = opts.url ?? "https://example.com/blog/post";
  const html = `<!doctype html><html lang="en"><head><title>t</title>${opts.head ?? ""}</head><body>${body}</body></html>`;
  const out = hotlinkedRule.run({
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null },
    options: opts.options ?? {},
  } as unknown as RuleContext);
  if (out instanceof Promise) throw new Error("sync rule");
  return out.checks;
}

const hosts = (c: CheckResult | undefined) => (c?.items ?? []).map((i) => i.id);
const warn = (checks: CheckResult[]) => checks.find((c) => c.name === "hotlinked-images");

describe("hotlinked content images", () => {
  test("an image from another site warns, naming the host", () => {
    const checks = run('<img src="https://upload.wikimedia.org/wikipedia/commons/a/ab/Logo.png" alt="logo">');
    const c = warn(checks);
    expect(c?.status).toBe("warn");
    expect(hosts(c)).toEqual(["upload.wikimedia.org"]);
    expect(c?.message).toBe("Content image(s) load from other sites' servers");
  });

  test("findings are grouped per host with an image count", () => {
    const c = warn(
      run(
        '<img src="https://upload.wikimedia.org/a.png"><img src="https://upload.wikimedia.org/b.png">' +
          '<img src="https://news.example.org/c.jpg"><img src="/own.png">',
      ),
    );
    expect(c?.items?.map((i) => [i.id, i.label])).toEqual([
      ["upload.wikimedia.org", "2 images"],
      ["news.example.org", "1 image"],
    ]);
    expect(c?.value).toBe(3);
  });

  test("the page-invariant message carries no host or count", () => {
    const a = warn(run('<img src="https://a.example.org/x.png">'));
    const b = warn(run('<img src="https://b.example.net/x.png"><img src="https://c.example.net/x.png">'));
    expect(a?.message).toBe(b?.message);
  });

  test("picture sources, srcset candidates, lazy data-src and inline backgrounds count", () => {
    const body =
      '<picture><source srcset="https://pics.example.org/a.webp 1x"><img src="/fallback.jpg"></picture>' +
      '<img src="data:image/gif;base64,R0lGOD" data-src="https://lazy.example.org/b.jpg">' +
      '<img src="/small.jpg" srcset="/small.jpg 1x, https://srcset.example.org/big.jpg 2x">' +
      '<div style="background-image:url(\'https://bg.example.org/hero.jpg\')"></div>';
    const found = hosts(warn(run(body))).sort();
    // The srcset image's first usable URL is its own src, so only the others count.
    expect(found).toEqual(["bg.example.org", "lazy.example.org", "pics.example.org"]);
  });
});

describe("first-party and allowlisted hosts", () => {
  test("the page's host, subdomains and the same registrable domain are first-party", () => {
    const c = run(
      '<img src="https://example.com/a.png"><img src="https://cdn.example.com/b.png">' +
        '<img src="https://www.example.com/c.png"><img src="https://img.shop.example.com/d.png">',
    );
    expect(warn(c)?.status).toBe("pass");
  });

  test("a lookalike host is not first-party", () => {
    expect(hosts(warn(run('<img src="https://notexample.com/a.png"><img src="https://example.com.evil.test/b.png">'))).sort()).toEqual([
      "example.com.evil.test",
      "notexample.com",
    ]);
  });

  test("known image CDNs and site-builder storage are allowed", () => {
    const body = [
      "https://res.cloudinary.com/demo/a.jpg",
      "https://assets.imgix.net/b.jpg",
      "https://d111111abcdef8.cloudfront.net/c.jpg",
      "https://cdn.shopify.com/s/files/d.jpg",
      "https://i0.wp.com/site.com/e.jpg",
      "https://images.ctfassets.net/f.jpg",
      "https://cdn.sanity.io/images/g.jpg",
      "https://static.wixstatic.com/h.jpg",
      "https://images.squarespace-cdn.com/i.jpg",
      "https://assets-global.website-files.com/j.jpg",
    ]
      .map((src) => `<img src="${src}">`)
      .join("");
    expect(warn(run(body))?.status).toBe("pass");
  });

  test("a host the page also loads scripts, styles or preconnects from is the site's own", () => {
    const head =
      '<script src="https://static.partner-cdn.net/app.js"></script>' +
      '<link rel="stylesheet" href="https://styles.other-cdn.net/site.css">' +
      '<link rel="preconnect" href="https://media.third-cdn.net">';
    const body =
      '<img src="https://static.partner-cdn.net/a.png"><img src="https://styles.other-cdn.net/b.png">' +
      '<img src="https://media.third-cdn.net/c.png">';
    expect(warn(run(body, { head }))?.status).toBe("pass");
    expect(warn(run(body))?.status).toBe("warn");
  });

  test("a host added with allowed_hosts is allowed, with its subdomains, in any spelling", () => {
    const body = '<img src="https://images.partner.example.org/a.png"><img src="https://partner.example.org/b.png">';
    expect(warn(run(body))?.status).toBe("warn");
    for (const entry of ["partner.example.org", "https://Partner.Example.org/", "*.partner.example.org", "partner.example.org:443"]) {
      expect(warn(run(body, { options: { allowed_hosts: [entry] } }))?.status).toBe("pass");
    }
    // Only the named host and its subdomains.
    expect(warn(run('<img src="https://other.example.org/a.png">', { options: { allowed_hosts: ["partner.example.org"] } }))?.status).toBe("warn");
  });
});

describe("skips", () => {
  test("a 1x1 tracking pixel from a third-party host is not a finding", () => {
    const body =
      '<img src="https://tracker.example.net/p.gif" width="1" height="1">' +
      '<img src="https://pixel.example.net/p.gif" width="0" height="0">' +
      '<img src="https://www.google-analytics.com/collect?v=1">' +
      '<img src="https://www.facebook.com/tr?id=1&ev=PageView">' +
      '<img src="https://hidden.example.net/p.gif" style="display:none">';
    expect(run(body).some((c) => c.status === "warn" || c.status === "fail")).toBe(false);
    // The 1x1 and display:none images are not content images at all.
    expect(warn(run('<img src="https://tracker.example.net/p.gif" width="1" height="1">'))?.status).toBe("info");
  });

  test("avatar services are skipped", () => {
    const body = '<img src="https://secure.gravatar.com/avatar/abc?s=64"><img src="https://avatars.githubusercontent.com/u/1">';
    expect(warn(run(body))?.status).toBe("pass");
  });

  test("data and blob URLs, relative URLs and images inside noscript are not hotlinks", () => {
    const body =
      '<img src="data:image/png;base64,iVBOR"><img src="blob:https://example.com/1"><img src="images/a.png">' +
      '<noscript><img src="https://noscript.example.org/a.png"></noscript>';
    expect(warn(run(body))?.status).toBe("pass");
  });

  test("a page with no images reports info, not a pass", () => {
    expect(run("<p>none</p>")[0]).toMatchObject({ name: "hotlinked-images", status: "info" });
  });
});

describe("share images", () => {
  const meta = (img: string) =>
    `<meta property="og:image" content="${img}"><meta name="twitter:image" content="${img}">`;

  test("an og:image on another site is info, naming the host", () => {
    const checks = run('<img src="/a.png">', { head: meta("https://cdn.news-site.org/share.jpg") });
    const c = checks.find((x) => x.name === "hotlinked-share-image");
    expect(c?.status).toBe("info");
    expect(c?.items?.map((i) => [i.id, i.label])).toEqual([
      ["cdn.news-site.org", "og:image"],
      ["cdn.news-site.org", "twitter:image"],
    ]);
    expect(checks.find((x) => x.name === "hotlinked-images")?.status).toBe("pass");
  });

  test("a first-party or CDN share image is fine, and the option turns the check off", () => {
    expect(run('<img src="/a.png">', { head: meta("https://example.com/share.jpg") }).some((c) => c.name === "hotlinked-share-image")).toBe(false);
    expect(run('<img src="/a.png">', { head: meta("https://res.cloudinary.com/x/share.jpg") }).some((c) => c.name === "hotlinked-share-image")).toBe(false);
    expect(
      run('<img src="/a.png">', { head: meta("https://cdn.news-site.org/share.jpg"), options: { check_social_images: false } }).some(
        (c) => c.name === "hotlinked-share-image",
      ),
    ).toBe(false);
  });
});

describe("robustness", () => {
  test("malformed URLs and srcset values never throw", () => {
    const body =
      '<img src="http://"><img src="https://"><img src="//"><img srcset=", , ,"><img src="  ">' +
      '<div style="background:url(">x</div><img src="https://ok.example.org/a.png">';
    expect(hosts(warn(run(body)))).toEqual(["ok.example.org"]);
  });

  test("a protocol-relative URL resolves against the page", () => {
    expect(hosts(warn(run('<img src="//other.example.org/a.png">')))).toEqual(["other.example.org"]);
  });

  test("an IP-literal or localhost host that is not the page's is a hotlink", () => {
    expect(hosts(warn(run('<img src="http://203.0.113.9/a.png">')))).toEqual(["203.0.113.9"]);
  });

  test("a 3,000-image page stays fast", () => {
    const body = Array.from({ length: 3000 }, (_, i) => `<img src="https://h${i % 50}.example.org/${i}.png">`).join("");
    const started = performance.now();
    run(body);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
