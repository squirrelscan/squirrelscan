// squirrelscan/repo#2830: the plain fetcher's redirect hops go through the
// crawl's egress policy. A hop off the site that the policy refuses, or whose
// lookup fails, is never requested (fail closed), and an allowed one connects
// to the address that was vetted, never to a second lookup's answer.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  EgressRefusedError,
  memoizeResolveHost,
  type EgressPolicy,
} from "@squirrelscan/utils/public-egress";

import { createFetchDocumentFetcher } from "./index";

let server: ReturnType<typeof Bun.serve> | undefined;
const realFetch = globalThis.fetch;
let requested: Array<{ url: string; host: string | null }> = [];

beforeEach(() => {
  requested = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push({ url, host: new Headers(init?.headers).get("host") });
    // Only the local fixture is real; anything else (a made-up name, the
    // address a hop was pinned to) answers here, never from the network.
    if (new URL(url).hostname !== "127.0.0.1") return new Response("elsewhere");
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  server?.stop(true);
  server = undefined;
});

/** The site on 127.0.0.1: `/go` redirects to `location`. */
function serve(location: string): string {
  server = Bun.serve({
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/go"
        ? new Response(null, { status: 302, headers: { location } })
        : new Response("<!doctype html><title>ok</title>", {
            headers: { "content-type": "text/html" },
          }),
  });
  return `http://127.0.0.1:${server.port}`;
}

function policy(resolve: (host: string) => Promise<string[]>): EgressPolicy {
  return {
    allowPrivateNetwork: true,
    resolve,
    trustTarget: (url) => url.hostname === "127.0.0.1",
  };
}

describe("the plain fetcher's redirect egress (repo#2830)", () => {
  it("a hop off the site whose lookup fails is never requested: the fetch fails with that error", async () => {
    // The pre-check lets a resolver error through to the guarded send, which
    // vets again and fails the hop with it, so the crawl reports (and retries)
    // a network failure with its DNS reason instead of a bare 302.
    const origin = serve("http://elsewhere.example.net/x");
    await expect(
      createFetchDocumentFetcher().fetch({
        url: `${origin}/go`,
        egress: policy(() => Promise.reject(new Error("ENOTFOUND elsewhere.example.net"))),
      }),
    ).rejects.toThrow("ENOTFOUND");
    expect(requested.map((r) => new URL(r.url).hostname)).toEqual(["127.0.0.1"]);
  });

  it.each<[string, (host: string) => Promise<string[]>]>([
    ["an answer is link-local", async () => ["93.184.215.14", "169.254.169.254"]],
    ["an answer is the IPv6 metadata address", async () => ["fd00:ec2::254"]],
  ])("a hop off the site is never requested when %s", async (_why, resolve) => {
    const origin = serve("http://elsewhere.example.net/x");
    const res = await createFetchDocumentFetcher().fetch({
      url: `${origin}/go`,
      egress: policy(resolve),
    });
    expect(requested.map((r) => new URL(r.url).hostname)).toEqual(["127.0.0.1"]);
    expect(res.status).toBe(302);
    expect(res.redirectChain.endsInError).toBe(true);
  });

  // DNS rebinding: public on the first lookup, metadata on any later one.
  const flipping = () => {
    let calls = 0;
    return async () => (++calls === 1 ? ["93.184.215.14"] : ["169.254.169.254"]);
  };

  it("an allowed hop connects to the vetted address, not a later lookup's answer", async () => {
    // One lookup per name, as the crawl's policy does: the connect is pinned
    // to the answer that was vetted.
    const origin = serve("http://flip.example.net/x");
    await createFetchDocumentFetcher().fetch({
      url: `${origin}/go`,
      egress: policy(memoizeResolveHost(flipping())),
    });
    const hop = requested.filter((r) => r.host === "flip.example.net");
    expect(hop.map((r) => r.url)).toEqual(["http://93.184.215.14/x"]);
    expect(requested.some((r) => r.url.includes("169.254.169.254"))).toBe(false);
  });

  it("with a fresh lookup per check, the send-time answer is vetted again and refused", async () => {
    const origin = serve("http://flip.example.net/x");
    // The pre-check passed on the public answer; the send vets again, sees
    // the metadata answer, and fails the fetch before anything is sent.
    await expect(
      createFetchDocumentFetcher().fetch({ url: `${origin}/go`, egress: policy(flipping()) }),
    ).rejects.toBeInstanceOf(EgressRefusedError);
    expect(requested.map((r) => new URL(r.url).hostname)).toEqual(["127.0.0.1"]);
  });
});
