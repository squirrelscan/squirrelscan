// Redirect chain detection and analysis
// Follows redirects and identifies chains, loops, and issues

import type { CheckResult, RedirectChain, RedirectHop } from "@squirrelscan/core-contracts";

import { HTTP_PROBE_LIMITS } from "@squirrelscan/utils/constants";
import { isRateLimitedResponse } from "@squirrelscan/utils/rate-limit";
import { isHttpOrHttpsUrl } from "@squirrelscan/utils/safe-fetch";
import { requestAsync } from "../tools";

export async function followRedirects(url: string): Promise<RedirectChain> {
  const hops: RedirectHop[] = [];
  let currentUrl = url;
  const visitedUrls = new Set<string>();
  let isLoop = false;
  let endsInError = false;
  let endsRateLimited = false;

  for (let i = 0; i < HTTP_PROBE_LIMITS.MAX_REDIRECT_HOPS; i++) {
    // Check for loop
    if (visitedUrls.has(currentUrl)) {
      isLoop = true;
      break;
    }
    visitedUrls.add(currentUrl);

    // #1252: hard per-hop timeout. This probe re-hits the target host DURING the
    // rules phase, so an unbounded hop against a tarpitting origin stretches the
    // whole phase. Abort the underlying request (not a bare race) so the socket
    // is actually released — a race that only rejects leaves the read pending.
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      HTTP_PROBE_LIMITS.FOLLOW_TIMEOUT_MS,
    );

    try {
      const response = await requestAsync(currentUrl, {
        method: "HEAD",
        redirect: "manual", // Don't auto-follow
        headers: {
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Upgrade-Insecure-Requests": "1",
        },
        signal: controller.signal,
      });

      const statusCode = response.status;

      // Check for redirect
      if (statusCode >= 300 && statusCode < 400) {
        const location = response.headers.get("location");
        if (!location) {
          // Redirect without location header - error
          hops.push({
            url: currentUrl,
            statusCode,
            type: "http",
          });
          endsInError = true;
          break;
        }

        // Resolve relative URLs
        const nextUrl = new URL(location, currentUrl).toString();

        hops.push({
          url: currentUrl,
          statusCode,
          type: "http",
        });

        // Following redirects by hand bypasses the runtime's own cross-protocol
        // rejection, so the scheme allowlist has to be applied here. This loop
        // cannot delegate to safeRedirectFetch: that helper returns only the final
        // response, and this probe exists to report the per-hop status codes.
        // Record the hop we observed, then refuse to fetch the target.
        if (!isHttpOrHttpsUrl(nextUrl)) {
          endsInError = true;
          break;
        }

        currentUrl = nextUrl;
        continue;
      }

      // Not a redirect - we've reached the final destination
      hops.push({
        url: currentUrl,
        statusCode,
        type: "http",
      });

      // #1829: a throttled endpoint is unverified, not broken. Checked before
      // the >= 400 test, which 429/430 would otherwise satisfy and turn into a
      // hard "redirect chain ends in error" failure.
      if (isRateLimitedResponse(statusCode, response.headers.get("retry-after"))) {
        endsRateLimited = true;
        break;
      }

      // Check if final destination is an error
      if (statusCode >= 400) {
        endsInError = true;
      }

      break;
    } catch {
      // Request failed (incl. the per-hop timeout abort above).
      hops.push({
        url: currentUrl,
        statusCode: 0,
        type: "http",
      });
      endsInError = true;
      break;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Determine if there was a chain (more than 1 hop)
  const chainLength = hops.length - 1; // Don't count final destination

  // Check for HTTPS to HTTP redirect
  let httpsToHttp = false;
  let httpToHttps = false;

  for (let i = 0; i < hops.length - 1; i++) {
    const from = hops[i].url;
    const to = hops[i + 1].url;

    if (from.startsWith("https://") && to.startsWith("http://")) {
      httpsToHttp = true;
    }
    if (from.startsWith("http://") && to.startsWith("https://")) {
      httpToHttps = true;
    }
  }

  return {
    sourceUrl: url,
    finalUrl: hops.length > 0 ? hops[hops.length - 1].url : url,
    hops,
    chainLength,
    isLoop,
    endsInError,
    endsRateLimited,
    httpsToHttp,
    httpToHttps,
  };
}

export function validateRedirectChain(chain: RedirectChain): CheckResult[] {
  const checks: CheckResult[] = [];

  // No redirect
  if (chain.chainLength === 0) {
    return checks;
  }

  // Check for redirect loop
  if (chain.isLoop) {
    checks.push({
      name: "redirect-loop",
      status: "fail",
      message: "Redirect loop detected",
      value: chain.sourceUrl,
    });
    return checks;
  }

  // Check chain length
  if (chain.chainLength > 5) {
    checks.push({
      name: "redirect-chain",
      status: "fail",
      message: `Redirect chain too long (${chain.chainLength} hops)`,
      value: chain.chainLength,
      expected: 2,
    });
  } else if (chain.chainLength > 2) {
    checks.push({
      name: "redirect-chain",
      status: "warn",
      message: `Redirect chain has ${chain.chainLength} hops`,
      value: chain.chainLength,
      expected: 2,
    });
  }

  // Check if ends in error
  if (chain.endsInError) {
    const finalStatus = chain.hops[chain.hops.length - 1]?.statusCode || 0;
    checks.push({
      name: "redirect-to-error",
      status: "fail",
      message: `Redirect chain ends in error (${finalStatus})`,
      value: chain.finalUrl,
    });
  } else if (chain.endsRateLimited) {
    // #1829: info, not fail. The destination throttled us, so we never learned
    // whether the chain resolves — reporting that as a broken redirect sent
    // operators chasing a redirect that works fine for real visitors.
    const finalStatus = chain.hops[chain.hops.length - 1]?.statusCode || 0;
    checks.push({
      name: "redirect-rate-limited",
      status: "info",
      message: `Redirect chain ends in a rate-limited response (${finalStatus}); destination status unverifiable`,
      value: chain.finalUrl,
    });
  }

  // Check for HTTPS to HTTP downgrade
  if (chain.httpsToHttp) {
    checks.push({
      name: "redirect-https-to-http",
      status: "fail",
      message: "Redirect from HTTPS to HTTP (security downgrade)",
      value: chain.sourceUrl,
    });
  }

  // HTTP to HTTPS is good but note it for 301 vs 302
  if (chain.httpToHttps) {
    const redirectType = chain.hops[0]?.statusCode;
    if (redirectType === 302 || redirectType === 307) {
      checks.push({
        name: "redirect-http-to-https",
        status: "warn",
        message: `HTTP to HTTPS redirect uses ${redirectType} (prefer 301)`,
        value: redirectType,
        expected: 301,
      });
    }
  }

  // Check for temporary redirects in chain
  for (const hop of chain.hops.slice(0, -1)) {
    if (hop.statusCode === 302 || hop.statusCode === 307) {
      checks.push({
        name: "redirect-temporary",
        status: "warn",
        message: `Temporary redirect (${hop.statusCode}) used at ${hop.url}`,
        value: hop.statusCode,
      });
    }
  }

  return checks;
}

export function getRedirectChainSummary(chain: RedirectChain): string {
  if (chain.chainLength === 0) {
    return "No redirect";
  }

  const parts = chain.hops.map((hop, i) => {
    if (i === chain.hops.length - 1) {
      return `${hop.url} (${hop.statusCode})`;
    }
    return `${hop.url} [${hop.statusCode}]`;
  });

  return parts.join(" -> ");
}

export function classifyRedirectType(statusCode: number): string {
  switch (statusCode) {
    case 301:
      return "Permanent (301)";
    case 302:
      return "Found (302)";
    case 303:
      return "See Other (303)";
    case 307:
      return "Temporary (307)";
    case 308:
      return "Permanent (308)";
    default:
      return `Unknown (${statusCode})`;
  }
}
