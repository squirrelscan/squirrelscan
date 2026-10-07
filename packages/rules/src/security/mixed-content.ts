// security/mixed-content - HTTPS page loading HTTP resources
//
// Only markup that makes the browser fetch a subresource can be mixed
// content. `<link rel="canonical">` and `rel="alternate"` are metadata, and
// loopback hosts are "potentially trustworthy" origins that the Mixed Content
// spec exempts, so neither is reported as a fetched insecure resource. What is
// left is split by what a browser does with the request:
//   blockable   scripts, stylesheets, frames, plugins, fonts, IP-literal hosts
//   upgradable  images, audio, video, icons (auto-upgraded, blocked on failure)
// These are static findings read from markup, not insecure loads observed in a
// browser.
// https://www.w3.org/TR/mixed-content/ , https://www.w3.org/TR/secure-contexts/

import type { Rule, RuleContext, RuleResult, CheckResult, CheckItem } from "../types";

import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

type Treatment = "blockable" | "upgradable";

interface Candidate {
  selector: string;
  attribute: string;
}

const CANDIDATES: Candidate[] = [
  { selector: "img", attribute: "src" },
  { selector: "script", attribute: "src" },
  { selector: "link", attribute: "href" },
  { selector: "iframe", attribute: "src" },
  { selector: "video", attribute: "src" },
  { selector: "audio", attribute: "src" },
  { selector: "source", attribute: "src" },
  { selector: "embed", attribute: "src" },
  { selector: "object", attribute: "data" },
];

const ICON_RELS = new Set(["icon", "shortcut", "apple-touch-icon", "apple-touch-icon-precomposed"]);
const BLOCKABLE_LINK_RELS = new Set(["stylesheet", "modulepreload", "manifest", "prefetch"]);
const BLOCKABLE_PRELOAD_AS = new Set(["script", "style", "font", "fetch", "worker", "document"]);

const HTTP_PREFIX = /^http:\/\//i;

function parseHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** "Potentially trustworthy" loopback hosts, per Secure Contexts. */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isIpLiteral(host: string): boolean {
  return host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** How a browser treats this element's request; null when it fetches nothing. */
function treatmentFor(el: Element, tag: string): Treatment | null {
  switch (tag) {
    case "img":
    case "video":
    case "audio":
    case "source":
      return "upgradable";
    case "link": {
      const rels = (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (rels.some((r) => BLOCKABLE_LINK_RELS.has(r))) return "blockable";
      if (rels.includes("preload")) {
        const as = (el.getAttribute("as") ?? "").toLowerCase();
        return BLOCKABLE_PRELOAD_AS.has(as) ? "blockable" : "upgradable";
      }
      if (rels.some((r) => ICON_RELS.has(r) || r === "mask-icon")) return "upgradable";
      // canonical, alternate, author, next, prev, dns-prefetch... fetch no subresource
      return null;
    }
    default:
      return "blockable";
  }
}

function describe(el: Element, tag: string, attribute: string): string {
  const rel = tag === "link" ? el.getAttribute("rel") : null;
  return rel ? `<link rel="${rel}" ${attribute}>` : `<${tag} ${attribute}>`;
}

export const mixedContentRule: Rule = {
  meta: {
    id: "security/mixed-content",
    name: "Mixed Content",
    description: "Checks for HTTP resources on HTTPS pages",
    solution:
      "Mixed content occurs when an HTTPS page loads resources over HTTP, breaking the security chain. Browsers block active content (scripts, stylesheets, frames) and upgrade or block passive content (images, audio, video). Update the listed resource URLs to use HTTPS. Links that only describe the page (canonical, alternate) are not fetched and are not reported. Use Content-Security-Policy: upgrade-insecure-requests to automatically upgrade HTTP to HTTPS while you fix the markup.",
    category: "security",
    scope: "page",
    verdictScope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const isHttps = ctx.page.url.startsWith("https://");

    if (!isHttps) {
      checks.push({
        name: "mixed-content",
        status: "info",
        message: "Mixed content check not applicable - page not HTTPS",
      });
      return { checks };
    }

    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const mixed: CheckItem[] = [];
    const local: CheckItem[] = [];
    let blockable = 0;
    let upgradable = 0;

    for (const { selector, attribute } of CANDIDATES) {
      for (const el of querySelectorAllOutsideNoscript(doc, `${selector}[${attribute}]`)) {
        const url = el.getAttribute(attribute)?.trim();
        if (!url || !HTTP_PREFIX.test(url)) continue;
        const treatment = treatmentFor(el, selector);
        if (!treatment) continue;

        const host = parseHost(url);
        const label = describe(el, selector, attribute);
        const meta: Record<string, unknown> = {
          tag: selector,
          attribute,
          evidence: "static-markup",
        };
        const rel = el.getAttribute("rel");
        if (selector === "link" && rel) meta.rel = rel;

        if (host && isLoopbackHost(host)) {
          local.push({ id: url, label, meta: { ...meta, kind: "local-development" } });
          continue;
        }

        // Browsers block, rather than upgrade, requests to IP-literal hosts.
        const effective: Treatment = host && isIpLiteral(host) ? "blockable" : treatment;
        if (effective === "blockable") blockable++;
        else upgradable++;
        mixed.push({
          id: url,
          label,
          meta: {
            ...meta,
            kind: effective === "blockable" ? "potentially-blocked" : "potentially-upgraded",
          },
        });
      }
    }

    if (mixed.length > 0) {
      const parts: string[] = [];
      if (blockable > 0) parts.push(`${blockable} potentially blocked`);
      if (upgradable > 0) parts.push(`${upgradable} potentially upgraded`);
      checks.push({
        name: "mixed-content",
        status: "fail",
        message: `${mixed.length} HTTP resource(s) on HTTPS page (${parts.join(", ")}; from markup, not observed loads)`,
        items: mixed,
      });
    } else {
      checks.push({
        name: "mixed-content",
        status: "pass",
        message: "No mixed content detected",
      });
    }

    if (local.length > 0) {
      checks.push({
        name: "local-development-url",
        status: "warn",
        message: `${local.length} loopback HTTP URL(s) in markup: exempt from mixed-content blocking, but they only resolve on the developer's machine`,
        items: local,
      });
    }

    return { checks };
  },
};
