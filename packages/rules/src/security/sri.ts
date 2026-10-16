// security/sri - Subresource Integrity on cross-origin scripts/styles

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

// A bare hostname: labels of letters, digits and hyphens, an optional
// terminal dot, no scheme, port or path.
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.?$/i;

/** A hostname compared without case or a terminal dot: `A.com.` is `a.com`. */
function hostKey(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

export const optionsSchema = z.object({
  exempt_hosts: z
    .array(
      z
        .string()
        .regex(HOSTNAME, "must be a hostname such as static.example.com, with no scheme, port or path")
    )
    .default([])
    .describe("Extra hostnames whose scripts and stylesheets update in place, exempt from the check"),
});

// A handful of widely-deployed third-party SDKs that explicitly document SRI
// as unsupported: their script content changes server-side (fraud detection,
// A/B tests, PCI-relevant patches) without a corresponding URL change, so a
// pinned integrity hash would go stale and silently break the embed. Flagging
// these would be bad advice, not a real finding — see e.g. Stripe's own docs
// ("Don't use SRI with Stripe.js — we update it frequently and don't publish
// hashes") and Google's reCAPTCHA/GTM guidance (same rationale). Kept small
// and hostname-based; anything not on this list still gets checked normally.
const SRI_EXEMPT_HOSTNAMES = new Set([
  "js.stripe.com",
  "checkout.stripe.com",
  "www.paypal.com",
  "www.paypalobjects.com",
  "www.google.com", // recaptcha
  "www.gstatic.com", // recaptcha assets
  "js.hcaptcha.com",
  "www.googletagmanager.com",
  "www.google-analytics.com",
  "ssl.google-analytics.com",
  "connect.facebook.net",
]);

// Hosts that serve both kinds of file: only the paths the platform updates in
// place are exempt (pub#546). Shopify injects its own `/shopifycloud/` and
// `/storefront/` scripts into every store, so the owner cannot pin them, while
// theme and app assets elsewhere on `cdn.shopify.com` are versioned and can
// carry a hash.
const SRI_EXEMPT_PATH_PREFIXES = new Map<string, readonly string[]>([
  ["cdn.shopify.com", ["/shopifycloud/", "/storefront/"]],
]);

/** Whether the resource at `url` is one its vendor updates in place. */
function isSriExempt(url: URL, extraHosts: ReadonlySet<string>): boolean {
  const host = hostKey(url.hostname);
  if (SRI_EXEMPT_HOSTNAMES.has(host) || extraHosts.has(host)) return true;
  const prefixes = SRI_EXEMPT_PATH_PREFIXES.get(host);
  return prefixes?.some((prefix) => url.pathname.startsWith(prefix)) ?? false;
}

/**
 * Resolve a possibly-relative/protocol-relative resource URL against the page
 * URL as the base, so `//cdn.example.com/x.js` and `/local.js` both resolve
 * correctly (unlike `new URL(url)` with no base, which throws for both —
 * silently treating them as "no origin"). `null` on a genuinely unparseable URL.
 */
function resolveUrl(url: string, baseUrl: string): URL | null {
  try {
    return new URL(url, baseUrl);
  } catch {
    return null;
  }
}

/**
 * Resolve a resource reference against the page URL and, only if it's a
 * fetchable cross-origin http(s) resource, return the resolved URL —
 * otherwise `null` (relative/same-origin/data:/blob:/mailto:/ftp:/etc.).
 * `.origin` is the literal string "null" for data:/blob:, not empty, so
 * `.hostname` must be checked separately from the same-origin comparison.
 */
function crossOriginResource(url: string, pageUrl: string, pageOrigin: string): URL | null {
  const resolved = resolveUrl(url, pageUrl);
  if (!resolved || !resolved.hostname) return null;
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  if (resolved.origin === pageOrigin) return null;
  return resolved;
}

interface FlaggedResource {
  type: "script" | "stylesheet";
  url: string;
}

export const sriRule: Rule = {
  meta: {
    id: "security/sri",
    name: "Subresource Integrity",
    description: "Checks that cross-origin scripts and stylesheets use Subresource Integrity (SRI)",
    solution:
      'Cross-origin scripts and stylesheets can be tampered with in transit or at the source (a compromised CDN or third-party host), and the browser has no way to detect it without help. Add an integrity attribute with a sha256/sha384/sha512 hash of the expected file, plus crossorigin="anonymous": <script src="..." integrity="sha384-..." crossorigin="anonymous"></script>. Most CDNs (jsDelivr, cdnjs, unpkg) publish the hash alongside the URL. This only works for pinned/versioned assets — scripts that update themselves server-side (analytics, payment SDKs, CAPTCHAs) intentionally don\'t support it: list such a host in the exempt_hosts option rather than pinning a hash that will go stale.',
    category: "security",
    scope: "page",
    verdictScope: "template",
    severity: "warning",
    weight: 5,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const opts = optionsSchema.parse(ctx.options);
    const extraHosts = new Set(opts.exempt_hosts.map(hostKey));

    const pageUrl = resolveUrl(ctx.page.url, ctx.page.url);
    const pageOrigin = pageUrl?.origin ?? "";
    const flagged: FlaggedResource[] = [];
    let crossOriginTotal = 0;

    const scripts = querySelectorAllOutsideNoscript(doc, "script[src]");
    for (const script of scripts) {
      const src = script.getAttribute("src");
      if (!src) continue;
      const resolved = crossOriginResource(src, ctx.page.url, pageOrigin);
      if (!resolved) continue;
      crossOriginTotal++;
      if (isSriExempt(resolved, extraHosts)) continue;
      if (!script.getAttribute("integrity")) {
        flagged.push({ type: "script", url: src });
      }
    }

    // `rel~=` (token-list match) so `rel="preload stylesheet"` and
    // `rel="alternate stylesheet"` are caught too, not just an exact
    // `rel="stylesheet"` — matches the convention in performance/font-delivery.ts.
    const stylesheets = querySelectorAllOutsideNoscript(doc, 'link[rel~="stylesheet"][href]');
    for (const link of stylesheets) {
      const href = link.getAttribute("href");
      if (!href) continue;
      const resolved = crossOriginResource(href, ctx.page.url, pageOrigin);
      if (!resolved) continue;
      crossOriginTotal++;
      if (isSriExempt(resolved, extraHosts)) continue;
      if (!link.getAttribute("integrity")) {
        flagged.push({ type: "stylesheet", url: href });
      }
    }

    const checks: CheckResult[] = [];

    if (crossOriginTotal === 0) {
      checks.push({
        name: "sri",
        status: "info",
        message: "No cross-origin scripts or stylesheets on this page — SRI not applicable",
      });
      return { checks };
    }

    if (flagged.length > 0) {
      checks.push({
        name: "sri",
        status: "warn",
        message: `${flagged.length} cross-origin resource(s) without Subresource Integrity`,
        items: flagged.map((f) => ({ id: f.url, label: f.type })),
      });
    } else {
      checks.push({
        name: "sri",
        status: "pass",
        message: "All cross-origin scripts and stylesheets use Subresource Integrity",
      });
    }

    return { checks };
  },
};
