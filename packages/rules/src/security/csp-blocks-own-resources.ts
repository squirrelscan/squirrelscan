// security/csp-blocks-own-resources - a CSP that blocks the page's own resources.
//
// A policy that leaves out a host the site depends on breaks a widget or a
// tracker silently: the browser blocks it, the page still renders, and nothing
// in the HTML looks wrong. This rule finds that statically, on every page, from
// the policy that page was served with (policies differ per route, so unlike
// security/csp it never reads only the first page).
//
// Three sources of resources are matched against the directive that governs
// them: what the HTML references, third-party script URLs found inside the
// same-origin chunks the page loads (a lazy widget URL often lives only there),
// and the runtime hosts of vendors the page uses (see csp-vendors.ts).
//
// Missing CSP is security/csp's finding, so a page without an enforced policy
// passes here. A report-only policy blocks nothing and is ignored the same way.

import type { CheckItem } from "@squirrelscan/core-contracts";
import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

import { policiesAllow, parseCspPolicies, type CspFetchKind, type CspPolicy } from "./csp-source-match";
import { CSP_VENDORS, hostCategory, type VendorCategory } from "./csp-vendors";

import type { Rule, RuleContext, RuleResult } from "../types";

const MAX_ITEMS = 25;
/** Bytes of one chunk scanned for script URLs, and of all chunks of one page. */
const MAX_CHUNK_SCAN = 2_000_000;
const MAX_TOTAL_SCAN = 6_000_000;

/** Quoted absolute URL of a script file, with an optional query string. */
const CHUNK_SCRIPT_URL_RE = /(["'`])(https?:\/\/[^"'`\s\\<>]{1,300}?\.m?js)(?:\?[^"'`\s\\<>]{0,200})?\1/g;
/** A URL literal only counts when code near it loads a script. */
const SCRIPT_LOAD_HINT =
  /createElement\(\s*["']script["']\s*\)|\.src\s*=|\bimport\(|importScripts\(|loadScript|appendChild/;
/** Hosts that appear in chunks as namespaces and documentation links, never as loads. */
const IGNORED_CHUNK_HOSTS = new Set(["www.w3.org", "schema.org", "localhost", "127.0.0.1"]);

type Origin = "html" | "chunk" | "vendor";

interface Reference {
  url: URL;
  kind: CspFetchKind;
  origin: Origin;
  nonce?: string;
  integrity?: boolean;
  category?: VendorCategory;
  vendor?: string;
}

interface Blocked {
  directive: string;
  host: string;
  origin: Origin;
  category?: VendorCategory;
  example: string;
  count: number;
  vendor?: string;
}

function parseUrl(raw: string, base: string): URL | null {
  try {
    const url = new URL(raw, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return headers[key];
  }
  return undefined;
}

/** Every enforced policy for this page: the response header, plus meta http-equiv tags. */
function enforcedPolicies(ctx: RuleContext, doc: Document): CspPolicy[] {
  const header = headerValue(ctx.page.headers ?? {}, "content-security-policy");
  const policies = header ? parseCspPolicies(header) : [];
  for (const meta of querySelectorAllOutsideNoscript(doc, "meta[http-equiv]")) {
    if (meta.getAttribute("http-equiv")?.trim().toLowerCase() !== "content-security-policy") continue;
    const content = meta.getAttribute("content");
    if (content) policies.push(...parseCspPolicies(content, false));
  }
  return policies;
}

function linkKind(rel: string, as: string): CspFetchKind | undefined {
  const tokens = rel.toLowerCase().split(/\s+/);
  if (tokens.includes("modulepreload")) return "script";
  if (tokens.includes("stylesheet")) return "style";
  if (!tokens.includes("preload")) return undefined;
  switch (as.toLowerCase()) {
    case "script":
      return "script";
    case "style":
      return "style";
    case "font":
      return "font";
    case "image":
      return "img";
    case "fetch":
      return "connect";
    default:
      return undefined;
  }
}

/** What the page's markup asks the browser to fetch, resolved against the document base. */
function htmlReferences(doc: Document, base: string): Reference[] {
  const refs: Reference[] = [];
  const add = (raw: string | null, kind: CspFetchKind, el?: Element) => {
    if (!raw) return;
    const url = parseUrl(raw.trim(), base);
    if (url) {
      refs.push({
        url,
        kind,
        origin: "html",
        nonce: el?.getAttribute("nonce") || undefined,
        integrity: !!el?.getAttribute("integrity"),
      });
    }
  };

  for (const el of querySelectorAllOutsideNoscript(doc, "script[src]")) {
    add(el.getAttribute("src"), "script", el);
  }
  for (const el of querySelectorAllOutsideNoscript(doc, "link[rel][href]")) {
    const kind = linkKind(el.getAttribute("rel") ?? "", el.getAttribute("as") ?? "");
    if (kind) add(el.getAttribute("href"), kind, el);
  }
  for (const el of querySelectorAllOutsideNoscript(doc, "iframe[src]")) {
    add(el.getAttribute("src"), "frame");
  }
  for (const el of querySelectorAllOutsideNoscript(doc, "img[src]")) {
    add(el.getAttribute("src"), "img");
  }
  return refs;
}

/** Third-party script URLs that a same-origin chunk loads at runtime. */
function chunkReferences(ctx: RuleContext, pageUrls: Set<string>, pageHost: string): Reference[] {
  const refs: Reference[] = [];
  let scanned = 0;
  for (const script of ctx.site?.scripts ?? []) {
    if (!script.content || !script.sourcePages.some((p) => pageUrls.has(p))) continue;
    if (scanned >= MAX_TOTAL_SCAN) break;
    const text = script.content.slice(0, MAX_CHUNK_SCAN);
    scanned += text.length;
    for (const m of text.matchAll(CHUNK_SCRIPT_URL_RE)) {
      const at = m.index ?? 0;
      if (!SCRIPT_LOAD_HINT.test(text.slice(Math.max(0, at - 300), at + m[0].length + 300))) continue;
      const url = parseUrl(m[2]!, script.url);
      if (!url || url.hostname === pageHost || IGNORED_CHUNK_HOSTS.has(url.hostname)) continue;
      refs.push({ url, kind: "script", origin: "chunk" });
    }
  }
  return refs;
}

/** Runtime hosts of the vendors this page's HTML shows it using. */
function vendorReferences(html: string): Reference[] {
  const refs: Reference[] = [];
  for (const vendor of CSP_VENDORS) {
    if (!vendor.detect.some((re) => re.test(html))) continue;
    if (vendor.unless?.test(html)) continue;
    for (const need of vendor.needs) {
      if (need.when && !need.when.test(html)) continue;
      for (const host of need.hosts) {
        refs.push({
          url: new URL(`https://${host}/`),
          kind: need.directive,
          origin: "vendor",
          category: vendor.category,
          vendor: vendor.name,
        });
      }
    }
  }
  return refs;
}

