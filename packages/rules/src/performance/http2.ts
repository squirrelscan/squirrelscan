// performance/http2 - HTTP/2 protocol check

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const http2Rule: Rule = {
  meta: {
    id: "perf/http2",
    name: "HTTP/2",
    description: "Checks for HTTP/2 protocol support",
    solution:
      "HTTP/2 enables multiplexing, header compression, and server push for faster page loads. Most modern web servers and CDNs support HTTP/2 out of the box. Requires HTTPS. Check your server/CDN documentation to enable it. HTTP/3 (QUIC) provides even better performance.",
    category: "perf",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const headers = ctx.page.headers;

    // Check for HTTP/2 indicators
    // Note: HTTP version is typically not in response headers but we can infer from
    // features like :status pseudo-header or server support indicators

    // Check for alt-svc header (HTTP/3 advertisement)
    const altSvc = headers["alt-svc"];
    if (altSvc) {
      if (altSvc.includes("h3")) {
        checks.push({
          name: "http-version",
          status: "pass",
          message: "HTTP/3 (QUIC) support advertised",
          value: altSvc,
        });
      } else if (altSvc.includes("h2")) {
        checks.push({
          name: "http-version",
          status: "pass",
          message: "HTTP/2 support advertised via Alt-Svc",
          value: altSvc,
        });
        // h2-only Alt-Svc: nudge toward HTTP/3 (QUIC) for faster setup (squirrelscan/squirrelscan#20).
        checks.push({
          name: "http3-hint",
          status: "info",
          message: "Consider enabling HTTP/3 (QUIC) — only HTTP/2 is advertised",
          value: altSvc,
          expected: "Alt-Svc advertising h3",
        });
      }
    }

    // Check if page is HTTPS (required for HTTP/2)
    try {
      const url = new URL(ctx.page.url);
      if (url.protocol !== "https:") {
        checks.push({
          name: "http2-https-required",
          status: "warn",
          message: "HTTP/2 requires HTTPS",
          expected: "Enable HTTPS to use HTTP/2",
        });
        return { checks };
      }
    } catch {
      // Invalid URL, skip check
    }

    // Check for common HTTP/2 server headers
    const server = headers["server"]?.toLowerCase() || "";
    const via = headers["via"]?.toLowerCase() || "";

    // Cloudflare, Fastly, AWS CloudFront all use HTTP/2 by default
    const knownH2Providers = [
      "cloudflare",
      "cloudfront",
      "fastly",
      "akamai",
      "google",
      "nginx",
      "h2o",
    ];

    const likelyH2 = knownH2Providers.some(
      (p) => server.includes(p) || via.includes(p)
    );

    if (likelyH2 && checks.length === 0) {
      checks.push({
        name: "http2-likely",
        status: "info",
        message: "Server likely supports HTTP/2",
        value: server || via,
        details: {
          note: "HTTP/2 detection requires observing the connection protocol",
        },
      });
    }

    // If we couldn't determine HTTP version
    if (checks.length === 0) {
      checks.push({
        name: "http2-unknown",
        status: "info",
        message: "HTTP/2 support cannot be determined from headers",
        details: {
          note: "HTTP/2 is recommended for all HTTPS sites",
        },
      });
    }

    return { checks };
  },
};
