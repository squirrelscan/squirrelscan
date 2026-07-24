// ax/llms-txt — llms.txt discovery + format validation (#393).

import { describe, expect, test } from "bun:test";

import type { CheckResult, LlmsTxtData, WellKnownProbe, WellKnownProbeData } from "@squirrelscan/core-contracts";

import { llmsTxtRule, validateLlmsFormat } from "../src/ax/llms-txt";
import type { ParsedPage, RuleContext } from "../src/types";

function wkProbe(over: Partial<WellKnownProbe> = {}): WellKnownProbe {
  return {
    path: "/.well-known/llms.txt",
    url: "https://example.com/.well-known/llms.txt",
    status: 0,
    contentType: null,
    bodySize: 0,
    looksHtml: false,
    jsonValid: false,
    jsonKeys: [],
    markdownLike: false,
    excerpt: "",
    oauthRegistrationEndpoint: null,
    oauthClientIdMetadataDocumentSupported: null,
    error: null,
    ...over,
  };
}

function file(over: Partial<LlmsTxtData["llmsTxt"]> = {}): LlmsTxtData["llmsTxt"] {
  return {
    url: "https://example.com/llms.txt",
    exists: false,
    content: null,
    sizeBytes: 0,
    ...over,
  };
}

function llms(over: Partial<LlmsTxtData> = {}): LlmsTxtData {
  return {
    llmsTxt: file(),
    llmsFullTxt: file({ url: "https://example.com/llms-full.txt" }),
    ...over,
  };
}

function ctx(
  llmsTxt: LlmsTxtData | null | undefined,
  wellKnown?: WellKnownProbeData | null,
): RuleContext {
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: "https://example.com",
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      llmsTxt,
      wellKnown,
    },
    options: {},
  };
}

function run(llmsTxt: LlmsTxtData | null | undefined, wellKnown?: WellKnownProbeData | null): CheckResult[] {
  return llmsTxtRule.run(ctx(llmsTxt, wellKnown)).checks;
}

const VALID =
  "# Example\n\n> A demo site.\n\n## Docs\n\n- [Guide](https://example.com/guide): guide\n- [API](/api): api\n";

describe("ax/llms-txt", () => {
  test("data unavailable → info, no crash", () => {
    const checks = run(undefined);
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.message).toContain("not available");
  });

  test("absent /llms.txt → single 'absent' warn-status recommendation", () => {
    const checks = run(llms());
    expect(checks).toHaveLength(1);
    expect(checks[0]?.value).toBe("absent");
    // warn-status in this info-severity rule = shown as a Recommendation in
    // the report but score-neutral (advisory scoring).
    expect(checks[0]?.status).toBe("warn");
  });

  test("present + valid → present + valid format with link count", () => {
    const checks = run(
      llms({ llmsTxt: file({ exists: true, content: VALID, sizeBytes: VALID.length }) }),
    );
    expect(checks.find((c) => c.name === "llms-txt-present")?.value).toBe("present");
    const format = checks.find((c) => c.name === "llms-txt-format");
    expect(format?.value).toBe("valid");
    expect(format?.message).toContain("2 links");
  });

  test("notes /llms-full.txt when also present", () => {
    const checks = run(
      llms({
        llmsTxt: file({ exists: true, content: VALID, sizeBytes: 1 }),
        llmsFullTxt: file({
          url: "https://example.com/llms-full.txt",
          exists: true,
          content: "# x",
          sizeBytes: 3,
        }),
      }),
    );
    expect(checks.find((c) => c.name === "llms-txt-present")?.message).toContain(
      "/llms-full.txt also present",
    );
  });

  test("SPA-fallback HTML body at /llms.txt → fail, not present", () => {
    const checks = run(
      llms({ llmsTxt: file({ exists: true, content: "<!DOCTYPE html><html>...</html>", sizeBytes: 32 }) }),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("fail");
    expect(checks[0]?.value).toBe("spa-fallback");
    expect(checks[0]?.message).toContain("SPA fallback");
  });

  test("SPA-fallback detection ignores leading whitespace and <html> without doctype", () => {
    const checks = run(llms({ llmsTxt: file({ exists: true, content: "\n  <html><body/></html>" }) }));
    expect(checks[0]?.status).toBe("fail");
  });

  test("root absent but /.well-known/llms.txt hits a real file → present via alt path", () => {
    const checks = run(
      llms(),
      {
        probes: [
          wkProbe({ path: "/.well-known/llms.txt", status: 200, bodySize: 40, markdownLike: true }),
        ],
      },
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.value).toBe("present");
    expect(checks[0]?.message).toContain("/.well-known/llms.txt");
  });

  test("root absent, alt path 200 with plain-text junk (not markdown) → absent", () => {
    const checks = run(
      llms(),
      { probes: [wkProbe({ path: "/docs/llms.txt", status: 200, bodySize: 9, markdownLike: false })] },
    );
    expect(checks[0]?.value).toBe("absent");
  });

  test("root absent, alt path also SPA-fallback HTML → still reported absent", () => {
    const checks = run(
      llms(),
      { probes: [wkProbe({ path: "/docs/llms.txt", status: 200, looksHtml: true })] },
    );
    expect(checks[0]?.value).toBe("absent");
  });

  test("root absent + no wellKnown data at all → absent, no crash", () => {
    const checks = run(llms());
    expect(checks[0]?.value).toBe("absent");
  });

  test("malformed (no H1, no links) surfaces as warn-status recommendation", () => {
    const checks = run(
      llms({ llmsTxt: file({ exists: true, content: "just text, no heading", sizeBytes: 10 }) }),
    );
    const format = checks.find((c) => c.name === "llms-txt-format");
    expect(format?.status).toBe("warn");
    expect(format?.value).toBe("has-notes");
    expect(format?.message).toContain("missing H1");
    expect(format?.message).toContain("no Markdown links");
    expect(checks.every((c) => c.status !== "fail")).toBe(true);
  });
});

describe("validateLlmsFormat", () => {
  test("valid: H1 + parseable absolute & root-relative links", () => {
    const f = validateLlmsFormat(VALID, "https://example.com");
    expect(f.hasH1).toBe(true);
    expect(f.linkCount).toBe(2);
    expect(f.invalidLinks).toHaveLength(0);
  });

  test("flags a malformed link URL", () => {
    const f = validateLlmsFormat("# T\n\n- [bad](http://[invalid)\n", "https://example.com");
    expect(f.invalidLinks.length).toBeGreaterThan(0);
  });
});
