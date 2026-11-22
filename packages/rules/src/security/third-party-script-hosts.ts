// Third-party script hosts on a page, shared by security/cookie-flags and
// security/token-storage (#2089).
//
// A cookie without HttpOnly and a token in web storage can be read by every
// script that runs on the page. The more third-party code runs there, the more
// parties can read them, so both rules rate the finding higher and name the
// hosts when the page loads scripts from another registrable domain.
//
// Passive: only the page's own `<script src>` markup is read. A script that
// another script injects at runtime is not in the markup and is not counted.

import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";
import { getDomain } from "tldts";

import type { ParsedPage } from "../types";

/** How many hosts a message names before it says "and N more". */
export const MAX_NAMED_SCRIPT_HOSTS = 5;

/** The `type` of a script the browser runs as code; JSON data blocks and templates are not. */
export const EXECUTABLE_SCRIPT_TYPE =
  /^(?:text|application)\/(?:javascript|ecmascript)$|^module$/;

const registrable = (url: string): string | null => {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    if (!host) return null;
    return getDomain(host, { allowPrivateDomains: true }) ?? host;
  } catch {
    return null;
  }
};

/**
 * Is this script served from a different registrable domain than the page? A
 * first-party CDN subdomain (`cdn.example.com` on `www.example.com`) is not.
 */
export function isThirdPartyScript(
  scriptUrl: string,
  pageUrl: string
): boolean {
  const script = registrable(scriptUrl);
  const page = registrable(pageUrl);
  return script !== null && page !== null && script !== page;
}

/**
 * The hostnames, sorted and deduplicated, of the executable `<script src>`
 * elements on the page that are served from another registrable domain. Scripts
 * inside `<noscript>` do not run and are skipped. Empty when there is no parsed
 * document (an unread page) or no third-party script.
 */
export function thirdPartyScriptHosts(
  document: ParsedPage["document"] | null | undefined,
  pageUrl: string
): string[] {
  if (!document) return [];
  const hosts = new Set<string>();
  for (const el of querySelectorAllOutsideNoscript(document, "script[src]")) {
    const type = (el.getAttribute("type") ?? "").trim().toLowerCase();
    if (type && !EXECUTABLE_SCRIPT_TYPE.test(type)) continue;
    const src = (el.getAttribute("src") ?? "").trim();
    if (!src) continue;
    let url: URL;
    try {
      url = new URL(src, pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (!isThirdPartyScript(url.href, pageUrl)) continue;
    hosts.add(url.hostname.toLowerCase().replace(/\.$/, ""));
  }
  return [...hosts].sort();
}

/** `a.com, b.com and 3 more`: the first {@link MAX_NAMED_SCRIPT_HOSTS} hosts and a count of the rest. */
export function formatScriptHosts(hosts: readonly string[]): string {
  const named = hosts.slice(0, MAX_NAMED_SCRIPT_HOSTS);
  const rest = hosts.length - named.length;
  return rest > 0 ? `${named.join(", ")} and ${rest} more` : named.join(", ");
}

/** The report fields for the hosts: the named ones, and the total. */
export function scriptHostDetails(hosts: readonly string[]): {
  thirdPartyScriptHosts: string[];
  thirdPartyScriptHostCount: number;
} {
  return {
    thirdPartyScriptHosts: hosts.slice(0, MAX_NAMED_SCRIPT_HOSTS),
    thirdPartyScriptHostCount: hosts.length,
  };
}
