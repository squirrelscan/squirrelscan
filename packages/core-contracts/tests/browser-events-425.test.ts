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
    expect(out?.failedRequests).toEqual([{ url: "https://a.test/x", method: "GET", resourceType: "script", failure: "net::ERR_BLOCKED_BY_CSP [31m" }]);
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

// Every character a page could use to forge or hide a line in a terminal, report or agent context.
const HOSTILE = [
  "\u001b", "\u009b", "\u009d", "\u0007", "\u0090", "\u202e", "\u2066", "\u200e", "\u061c", "\u2028", "\u2029",
  "\u200b", "\u200d", "\u2060", "\ufeff", "\u00ad", "\u180e", "\u3164", "\u115f", "\uffa0", "\ufe0f", "\u{e0041}", "\t", "\n", "\r", "\u007f",
].join("");
const UNSAFE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]|\\p{Default_Ignorable_Code_Point}", "u");

describe("hostile text", () => {
  test("no field of a sanitised event carries a control, bidi or invisible character", () => {
    const events = readBrowserEvents({
      cspViolations: [
        {
          violatedDirective: `script${HOSTILE}-src`,
          effectiveDirective: `script${HOSTILE}-src-elem`,
          blockedUri: `https://cdn${HOSTILE}.test/a${HOSTILE}.js`,
          sourceFile: `https://site.test/${HOSTILE}app.js`,
          disposition: "enforce",
        },
        { violatedDirective: "img-src", blockedUri: `in${HOSTILE}line` },
      ],
      failedRequests: [{ url: `https://x.test/${HOSTILE}`, status: 500, error: `fail${HOSTILE}ed` }],
      pageErrors: [`TypeError:${HOSTILE} boom`],
    });
    expect(events).toBeDefined();
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(events);
    expect(strings.length).toBeGreaterThan(4);
    for (const s of strings) expect(UNSAFE.test(s)).toBe(false);
    // The words survive: the hostile run is removed or becomes a space, never the surrounding text.
    expect(events!.cspViolations[0]!.violatedDirective.replace(/ /g, "")).toBe("script-src");
    expect(events!.pageErrors[0]).toContain("TypeError:");
  });
});

describe("a blockedUri of another scheme keeps its scheme and host only", () => {
  const blocked = (value: unknown): string | undefined =>
    readBrowserEvents({ cspViolations: [{ violatedDirective: "img-src", blockedUri: value }] })?.cspViolations[0]?.blockedUri;

  test("userinfo, port, path, query and fragment never survive in an ftp or extension URL", () => {
    expect(blocked("ftp://u:pw@h.example/p?token=1#frag")).toBe("ftp://h.example");
    expect(blocked("chrome-extension://abcdefghijklmnop/page.html?k=v")).toBe("chrome-extension://abcdefghijklmnop");
    expect(blocked("ws-unknown://user@Host.Example:8080/x?y=z")).toBe("ws-unknown://host.example");
  });
  test("a scheme with no host is the scheme alone: javascript, mailto, tel", () => {
    expect(blocked("javascript:alert(document.cookie)")).toBe("javascript:");
    expect(blocked("mailto:person@example.invalid?subject=secret")).toBe("mailto:");
  });
  test("keywords and plain words are kept; a string with a path, query or assignment is dropped", () => {
    for (const keyword of ["inline", "eval", "wasm-eval", "trusted-types-policy", "self"]) expect(blocked(keyword)).toBe(keyword);
    expect(blocked("token=abc123")).toBeUndefined();
    expect(blocked("not a url/with?query")).toBeUndefined();
    // a URL the parser rejects still loses userinfo, query and fragment
    expect(blocked("ftp://u:pw@h example/p?token=1#f")).toBe("ftp://h example/p");
    expect(blocked("a".repeat(41))).toBeUndefined();
  });
  test("the kept http, https and keyword-scheme values are unchanged", () => {
    expect(blocked("https://cdn.example.invalid/a.js?k=v")).toBe("https://cdn.example.invalid/a.js");
    expect(blocked("data:text/plain;base64,AAAA")).toBe("data:");
  });
});
