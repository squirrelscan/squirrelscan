// security/third-party-cookies - Detect third-party cookie usage

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { getHostname } from "@squirrelscan/utils";

// Known third-party tracking domains
const trackingDomains = new Set([
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "google-analytics.com",
  "googletagmanager.com",
  "facebook.com",
  "facebook.net",
  "connect.facebook.net",
  "fbcdn.net",
  "twitter.com",
  "ads-twitter.com",
  "linkedin.com",
  "ads.linkedin.com",
  "adsymptotic.com",
  "adnxs.com",
  "criteo.com",
  "criteo.net",
  "outbrain.com",
  "taboola.com",
  "amazon-adsystem.com",
  "scorecardresearch.com",
  "quantserve.com",
  "hotjar.com",
  "mouseflow.com",
  "fullstory.com",
  "clarity.ms",
  "intercom.io",
  "drift.com",
  "hubspot.com",
  "hs-analytics.net",
  "hs-scripts.com",
  "marketo.com",
  "mktoresp.com",
  "pardot.com",
  "segment.com",
  "segment.io",
  "mixpanel.com",
  "amplitude.com",
  "heap.io",
  "heapanalytics.com",
  "newrelic.com",
  "nr-data.net",
  "sentry.io",
  "bugsnag.com",
]);

function isTrackingDomain(hostname: string): boolean {
  const parts = hostname.split(".");
  // Check domain and parent domains
  for (let i = 0; i < parts.length - 1; i++) {
    const domain = parts.slice(i).join(".");
    if (trackingDomains.has(domain)) {
      return true;
    }
  }
  return false;
}

export const thirdPartyCookiesRule: Rule = {
  meta: {
    id: "security/third-party-cookies",
    name: "Third-Party Cookies",
    description: "Detects third-party resources that may set cookies",
    solution:
      "Third-party cookies are being phased out by browsers. Review resources from external domains that may set cookies for tracking. Consider using first-party analytics solutions, server-side tracking, or privacy-focused alternatives. Ensure compliance with GDPR/CCPA by providing cookie consent and disclosing third-party services in your privacy policy.",
    category: "security",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const checks: CheckResult[] = [];
    const pageHostname = getHostname(ctx.page.url).toLowerCase();
    const thirdPartyDomains = new Map<
      string,
      { type: string; tracking: boolean }
    >();

    // Check scripts
    const scripts = doc.querySelectorAll("script[src]");
    for (const script of scripts) {
      const src = script.getAttribute("src") || "";
      const hostname = getHostname(src).toLowerCase();
      if (
        hostname &&
        !hostname.includes(pageHostname) &&
        !pageHostname.includes(hostname)
      ) {
        const existing = thirdPartyDomains.get(hostname);
        if (!existing) {
          thirdPartyDomains.set(hostname, {
            type: "script",
            tracking: isTrackingDomain(hostname),
          });
        }
      }
    }

    // Check iframes
    const iframes = doc.querySelectorAll("iframe[src]");
    for (const iframe of iframes) {
      const src = iframe.getAttribute("src") || "";
      const hostname = getHostname(src).toLowerCase();
      if (
        hostname &&
        !hostname.includes(pageHostname) &&
        !pageHostname.includes(hostname)
      ) {
        const existing = thirdPartyDomains.get(hostname);
        if (!existing) {
          thirdPartyDomains.set(hostname, {
            type: "iframe",
            tracking: isTrackingDomain(hostname),
          });
        } else if (existing.type !== "iframe") {
          existing.type = "script+iframe";
        }
      }
    }

    // Check images (tracking pixels)
    const images = doc.querySelectorAll("img[src]");
    for (const img of images) {
      const src = img.getAttribute("src") || "";
      const hostname = getHostname(src).toLowerCase();
      const width = img.getAttribute("width");
      const height = img.getAttribute("height");
      // Check for tracking pixels (1x1 images)
      const isPixel =
        (width === "1" || width === "0") && (height === "1" || height === "0");

      if (
        hostname &&
        !hostname.includes(pageHostname) &&
        !pageHostname.includes(hostname)
      ) {
        if (isPixel || isTrackingDomain(hostname)) {
          const existing = thirdPartyDomains.get(hostname);
          if (!existing) {
            thirdPartyDomains.set(hostname, {
              type: isPixel ? "pixel" : "image",
              tracking: isTrackingDomain(hostname) || isPixel,
            });
          }
        }
      }
    }

    // Report findings
    const trackingDomainsList = Array.from(thirdPartyDomains.entries())
      .filter(([, info]) => info.tracking)
      .map(([domain, info]) => `${domain} (${info.type})`);

    const otherThirdParty = Array.from(thirdPartyDomains.entries())
      .filter(([, info]) => !info.tracking)
      .map(([domain, info]) => `${domain} (${info.type})`);

    if (trackingDomainsList.length > 0) {
      checks.push({
        name: "tracking-domains",
        status: "warn",
        message: `${trackingDomainsList.length} known tracking domain(s) detected`,
        items: trackingDomainsList.slice(0, 10).map((id) => ({ id })),
        details:
          trackingDomainsList.length > 10
            ? { additional: trackingDomainsList.length - 10 }
            : undefined,
      });
    }

    if (otherThirdParty.length > 0) {
      checks.push({
        name: "third-party-resources",
        status: "info",
        message: `${otherThirdParty.length} other third-party domain(s) found`,
        items: otherThirdParty.slice(0, 5).map((id) => ({ id })),
        details:
          otherThirdParty.length > 5
            ? { additional: otherThirdParty.length - 5 }
            : undefined,
      });
    }

    if (trackingDomainsList.length === 0 && otherThirdParty.length === 0) {
      checks.push({
        name: "third-party-cookies",
        status: "pass",
        message: "No third-party tracking resources detected",
      });
    }

    return { checks };
  },
};