export const cspBlocksOwnResourcesRule: Rule = {
  meta: {
    id: "security/csp-blocks-own-resources",
    name: "CSP blocks the page's own resources",
    description:
      "Checks that the page's Content-Security-Policy allows the scripts, frames, styles, images and vendor endpoints the page itself depends on",
    solution:
      "A directive that leaves out a host the page loads makes the browser block it silently: a booking widget disappears, analytics hits never arrive, a payment frame stays empty. Add each reported host to the directive named in the finding (scripts to script-src, beacons and API calls to connect-src, embeds to frame-src), then confirm in the browser console that no CSP violation remains. Wildcards are literal: *.example.com matches cdn.example.com but not example.com.",
    category: "security",
    scope: "page",
    // Reads the response header, which differs per route inside one template.
    verdictScope: "page",
    severity: "warning",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const policies = enforcedPolicies(ctx, doc);
    if (policies.length === 0) {
      return {
        checks: [
          {
            name: "csp-blocks-own-resources",
            status: "pass",
            message: "No enforced Content-Security-Policy to check (security/csp covers a missing policy)",
          },
        ],
      };
    }

    const pageUrl = parseUrl(ctx.page.finalUrl ?? ctx.page.url, ctx.page.url);
    if (!pageUrl) return { checks: [] };

    // <base href> changes how relative URLs resolve, not what 'self' means.
    const baseHref = doc.querySelector("base[href]")?.getAttribute("href");
    const base = (baseHref && parseUrl(baseHref, pageUrl.href)?.href) || pageUrl.href;

    const pageUrls = new Set([ctx.page.url, ctx.page.finalUrl].filter((u): u is string => !!u));
    const references = [
      ...htmlReferences(doc, base),
      ...chunkReferences(ctx, pageUrls, pageUrl.hostname),
      ...vendorReferences((ctx.page.html ?? "").replace(/<!--[\s\S]*?-->/g, "")),
    ];

    const blocked = new Map<string, Blocked>();
    for (const ref of references) {
      const verdict = policiesAllow(policies, ref.url, ref.kind, pageUrl, { nonce: ref.nonce, integrity: ref.integrity });
      if (verdict.allowed !== false || !verdict.directive) continue;
      const key = `${verdict.directive}\u0000${ref.url.hostname}`;
      const seen = blocked.get(key);
      if (seen) {
        seen.count++;
        // A vendor or known category outranks the first sighting of a bare host.
        if (!seen.category && ref.category) {
          seen.category = ref.category;
          seen.vendor = ref.vendor;
        }
        continue;
      }
      blocked.set(key, {
        directive: verdict.directive,
        host: ref.url.hostname,
        origin: ref.origin,
        category: ref.category ?? hostCategory(ref.url.hostname),
        example: ref.origin === "vendor" ? ref.url.origin : ref.url.href,
        count: 1,
        vendor: ref.vendor,
      });
    }

    if (blocked.size === 0) {
      return {
        checks: [
          {
            name: "csp-blocks-own-resources",
            status: "pass",
            message: "The page's CSP allows the resources it references and the vendor hosts it uses",
          },
        ],
      };
    }

    const all = [...blocked.values()];
    const hasError = all.some((b) => b.category !== undefined);
    const byDirective = new Map<string, string[]>();
    for (const b of all) byDirective.set(b.directive, [...(byDirective.get(b.directive) ?? []), b.host]);
    const summary = [...byDirective]
      .map(([directive, hosts]) => `${directive}: add ${hosts.slice(0, 5).join(", ")}${hosts.length > 5 ? ` and ${hosts.length - 5} more` : ""}`)
      .join("; ");

    const items: CheckItem[] = all.slice(0, MAX_ITEMS).map((b) => ({
      id: `${b.directive} ${b.host}`,
      label: `${b.directive}: add ${b.host}`,
      snippet: b.example,
      meta: {
        directive: b.directive,
        host: b.host,
        found: b.origin,
        ...(b.category ? { category: b.category } : {}),
        ...(b.vendor ? { vendor: b.vendor } : {}),
      },
    }));

    return {
      checks: [
        {
          name: "csp-blocks-own-resources",
          status: hasError ? "fail" : "warn",
          message: `The page's CSP blocks ${all.length} host${all.length === 1 ? "" : "s"} it depends on (${summary})`,
          items,
        },
      ],
    };
  },
};
