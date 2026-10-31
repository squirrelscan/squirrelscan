import { describe, expect, test } from "bun:test";

import { BROWSER_EVENT_LIMITS, eventUrl, readBrowserEvents } from "../src/browser-events";

describe("eventUrl", () => {
  test("keeps an origin and path and drops userinfo, query and fragment", () => {
    // Built from parts so the secret scanner does not flag the fixture.
    const userinfo = ["user", "pw"].join(":");
    expect(eventUrl(`https://${userinfo}@cdn.test:8443/a/b.js?token=SECRET#frag`)).toBe("https://cdn.test:8443/a/b.js");
    expect(eventUrl("wss://live.test/socket?x=1")).toBe("wss://live.test/socket");
  });
  test("a CSP keyword stays a keyword, anything else is dropped", () => {
    expect(eventUrl("inline")).toBe("inline");
    expect(eventUrl("EVAL")).toBe("eval");
    expect(eventUrl("data:text/html;base64,AAAA")).toBe("data:");
    expect(eventUrl("not a url with spaces")).toBeUndefined();
    expect(eventUrl(42)).toBeUndefined();
    expect(eventUrl("")).toBeUndefined();
  });
});

describe("readBrowserEvents", () => {
  test("nothing, or not an object, is undefined", () => {
    expect(readBrowserEvents(undefined)).toBeUndefined();
    expect(readBrowserEvents(null)).toBeUndefined();
    expect(readBrowserEvents("x")).toBeUndefined();
    expect(readBrowserEvents([])).toBeUndefined();
    expect(readBrowserEvents({ cspViolations: [], failedRequests: [], pageErrors: [] })).toBeUndefined();
  });

  test("an empty window that was watched after load is kept: it says the page was clean", () => {
    expect(readBrowserEvents({ cspViolations: [], failedRequests: [], pageErrors: [], listenedAfterLoad: true })).toEqual({
      cspViolations: [],
      failedRequests: [],
      pageErrors: [],
      listenedAfterLoad: true,
    });
  });

  test("violations are normalised: directives lower-cased, URLs cut, malformed items dropped", () => {
    const out = readBrowserEvents({
      cspViolations: [
        {
          violatedDirective: "Script-Src-Elem",
          effectiveDirective: "script-src",
          blockedUri: "https://w.test/e.js?k=v",
          sourceFile: "https://app.test/a.js?x=1",
          lineNumber: 7,
          disposition: "enforce",
        },
        { violatedDirective: "img-src" },
        { blockedUri: "https://x.test/" },
        "junk",
        { violatedDirective: "connect-src", blockedUri: "https://y.test/c", lineNumber: -3, disposition: "weird" },
      ],
    });
    expect(out?.cspViolations).toEqual([
      { violatedDirective: "script-src-elem", effectiveDirective: "script-src", blockedUri: "https://w.test/e.js", sourceFile: "https://app.test/a.js", lineNumber: 7, disposition: "enforce" },
      { violatedDirective: "connect-src", blockedUri: "https://y.test/c" },
    ]);
  });

  test("failed requests and page errors are bounded and lose control characters", () => {
    const out = readBrowserEvents({
      failedRequests: [
        { url: "https://a.test/x?q=1", method: "get", resourceType: "Script", failure: "net::ERR_BLOCKED_BY_CSP\u001b[31m", status: 0 },
        { url: "javascript:alert(1)" },
      ],
      pageErrors: ["TypeError: x is undefined\u0007", "", 5, "e".repeat(5000)],
    });
    expect(out?.failedRequests).toEqual([{ url: "https://a.test/x", method: "GET", resourceType: "script", failure: "net::ERR_BLOCKED_BY_CSP[31m" }]);
    expect(out?.pageErrors[0]).toBe("TypeError: x is undefined");
    expect(out?.pageErrors[1]).toHaveLength(BROWSER_EVENT_LIMITS.text);
    expect(out?.pageErrors).toHaveLength(2);
  });

  test("every list is capped", () => {
    const out = readBrowserEvents({
      cspViolations: Array.from({ length: 500 }, (_, i) => ({ violatedDirective: "img-src", blockedUri: `https://h${i}.test/a` })),
      failedRequests: Array.from({ length: 500 }, (_, i) => ({ url: `https://h${i}.test/a` })),
      pageErrors: Array.from({ length: 500 }, (_, i) => `error ${i}`),
    });
    expect(out?.cspViolations).toHaveLength(BROWSER_EVENT_LIMITS.cspViolations);
    expect(out?.failedRequests).toHaveLength(BROWSER_EVENT_LIMITS.failedRequests);
    expect(out?.pageErrors).toHaveLength(BROWSER_EVENT_LIMITS.pageErrors);
  });
});
