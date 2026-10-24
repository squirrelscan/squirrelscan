// followRedirects follows redirects by hand, which bypasses the runtime's own
// cross-protocol-redirect rejection. These tests pin the scheme allowlist that
// replaces it, and — just as importantly — that ordinary http(s) chains still
// follow, since a guard that over-blocks would silently flatten every chain.

import { afterEach, describe, expect, test } from "bun:test";

import { followRedirects } from "../src/links/redirects";
import { setRequestAsync } from "../src/tools";

/** Serve a canned status/Location per URL; records what was actually fetched. */
function serve(routes: Record<string, { status: number; location?: string }>) {
  const fetched: string[] = [];
  setRequestAsync(async (url) => {
    fetched.push(url);
    const route = routes[url] ?? { status: 200 };
    const headers = new Headers();
    if (route.location) headers.set("location", route.location);
    return new Response(null, { status: route.status, headers });
  });
  return fetched;
}

afterEach(() => {
  setRequestAsync(() => {
    throw new Error("requestAsync not injected");
  });
});

describe("followRedirects scheme allowlist", () => {
  test("a file: redirect target is never fetched", async () => {
    const fetched = serve({
      "https://example.com/": { status: 302, location: "file:///etc/passwd" },
    });

    const chain = await followRedirects("https://example.com/");

    // The guard's whole point: the local path must not appear in the request log.
    expect(fetched).toEqual(["https://example.com/"]);
    expect(chain.endsInError).toBe(true);
  });

  test("the refused target does not leak into the reported chain", async () => {
    // hops[].url and finalUrl surface in the report, so a blocked target must not
    // ride along in either.
    serve({ "https://example.com/": { status: 302, location: "file:///etc/passwd" } });

    const chain = await followRedirects("https://example.com/");

    expect(JSON.stringify(chain)).not.toContain("etc/passwd");
    expect(chain.finalUrl).toBe("https://example.com/");
  });

  test.each([
    ["data:text/html,<h1>x", "data"],
    ["javascript:alert(1)", "javascript"],
    ["ftp://example.com/f", "ftp"],
  ])("%s is refused", async (location) => {
    const fetched = serve({ "https://example.com/": { status: 302, location } });

    const chain = await followRedirects("https://example.com/");

    expect(fetched).toEqual(["https://example.com/"]);
    expect(chain.endsInError).toBe(true);
  });

  test("ordinary http(s) chains still follow", async () => {
    const fetched = serve({
      "https://example.com/": { status: 301, location: "https://example.com/a" },
      "https://example.com/a": { status: 302, location: "https://example.com/b" },
      "https://example.com/b": { status: 200 },
    });

    const chain = await followRedirects("https://example.com/");

    expect(fetched).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(chain.finalUrl).toBe("https://example.com/b");
    expect(chain.chainLength).toBe(2);
    expect(chain.endsInError).toBe(false);
  });

  test("a relative Location still resolves against the current hop", async () => {
    const fetched = serve({
      "https://example.com/x/y": { status: 302, location: "../z" },
      "https://example.com/z": { status: 200 },
    });

    const chain = await followRedirects("https://example.com/x/y");

    expect(fetched).toContain("https://example.com/z");
    expect(chain.finalUrl).toBe("https://example.com/z");
  });

  test("a downgrade to http is followed, and still reported as a downgrade", async () => {
    // http is on the allowlist, so this must remain a *finding*, not a refusal —
    // the scheme guard must not quietly take over the downgrade check's job.
    serve({
      "https://example.com/": { status: 301, location: "http://example.com/" },
      "http://example.com/": { status: 200 },
    });

    const chain = await followRedirects("https://example.com/");

    expect(chain.httpsToHttp).toBe(true);
    expect(chain.endsInError).toBe(false);
  });
});

// repo#2830: http-to-https probes the http variant of the site's own pages, so
// an open redirect on the site (`/go?u=http://169.254.169.254/`) would send the
// auditor's machine to a metadata or link-local address through this loop.
describe("followRedirects egress", () => {
  const resolved: string[] = [];
  const resolve = async (host: string) => {
    resolved.push(host);
    if (host === "imds.example.net") return ["169.254.169.254"];
    if (host === "intranet.test") return ["10.0.0.5"];
    return ["93.184.215.14"];
  };

  test.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://[fe80::1]/x",
    "http://imds.example.net/latest/",
  ])("a redirect to %s is never fetched", async (location) => {
    const fetched = serve({ "http://example.com/go": { status: 302, location } });

    const chain = await followRedirects("http://example.com/go", resolve);

    expect(fetched).toEqual(["http://example.com/go"]);
    expect(chain.endsInError).toBe(true);
    expect(chain.finalUrl).toBe("http://example.com/go");
  });

  test("the probed host is followed without a lookup; a private host elsewhere still is followed", async () => {
    resolved.length = 0;
    const fetched = serve({
      "http://example.com/": { status: 301, location: "https://example.com/" },
      "https://example.com/": { status: 302, location: "http://intranet.test/home" },
      "http://intranet.test/home": { status: 200 },
    });

    const chain = await followRedirects("http://example.com/", resolve);

    expect(fetched).toEqual([
      "http://example.com/",
      "https://example.com/",
      "http://intranet.test/home",
    ]);
    expect(chain.endsInError).toBe(false);
    expect(resolved).toEqual(["intranet.test"]);
  });
});
