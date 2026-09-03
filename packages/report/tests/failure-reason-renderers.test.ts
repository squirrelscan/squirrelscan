// #1822 - every renderer for a FAILED report must print the specific reason and
// a next step that differs by failure class. Before this each surface printed
// one generic "No pages could be fetched" paragraph, so a dead DNS record, an
// expired certificate and a 503 all read identically.

import { describe, expect, test } from "bun:test";

import type { AuditFailureReasonCode } from "@squirrelscan/core-contracts";

import type { AuditReport } from "../src/types";
import { getAuditFailureNotice, reportFailureReasonCode } from "../src/failure-notice";
import { renderText } from "../src/output/text";
import { renderMarkdown } from "../src/output/markdown";
import { renderLlm } from "../src/output/llm";
import { renderJson } from "../src/output/json";

function failedReport(
  statusReason: string,
  statusReasonCode?: AuditFailureReasonCode,
): AuditReport {
  return {
    baseUrl: "https://ejconsultor.es",
    timestamp: "2026-09-03T14:30:00.000Z",
    totalPages: 0,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    status: "failed",
    statusReason,
    ...(statusReasonCode ? { statusReasonCode } : {}),
  };
}

const DNS = failedReport("DNS lookup failed for ejconsultor.es (NXDOMAIN)", "dns");
const TLS = failedReport("TLS handshake with ejconsultor.es failed: certificate has expired", "tls");
const SERVER = failedReport("ejconsultor.es returned 503 Service Unavailable", "http_5xx");

describe("text output (#1822)", () => {
  test("prints the specific reason, not the generic paragraph", () => {
    const out = renderText(DNS);
    expect(out).toContain("AUDIT FAILED");
    expect(out).toContain("DNS lookup failed for ejconsultor.es");
    expect(out).not.toContain("No pages could be fetched from this site");
  });

  test("the next step differs between DNS, TLS and a server error", () => {
    expect(renderText(DNS)).toContain("DNS records");
    expect(renderText(TLS)).toContain("TLS certificate");
    expect(renderText(SERVER)).toContain("error logs");
  });

  test("an unclassified failure keeps the pre-#1822 paragraph", () => {
    const out = renderText(failedReport("No pages were crawled"));
    expect(out).toContain("No pages could be fetched from this site");
  });
});

describe("markdown output (#1822)", () => {
  test("prints the reason and a class-specific next step", () => {
    const out = renderMarkdown(TLS);
    expect(out).toContain("## Audit failed");
    expect(out).toContain("TLS handshake with ejconsultor.es failed");
    expect(out).toContain("TLS certificate");
  });

  test("a DNS failure and a server error do not read the same", () => {
    expect(renderMarkdown(DNS)).not.toBe(renderMarkdown(SERVER));
    expect(renderMarkdown(DNS)).toContain("DNS records");
    expect(renderMarkdown(SERVER)).toContain("error logs");
  });
});

describe("llm output (#1822)", () => {
  test("the status block carries the reason attribute and third-person guidance", () => {
    const out = renderLlm(DNS);
    expect(out).toContain('<status state="failed"');
    expect(out).toContain("DNS lookup failed for ejconsultor.es");
    expect(out).toContain("hostname did not resolve");
    expect(out).toContain("squirrel audit https://ejconsultor.es");
    // Agent-facing copy carries no em-dashes.
    expect(out.slice(out.indexOf("<status"), out.indexOf("</status>"))).not.toContain("—");
  });

  test("a certificate failure and a server error give different guidance", () => {
    expect(renderLlm(TLS)).toContain("TLS certificate could not be validated");
    expect(renderLlm(SERVER)).toContain("returned an error of its own");
  });

  test("an unclassified failure keeps the pre-#1822 sentence", () => {
    expect(renderLlm(failedReport("No pages were crawled"))).toContain(
      "No pages could be fetched from the site",
    );
  });
});

describe("json output (#1822)", () => {
  test("serializes the machine-readable code alongside the reason", () => {
    const parsed = JSON.parse(renderJson(DNS));
    expect(parsed.status).toBe("failed");
    expect(parsed.statusReasonCode).toBe("dns");
  });

  test("a report stored before #1822 gets its code derived from the reason text", () => {
    const parsed = JSON.parse(
      renderJson(failedReport("TLS handshake with example.com failed: self-signed certificate")),
    );
    expect(parsed.statusReasonCode).toBe("tls");
  });

  test("a completed report carries no failure code", () => {
    const parsed = JSON.parse(
      renderJson({
        baseUrl: "https://example.com",
        timestamp: "2026-09-03T14:30:00.000Z",
        totalPages: 3,
        passed: 5,
        warnings: 0,
        failed: 0,
        ruleResults: {},
      }),
    );
    expect(parsed.statusReasonCode).toBeUndefined();
  });
});

describe("the shared failure notice (#1822)", () => {
  test("a coded failure gets class-specific cause and next-step copy", () => {
    const notice = getAuditFailureNotice("failed", "ejconsultor.es", undefined, "dns");
    expect(notice?.body[0]).toContain("resolve");
    expect(notice?.body[1]).toContain("DNS records");
  });

  test("no code, or `unknown`, keeps the pre-#1822 copy verbatim (#935)", () => {
    const legacy = getAuditFailureNotice("failed", "example.com");
    expect(legacy?.body[0]).toBe(
      "We couldn't fetch any pages from your site, so there was nothing to audit. The site may have been down, unreachable, or timing out when we tried.",
    );
    expect(legacy?.body[1]).toBe("Check that the site is reachable and try again.");
    expect(getAuditFailureNotice("failed", "example.com", undefined, "unknown")).toEqual(legacy!);
  });

  test("a blocked run is untouched by the code (#792 copy is load-bearing)", () => {
    expect(getAuditFailureNotice("blocked", "example.com", undefined, "http_4xx")).toEqual(
      getAuditFailureNotice("blocked", "example.com")!,
    );
  });

  test("reportFailureReasonCode prefers the stored code and falls back to the text", () => {
    expect(reportFailureReasonCode({ statusReasonCode: "tls", statusReason: "anything" })).toBe(
      "tls",
    );
    expect(reportFailureReasonCode({ statusReason: "Crawl request timed out" })).toBe("timeout");
    // Never undefined: an unreadable reason is still a failure.
    expect(reportFailureReasonCode({})).toBe("unknown");
  });
});

describe("#1822 and #1829 do not fight over the notice (#1822)", () => {
  test("a rate-limited block keeps its own copy, whatever the class says", () => {
    const notice = getAuditFailureNotice(
      "blocked",
      "example.com",
      { pages: 4, hosts: ["example.com"] },
      "http_4xx",
    );
    expect(notice?.heading).toBe("Your site rate limited the audit");
    expect(notice?.body[0]).toContain("throttling, not bot protection");
  });

  test("a failed audit with no throttling still gets the class-specific copy", () => {
    const notice = getAuditFailureNotice("failed", "example.com", undefined, "tls");
    expect(notice?.body[0]).toContain("TLS handshake");
  });
});
