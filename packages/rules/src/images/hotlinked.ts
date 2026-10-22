// images/hotlinked - Content images loaded from other sites' servers (pub#932)
//
// Hotlinking: the page loads an image straight from a server it does not control
// (a logo from upload.wikimedia.org, a picture copied by URL from a supplier's or a
// news site's CDN). The image breaks when the other site moves, renames, rate-limits
// or blocks it, costs an extra DNS/TLS setup to a host nothing else on the page uses,
// and takes someone else's bandwidth and, often, their copyrighted picture.
//
// No network: URL parsing on markup the page already has. A host is NOT a hotlink when:
//   * it is first-party: the page's host, a subdomain, or any host on the same
//     registrable domain (`cdn.example.com` for `example.com`);
//   * it is a known image CDN or site-builder storage (images/optimized's list,
//     extended), which a site uses on purpose;
//   * the site itself connects to it: it also serves one of the page's scripts or
//     stylesheets, or the page preconnects or dns-prefetches it;
//   * the owner allowed it with `allowed_hosts`.
// Skipped: tracking pixels (1x1, or a known analytics host), avatar services
// (Gravatar and similar), data: and blob: URLs, anything inside `<noscript>`.
//
// One finding per page, grouped by host: an item per host, so a report can say
// "6 images on 3 pages load from upload.wikimedia.org". The message carries no host or
// count, so one defect keeps one identity across pages.

import { z } from "zod";

import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

import { registrableDomain } from "../content/dev-leakage";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

/**
 * Image CDNs and site-builder or object storage a site uses on purpose. A host
 * matches when it equals an entry or is a subdomain of it. Extends the list in
 * images/optimized.
 */
export const KNOWN_IMAGE_HOSTS: readonly string[] = [
  "cloudinary.com",
  "imgix.net",
  "imagekit.io",
  "imagedelivery.net",
  "cloudfront.net",
  "cdn.shopify.com",
  "shopify.com",
  "shopifycdn.com",
  "wp.com",
  "wordpress.com",
  "squarespace-cdn.com",
  "squarespace.com",
  "sqspcdn.com",
  "wixstatic.com",
  "wixmp.com",
  "ctfassets.net",
  "contentful.com",
  "cdn.sanity.io",
  "sanity.io",
  "media.graphassets.com",
  "graphassets.com",
  "storyblok.com",
  "prismic.io",
  "website-files.com",
  "webflow.com",
  "webflow.io",
  "ghost.io",
  "statically.io",
  "b-cdn.net",
  "kxcdn.com",
  "fastly.net",
  "akamaized.net",
  "azureedge.net",
  "blob.core.windows.net",
  "amazonaws.com",
  "storage.googleapis.com",
  "digitaloceanspaces.com",
  "supabase.co",
  "vercel-storage.com",
  "images.unsplash.com",
  "plus.unsplash.com",
  "images.pexels.com",
  "twimg.com",
  "fbcdn.net",
  "googleusercontent.com",
  "ggpht.com",
  "ytimg.com",
];

/** Avatar services: a user's picture shown by design, not a copied content image. */
const AVATAR_HOSTS: readonly string[] = [
  "gravatar.com",
  "avatars.githubusercontent.com",
  "secure.gravatar.com",
  "libravatar.org",
  "unavatar.io",
];

/** Analytics and ad hosts whose images are measurement beacons. */
const TRACKING_HOSTS: readonly string[] = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "googleadservices.com",
  "facebook.com",
  "facebook.net",
  "px.ads.linkedin.com",
  "analytics.twitter.com",
  "t.co",
  "bat.bing.com",
  "ads.pubmatic.com",
  "scorecardresearch.com",
  "quantserve.com",
  "hotjar.com",
  "pixel.wp.com",
  "stats.wp.com",
  "pinterest.com",
  "tiktok.com",
  "snapchat.com",
  "adsrvr.org",
  "criteo.com",
  "criteo.net",
  "demdex.net",
  "omtrdc.net",
];

