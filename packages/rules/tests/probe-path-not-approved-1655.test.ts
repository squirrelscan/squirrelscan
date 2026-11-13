// #1655: a probe path the allowlist left out reads "not checked (path not approved)", never missing.

import { describe, expect, test } from "bun:test";

import {
  PROBE_PATH_NOT_APPROVED_ERROR,
  PROBE_REDIRECT_NOT_FOLLOWED_ERROR,
  PROBE_STOPPED_ERROR,
} from "@squirrelscan/core-contracts/storage";

import type { WellKnownProbe, WellKnownProbeData } from "@squirrelscan/core-contracts";

import { agentsMdRule } from "../src/ax/agents-md";
import { llmsTxtRule } from "../src/ax/llms-txt";
import type { ParsedPage, RuleContext } from "../src/types";

function probe(path: string, over: Partial<WellKnownProbe> = {}): WellKnownProbe {
  return {
    path,
    url: `https://example.com${path}`,
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

function ctx(wellKnown: WellKnownProbeData): RuleContext {
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null, wellKnown },
    options: {},
  };
}

const notApproved = (path: string) => probe(path, { error: PROBE_PATH_NOT_APPROVED_ERROR });

describe("path not approved (#1655)", () => {
  // #1794 supersedes the first #1655 verdict here: variants the user left out of discovery_probe_paths are theirs
  // to leave out, so an approved path that answered 404 establishes absence, and the left-out variants are listed.
  test("ax/agents-md: /AGENTS.md 404 with the variants not approved is absent, the variants listed as not checked", () => {
    const checks = agentsMdRule.run(
      ctx({
        probes: [
          probe("/AGENTS.md", { status: 404 }),
          notApproved("/agents.md"),
          notApproved("/.well-known/agents.md"),
          notApproved("/docs/AGENTS.md"),
        ],
      }),
    ).checks;
    expect(checks).toHaveLength(1);
    expect(checks[0]?.value).toBe("absent");
    expect(checks[0]?.details?.notChecked).toEqual(["/agents.md", "/.well-known/agents.md", "/docs/AGENTS.md"]);
  });

  test("ax/agents-md: a block-stopped path is not checked for another reason", () => {
    const checks = agentsMdRule.run(
      ctx({
        probes: ["/AGENTS.md", "/agents.md", "/.well-known/agents.md", "/docs/AGENTS.md"].map((p) =>
          probe(p, { error: PROBE_STOPPED_ERROR }),
        ),
      }),
    ).checks;
    expect(checks[0]?.value).toBe("not-checked");
    expect(checks[0]?.message).not.toContain("path not approved");
  });

  test("ax/llms-txt: /llms.txt not approved says so", () => {
    const checks = llmsTxtRule.run(ctx({ probes: [notApproved("/llms.txt")] })).checks;
    expect(checks).toHaveLength(1);
    expect(checks[0]?.value).toBe("not-checked");
    expect(checks[0]?.message).toContain("path not approved");
  });

  test("ax/agents-md: a redirect that was not followed says the request was sent", () => {
    const checks = agentsMdRule.run(
      ctx({
        probes: ["/AGENTS.md", "/agents.md", "/.well-known/agents.md", "/docs/AGENTS.md"].map((p) =>
          probe(p, { error: PROBE_REDIRECT_NOT_FOLLOWED_ERROR }),
        ),
      }),
    ).checks;
    expect(checks[0]?.value).toBe("not-checked");
    expect(checks[0]?.message).toContain("redirect to another path was not followed");
    expect(checks[0]?.message).not.toContain("was not sent");
  });
});
