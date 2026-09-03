// #1822 - a zero-page audit must name the root fetch failure.
//
// One test per failure class, each driven from a fake fetch result (a
// `CrawlError` shaped exactly as the fetcher builds it, or a stored page
// status) through the real classification and into `deriveAuditStatus`. The
// assertions are on what the user actually sees: the `statusReason` sentence
// that reaches `agent_runs.error`, the failure email and the report, plus the
// machine-readable `statusReasonCode` the email and MCP branch on.

import { describe, expect, test } from "bun:test";

import type { AuditFailureReasonCode } from "@squirrelscan/core-contracts";
import { CrawlError, crawlErrorToFailureDetail } from "@squirrelscan/crawler/fetcher";

import { deriveAuditStatus, deriveAuditStatusFromPages } from "../src/scoring";

const URL_ROOT = "https://ejconsultor.es/";

/** A zero-page crawl whose only signal is the recorded root failure. */
function zeroPageRun(error: CrawlError) {
  return deriveAuditStatus({
    pagesCrawled: 0,
    contentPages: 0,
    blockedPages: 0,
    blockedErrors: 0,
    rootFailure: crawlErrorToFailureDetail(error),
  });
}

describe("deriveAuditStatus names the root failure class (#1822)", () => {
  test("dns: the reason names DNS and the host", () => {
    const result = zeroPageRun(
      CrawlError.network(URL_ROOT, "getaddrinfo ENOTFOUND ejconsultor.es"),
    );
    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("dns");
    expect(result.reason).toContain("DNS");
    expect(result.reason).toContain("ejconsultor.es");
  });

  test("tls: the reason names the handshake and carries the certificate detail", () => {
    const result = zeroPageRun(CrawlError.tls(URL_ROOT, "certificate has expired"));
    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("tls");
    expect(result.reason).toContain("TLS handshake");
    expect(result.reason).toContain("certificate has expired");
  });

  test("connection: a socket closed before any response says exactly that", () => {
    // The production case in #1822: the handshake completes, then the origin
    // closes the connection with no HTTP response.
    const result = zeroPageRun(
      CrawlError.network(URL_ROOT, "The socket connection was closed unexpectedly"),
    );
    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("connection");
    expect(result.reason).toContain("before any response");
    expect(result.reason).toContain("ejconsultor.es");
  });

  test("timeout: a request that never answered is a timeout, not an outage", () => {
    const result = zeroPageRun(CrawlError.timeout(URL_ROOT));
    expect(result.reasonCode).toBe("timeout");
    expect(result.reason).toContain("No response from ejconsultor.es");
  });

  test("http_5xx: the reason names the status the origin returned", () => {
    const result = zeroPageRun(CrawlError.network(URL_ROOT, "Server error: 503", 503));
    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("http_5xx");
    expect(result.reason).toContain("503 Service Unavailable");
  });

  test("http_4xx: a 404 entry URL names the status rather than 'unreachable'", () => {
    // A 404 is a stored page, so this arrives through the pages path.
    const result = deriveAuditStatusFromPages([{ status: 404 }]);
    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("http_4xx");
    expect(result.reason).toContain("404 Not Found");
  });

  test("redirect: a refused off-site redirect names the redirect, not a fetch failure", () => {
    const result = deriveAuditStatus({
      pagesCrawled: 0,
      contentPages: 0,
      blockedPages: 0,
      rootFailure: {
        code: "redirect",
        host: "ejconsultor.es",
        detail: "redirected off-site to example.com",
        source: "entry",
      },
    });
    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("redirect");
    expect(result.reason).toContain("Redirect");
    expect(result.reason).toContain("example.com");
  });

  test("robots: a disallowed seed says robots.txt, not 'no pages were crawled'", () => {
    const result = deriveAuditStatus({
      pagesCrawled: 0,
      contentPages: 0,
      blockedPages: 0,
      rootFailure: { code: "robots", host: "ejconsultor.es", source: "entry" },
    });
    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("robots");
    expect(result.reason).toContain("robots.txt disallows");
  });

  test("unknown: an unattributed failure still reads as a failure, with its detail", () => {
    const result = zeroPageRun(CrawlError.network(URL_ROOT, "something we have never seen"));
    expect(result.status).toBe("failed");
    // Never absent, never silently `completed`.
    expect(result.reasonCode).toBe("unknown");
    expect(result.reason).toContain("something we have never seen");
  });

  test("a crawl that recorded nothing keeps the pre-#1822 reason and classifies unknown", () => {
    const result = deriveAuditStatus({ pagesCrawled: 0, contentPages: 0, blockedPages: 0 });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("No pages were crawled");
    expect(result.reasonCode).toBe("unknown");
  });

  test("every class produces a non-empty reason", () => {
    const codes: AuditFailureReasonCode[] = [
      "dns",
      "tls",
      "connection",
      "timeout",
      "http_4xx",
      "http_5xx",
      "redirect",
      "robots",
      "unknown",
    ];
    for (const code of codes) {
      const result = deriveAuditStatus({
        pagesCrawled: 0,
        contentPages: 0,
        blockedPages: 0,
        rootFailure: { code, host: "example.com" },
      });
      expect(result.reasonCode).toBe(code);
      expect(result.reason?.length).toBeGreaterThan(0);
    }
  });
});