const MAX_ITEMS = 10;

export const optionsSchema = z.object({
  allowed_hosts: z
    .array(z.string())
    .default([])
    .describe(
      "Hosts whose images are not hotlinks (your own CDN or a partner). An entry matches the host itself and its subdomains, e.g. images.example-partner.com"
    ),
  check_social_images: z
    .boolean()
    .default(true)
    .describe("Also report an og:image or twitter:image hosted on another site (info)"),
});

function hostMatches(host: string, entry: string): boolean {
  return host === entry || host.endsWith(`.${entry}`);
}

function matchesAny(host: string, list: readonly string[]): boolean {
  return list.some((entry) => hostMatches(host, entry));
}

function normalizeEntry(entry: string): string {
  return entry
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/:?#].*$/, "")
    .replace(/^\*\./, "")
    .replace(/\.$/, "");
}

/** The host of an image URL resolved against the page, or null for a URL that is no network image. */
function imageHost(raw: string, base: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || /^(?:data|blob|about|javascript):/i.test(value)) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/** URLs of a `srcset` value, one per candidate. */
function srcsetUrls(srcset: string): string[] {
  const out: string[] = [];
  for (const candidate of srcset.split(/,(?=\s|$)|,\s+/)) {
    const url = candidate.trim().split(/\s+/)[0];
    if (url) out.push(url);
  }
  return out;
}

/** `url(...)` targets of an inline `style`'s background declarations. */
function backgroundUrls(style: string): string[] {
  const out: string[] = [];
  for (const decl of style.split(";")) {
    if (!/^\s*background(?:-image)?\s*:/i.test(decl)) continue;
    for (const m of decl.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi)) {
      const url = m[1] ?? m[2] ?? m[3];
      if (url) out.push(url);
    }
  }
  return out;
}

function isOnePixel(el: Element): boolean {
  const n = (v: string | null): number | null => {
    if (v === null) return null;
    const num = Number.parseFloat(v);
    return Number.isFinite(num) ? num : null;
  };
  const w = n(el.getAttribute("width"));
  const h = n(el.getAttribute("height"));
  return w !== null && h !== null && w <= 1 && h <= 1;
}

