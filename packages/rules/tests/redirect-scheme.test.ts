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

// repo#2830 review: the hop check fails closed, judges every A/AAAA answer,
// catches every spelling of a refused address, and holds across a chain that
// leaves and re-enters the site.
describe("followRedirects egress: fail closed, all answers, encodings, chains", () => {
  const publicIp = async () => ["93.184.215.14"];

  test.each<[string, (host: string) => Promise<string[]>]>([
    ["the lookup fails", async () => Promise.reject(new Error("ENOTFOUND"))],
    ["the lookup times out", async () => Promise.reject(new Error("ETIMEOUT"))],
    [
      "the resolver throws",
      (() => {
        throw new Error("resolver exploded");
      }) as unknown as (host: string) => Promise<string[]>,
    ],
    ["there is no answer", async () => []],
  ])("a hop off the probed host is not followed when %s", async (_why, resolve) => {
    const fetched = serve({
      "http://example.com/go": { status: 302, location: "https://elsewhere.example.net/x" },
    });
    const chain = await followRedirects("http://example.com/go", resolve);
    expect(fetched).toEqual(["http://example.com/go"]);
    expect(chain.endsInError).toBe(true);
  });

  test("a hop that stays on the probed host is followed whatever the resolver does", async () => {
    const fetched = serve({
      "http://example.com/go": { status: 301, location: "https://example.com/go" },
      "https://example.com/go": { status: 200 },
    });
    const chain = await followRedirects("http://example.com/go", async () => {
      throw new Error("ENOTFOUND");
    });
    expect(fetched).toEqual(["http://example.com/go", "https://example.com/go"]);
    expect(chain.endsInError).toBe(false);
  });

  test.each(["http://[::1", "http://exa mple.com/", "http://:80/"])(
    "a malformed Location (%s) is not followed",
    async (location) => {
      const fetched = serve({ "http://example.com/go": { status: 302, location } });
      const chain = await followRedirects("http://example.com/go", publicIp);
      expect(fetched).toEqual(["http://example.com/go"]);
      expect(chain.endsInError).toBe(true);
    },
  );

  test.each([
    [["93.184.215.14", "169.254.169.254"]],
    [["93.184.215.14", "fe80::1"]],
    [["2606:2800:21f:cb07:6820:80da:af6b:8b2c", "fd00:ec2::254"]],
    [["93.184.215.14", "::ffff:169.254.169.254"]],
    [["93.184.215.14", "64:ff9b::a9fe:a9fe"]],
    [["93.184.215.14", "168.63.129.16"]],
  ])("a name with any refused answer among %j is not followed", async (answers) => {
    const fetched = serve({
      "http://example.com/go": { status: 302, location: "http://rebind.example.net/x" },
    });
    const chain = await followRedirects("http://example.com/go", async () => answers);
    expect(fetched).toEqual(["http://example.com/go"]);
    expect(chain.endsInError).toBe(true);
  });

  test.each([
    "http://169.254.169.254/",
    "http://169.254.169.254./",
    "http://2852039166/",
    "http://0xA9FEA9FE/",
    "http://0xa9.0xfe.0xa9.0xfe/",
    "http://0251.0376.0251.0376/",
    "http://169.254.43518/",
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[0:0:0:0:0:ffff:a9fe:a9fe]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[fd00:ec2::254]/",
    "http://[FE80::1]/",
    "http://metadata.google.internal/",
    "http://metadata.google.internal./",
    "http://METADATA.GOOGLE.INTERNAL/",
    "HTTP://Metadata.Google.Internal:80/computeMetadata/v1/",
  ])("%s is refused without a lookup", async (location) => {
    const asked: string[] = [];
    const fetched = serve({ "http://example.com/go": { status: 302, location } });
    const chain = await followRedirects("http://example.com/go", async (host) => {
      asked.push(host);
      return ["93.184.215.14"];
    });
    expect(fetched).toEqual(["http://example.com/go"]);
    expect(chain.endsInError).toBe(true);
    expect(asked).toEqual([]);
  });

  test("a chain that leaves and re-enters the site is checked at every hop off it", async () => {
    const asked: string[] = [];
    const fetched = serve({
      "http://example.com/a": { status: 301, location: "https://cdn.example.net/b" },
      "https://cdn.example.net/b": { status: 302, location: "https://example.com/c" },
      "https://example.com/c": { status: 302, location: "https://login.example.org/d" },
      "https://login.example.org/d": { status: 302, location: "http://169.254.169.254/e" },
    });
    const chain = await followRedirects("http://example.com/a", async (host) => {
      asked.push(host);
      return ["93.184.215.14"];
    });
    expect(fetched).toEqual([
      "http://example.com/a",
      "https://cdn.example.net/b",
      "https://example.com/c",
      "https://login.example.org/d",
    ]);
    expect(chain.endsInError).toBe(true);
    expect(asked).toEqual(["cdn.example.net", "login.example.org"]);
  });

  test("a name that answers differently on a second lookup is judged once per probe", async () => {
    // Rebinding within a chain: the memoized answer is the one judged for
    // every hop to that name, so a later answer cannot slip in mid-probe.
    let calls = 0;
    const fetched = serve({
      "http://example.com/a": { status: 302, location: "https://flip.example.net/b" },
      "https://flip.example.net/b": { status: 302, location: "https://example.com/c" },
      "https://example.com/c": { status: 302, location: "https://flip.example.net/d" },
      "https://flip.example.net/d": { status: 200 },
    });
    const chain = await followRedirects("http://example.com/a", async () => {
      calls++;
      return calls === 1 ? ["93.184.215.14"] : ["169.254.169.254"];
    });
    expect(calls).toBe(1);
    expect(fetched).toHaveLength(4);
    expect(chain.endsInError).toBe(false);
  });

  test("the hop cap holds on a chain that keeps changing hosts", async () => {
    const routes: Record<string, { status: number; location?: string }> = {};
    for (let i = 0; i < 30; i++) {
      const host = i % 2 === 0 ? "example.com" : `hop${i}.example.net`;
      const next = (i + 1) % 2 === 0 ? "example.com" : `hop${i + 1}.example.net`;
      routes[`https://${host}/${i}`] = { status: 302, location: `https://${next}/${i + 1}` };
    }
    const fetched = serve(routes);
    await followRedirects("https://example.com/0", publicIp);
    expect(fetched).toHaveLength(10);
  });
});