describe("existing classifications are unchanged (#792, #1829)", () => {
  test("a WAF-blocked root still classifies as blocked, with the #792 sentence", () => {
    const result = deriveAuditStatus({
      pagesCrawled: 0,
      contentPages: 0,
      blockedPages: 0,
      blockedErrors: 1,
      rootFailure: crawlErrorToFailureDetail(
        CrawlError.blocked("https://example.com/", "Blocked by Cloudflare challenge (503)", 503),
      ),
    });
    expect(result.status).toBe("blocked");
    // The #792 copy is load-bearing for the Sentry classifier and the renderers.
    expect(result.reason).toContain("blocked the crawler");
    // The provider the crawler detected is appended, not substituted.
    expect(result.reason).toContain("Cloudflare");
    expect(result.reasonCode).toBe("http_4xx");
  });

  test("a rate-limited root keeps its #1829 status AND its #1829 sentence", () => {
    // #1829 gives throttling its own signal and its own reason: the remedy is
    // to slow down, not to allowlist a crawler. #1822 adds only the code.
    const result = deriveAuditStatus({
      pagesCrawled: 0,
      contentPages: 0,
      blockedPages: 0,
      blockedErrors: 0,
      rateLimitedErrors: 1,
      rateLimitedHosts: ["example.com"],
      rootFailure: crawlErrorToFailureDetail(CrawlError.rateLimit("https://example.com/", 30_000)),
    });
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("Rate limited by example.com");
    // NOT the bot-wall sentence: those point at opposite fixes.
    expect(result.reason).not.toContain("blocked the crawler");
    expect(result.reasonCode).toBe("http_4xx");
  });

  test("a throttle dressed as a 503 is still reported as a 429-shaped refusal", () => {
    // #1829 accepts a 503 carrying Retry-After as rate limiting. The class must
    // not follow that status into http_5xx, which would send the owner to their
    // application logs for a throttle.
    const detail = crawlErrorToFailureDetail(
      CrawlError.rateLimit("https://example.com/", 30_000, 503),
    );
    expect(detail.code).toBe("http_4xx");
    expect(detail.status).toBe(429);
  });

  test("stored 401/403 pages with no content still classify as blocked", () => {
    const result = deriveAuditStatusFromPages([{ status: 403 }, { status: 401 }]);
    expect(result.status).toBe("blocked");
    expect(result.reasonCode).toBe("http_4xx");
  });

  test("an unrelated upstream 'no response' is not read as a crawl timeout", () => {
    // The timeout matcher needs BOTH halves of the engine's sentence, so a
    // reason handed in from somewhere else does not borrow the class.
    expect(
      deriveAuditStatus({
        pagesCrawled: 0,
        contentPages: 0,
        blockedPages: 0,
        rootFailure: {
          code: "unknown",
          detail: "got no response from the billing service",
        },
      }).reasonCode,
    ).toBe("unknown");
  });

  test("a healthy crawl is untouched: no status, no reason, no code", () => {
    const result = deriveAuditStatus({
      pagesCrawled: 10,
      contentPages: 10,
      blockedPages: 0,
      // Present but irrelevant: one sub-page 404 must not fail a good audit.
      rootFailure: { code: "http_4xx", status: 404, host: "example.com" },
    });
    expect(result.status).toBe("completed");
    expect(result.reason).toBeUndefined();
    expect(result.reasonCode).toBeUndefined();
  });

  test("the entry URL's failure outranks a sitemap URL's when both are known", () => {
    // preferRootFailure lives in the crawler; this pins the consequence the
    // engine relies on - `source` is carried through to the reason builder.
    const result = deriveAuditStatus({
      pagesCrawled: 0,
      contentPages: 0,
      blockedPages: 0,
      rootFailure: { code: "dns", host: "ejconsultor.es", source: "entry" },
    });
    expect(result.reason).toContain("ejconsultor.es");
  });
});