/** Hosts the page connects to on purpose: its scripts, stylesheets and preconnect hints. */
function connectedHosts(doc: Document, base: string): Set<string> {
  const hosts = new Set<string>();
  const add = (raw: string | null): void => {
    if (!raw) return;
    const host = imageHost(raw, base);
    if (host) hosts.add(host);
  };
  for (const el of doc.querySelectorAll("script[src]")) add(el.getAttribute("src"));
  for (const el of doc.querySelectorAll("link[href]")) {
    const rel = (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    if (rel.some((r) => r === "stylesheet" || r === "preconnect" || r === "dns-prefetch" || r === "preload" || r === "modulepreload")) {
      add(el.getAttribute("href"));
    }
  }
  return hosts;
}

export const hotlinkedRule: Rule = {
  meta: {
    id: "images/hotlinked",
    name: "Hotlinked Images",
    description: "Checks for content images loaded from other sites' servers",
    solution:
      "A hotlinked image is loaded straight from a server you do not control. It breaks when that site moves it, renames it, rate-limits it or blocks foreign referrers, it costs an extra connection to a host nothing else on the page uses, and it uses someone else's bandwidth and often their copyrighted picture. Download the image (with permission, or one you are licensed to use) and serve it from your own domain or image CDN. If the host is your own CDN or a partner you are sure of, add it to the rule's allowed_hosts option.",
    category: "images",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 4,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const opts = optionsSchema.parse(ctx.options);
    const checks: CheckResult[] = [];

    const pageUrl = ctx.page.url;
    const pageHost = imageHost(pageUrl, pageUrl);
    if (!pageHost) return { checks: [] };

    const firstParty = new Set<string>([registrableDomain(pageHost)]);
    const baseHost = imageHost(ctx.site?.baseUrl ?? "", pageUrl);
    if (baseHost) firstParty.add(registrableDomain(baseHost));
    const allowed = opts.allowed_hosts.map(normalizeEntry).filter((e) => e.length > 0);
    const connected = connectedHosts(doc as unknown as Document, pageUrl);

    /** Whether a host is a third-party host the page does not use on purpose. */
    const isHotlinkHost = (host: string): boolean => {
      if (firstParty.has(registrableDomain(host))) return false;
      if (matchesAny(host, KNOWN_IMAGE_HOSTS) || matchesAny(host, allowed)) return false;
      if (matchesAny(host, AVATAR_HOSTS) || matchesAny(host, TRACKING_HOSTS)) return false;
      if (connected.has(host)) return false;
      return true;
    };

    const perHost = new Map<string, number>();
    let contentImages = 0;
    const note = (host: string | null): void => {
      if (!host) return;
      contentImages++;
      if (isHotlinkHost(host)) perHost.set(host, (perHost.get(host) ?? 0) + 1);
    };

    for (const img of querySelectorAllOutsideNoscript(doc, "img")) {
      if (isOnePixel(img)) continue;
      const style = img.getAttribute("style") ?? "";
      if (/display\s*:\s*none/i.test(style)) continue;
      const urls = [
        img.getAttribute("src"),
        img.getAttribute("data-src"),
        img.getAttribute("data-lazy-src"),
        ...srcsetUrls(img.getAttribute("srcset") ?? ""),
        ...srcsetUrls(img.getAttribute("data-srcset") ?? ""),
      ];
      // One image counts once, by the host of its first usable URL.
      for (const raw of urls) {
        const host = raw ? imageHost(raw, pageUrl) : null;
        if (host) {
          note(host);
          break;
        }
      }
    }
    for (const source of querySelectorAllOutsideNoscript(doc, "picture source")) {
      const first = srcsetUrls(source.getAttribute("srcset") ?? "")[0];
      if (first) note(imageHost(first, pageUrl));
    }
    for (const el of querySelectorAllOutsideNoscript(doc, "[style]")) {
      if (el.tagName === "IMG") continue;
      const style = el.getAttribute("style") ?? "";
      if (!/background/i.test(style)) continue;
      for (const raw of backgroundUrls(style)) note(imageHost(raw, pageUrl));
    }

    if (perHost.size > 0) {
      const hosts = [...perHost.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const total = hosts.reduce((n, [, c]) => n + c, 0);
      checks.push({
        name: "hotlinked-images",
        status: "warn",
        message: "Content image(s) load from other sites' servers",
        value: total,
        expected: "Images served from your own domain or an image CDN you use",
        items: hosts.slice(0, MAX_ITEMS).map(([host, count]) => ({
          id: host,
          label: `${count} image${count === 1 ? "" : "s"}`,
          meta: { images: count },
        })),
        ...(hosts.length > MAX_ITEMS ? { details: { additional: hosts.length - MAX_ITEMS } } : {}),
      });
    } else if (contentImages > 0) {
      checks.push({
        name: "hotlinked-images",
        status: "pass",
        message: "No content images are loaded from other sites' servers",
        value: contentImages,
      });
    }

    if (opts.check_social_images) {
      const shared = [
        ["og:image", ctx.parsed.og?.image],
        ["twitter:image", ctx.parsed.twitter?.image],
      ] as const;
      const hotlinked: Array<{ id: string; label: string }> = [];
      for (const [name, raw] of shared) {
        const host = raw ? imageHost(raw, pageUrl) : null;
        if (host && isHotlinkHost(host)) hotlinked.push({ id: host, label: name });
      }
      if (hotlinked.length > 0) {
        checks.push({
          name: "hotlinked-share-image",
          status: "info",
          message: "A share image (og:image or twitter:image) loads from another site's server",
          items: hotlinked,
        });
      }
    }

    if (checks.length === 0) {
      checks.push({ name: "hotlinked-images", status: "info", message: "No content images found" });
    }
    return { checks };
  },
};
