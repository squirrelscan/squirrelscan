// The audit-engine's own re-fetches of crawled URLs (the cloaking probe and the
// soft-404 confirmation) send the custom headers only to the audited origin, plus
// the hosts the user named (#959). Driven over injected fetch stubs that record
// each URL and the headers it was sent, so every negative also proves the URL was
// requested.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import { createHeaderScope } from "@squirrelscan/utils/headers";

import { runCloakingProbe, type ProbeFetch } from "../src/cloaking-probe";
import { confirmSoft404Candidates, type ConfirmFetch } from "../src/soft404-confirm";

const BASE = "https://example.test";
const HEADERS = { "X-Audit-Token": "secret" };
const SAME = `${BASE}/same`;
const HTTP = "http://example.test/plain";
const PORT = `${BASE}:8443/port`;
const OTHER = "https://other.test/o";

const URLS = [SAME, HTTP, PORT, OTHER];

type Sent = Map<string, Record<string, string> | undefined>;

describe("cloaking probe re-fetches (#959)", () => {
  const run = async (headerHosts: string[] = []) => {
    const sent: Sent = new Map();
    const fetchImpl: ProbeFetch = async (url, _ua, headers) => {
      sent.set(url, headers);
      return { status: 200, body: "<p>same page</p>" };
    };
    await runCloakingProbe(
      URLS.map((url) => ({ url, reason: "orphan" as const })),
      {
        maxPages: 10,
        recentDays: 14,
        queryVariation: false,
        googlebotUserAgent: "Googlebot",
        defaultUserAgent: "Browser",
        customHeaders: HEADERS,
        headerScope: createHeaderScope(BASE, headerHosts),
      },
      fetchImpl,
    );
    return sent;
  };

  test("only the audited origin carries the headers", async () => {
    const sent = await run();
    for (const url of URLS) expect(sent.has(url)).toBe(true);
    expect(sent.get(SAME)).toEqual(HEADERS);
    expect(sent.get(HTTP)).toBeUndefined();
    expect(sent.get(PORT)).toBeUndefined();
    expect(sent.get(OTHER)).toBeUndefined();
  });

  test("a host named in header_hosts carries them too", async () => {
    const sent = await run(["other.test"]);
    expect(sent.get(OTHER)).toEqual(HEADERS);
    expect(sent.get(HTTP)).toBeUndefined();
  });
});

describe("soft-404 confirmation re-fetches (#959)", () => {
  const SHELL = `<!doctype html><html id="__next_error__"><head><meta name="robots" content="noindex"><title>Page Not Found</title></head><body><main><h1>Page Not Found</h1></main></body></html>`;
  const run = async (headerHosts: string[] = []) => {
    const sent: Sent = new Map();
    const fetchImpl: ConfirmFetch = async (url, _ua, headers) => {
      sent.set(url, headers);
      return { status: 200, body: SHELL };
    };
    await confirmSoft404Candidates(
      URLS.map((url) => ({ url, statusCode: 200, parsed: parsePage(SHELL, url) })),
      {
        userAgent: "test-agent",
        customHeaders: HEADERS,
        headerScope: createHeaderScope(BASE, headerHosts),
      },
      fetchImpl,
    );
    return sent;
  };

  test("only the audited origin carries the headers", async () => {
    const sent = await run();
    for (const url of URLS) expect(sent.has(url)).toBe(true);
    expect(sent.get(SAME)).toEqual(HEADERS);
    expect(sent.get(HTTP)).toBeUndefined();
    expect(sent.get(PORT)).toBeUndefined();
    expect(sent.get(OTHER)).toBeUndefined();
  });

  test("a host named in header_hosts carries them too", async () => {
    const sent = await run(["other.test"]);
    expect(sent.get(OTHER)).toEqual(HEADERS);
  });

  test("with no scope every request keeps them (direct callers, as before)", async () => {
    const sent: Sent = new Map();
    await confirmSoft404Candidates(
      [{ url: SAME, statusCode: 200, parsed: parsePage(SHELL, SAME) }],
      { userAgent: "test-agent", customHeaders: HEADERS },
      async (url, _ua, headers) => {
        sent.set(url, headers);
        return { status: 200, body: SHELL };
      },
    );
    expect(sent.get(SAME)).toEqual(HEADERS);
  });
});
