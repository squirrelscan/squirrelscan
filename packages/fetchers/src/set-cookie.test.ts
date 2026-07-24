// #748/#973: `Headers.forEach` fires once per Set-Cookie header (unlike every
// other header, which the Headers object combines at insertion time), so a
// naive `result[key] = value` assignment inside forEach silently overwrites
// and keeps only the LAST cookie a page sets. Fixed via `getSetCookie()`
// joined with "\n" (not `.get()`'s comma-join, ambiguous with the comma in a
// cookie's own Expires attribute). This must survive a real multi-Set-Cookie
// response, not just a synthetic Headers object in isolation.

import { afterEach, describe, expect, it } from "bun:test";
import { createFetchDocumentFetcher } from "./index";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("headersToRecord Set-Cookie handling (#748/#973)", () => {
  it("keeps every cookie, newline-joined, when a page sets more than one", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        const headers = new Headers({ "Content-Type": "text/html" });
        headers.append("Set-Cookie", "session=abc123; Path=/; HttpOnly");
        headers.append(
          "Set-Cookie",
          "consent=1; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Secure",
        );
        return new Response("<!doctype html><title>t</title>", { headers });
      },
    });
    const fetcher = createFetchDocumentFetcher();
    const res = await fetcher.fetch({ url: `http://localhost:${server.port}/` });
    const cookies = (res.headers["set-cookie"] ?? "").split("\n");
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toBe("session=abc123; Path=/; HttpOnly");
    expect(cookies[1]).toBe("consent=1; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Secure");
  });

  it("keeps all three cookies when a page sets three", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        const headers = new Headers({ "Content-Type": "text/html" });
        headers.append("Set-Cookie", "session=abc123; Path=/; HttpOnly");
        headers.append("Set-Cookie", "csrftoken=xyz789; Path=/; Secure; SameSite=Strict");
        headers.append("Set-Cookie", "optout=1; Path=/; Max-Age=31536000");
        return new Response("<!doctype html><title>t</title>", { headers });
      },
    });
    const fetcher = createFetchDocumentFetcher();
    const res = await fetcher.fetch({ url: `http://localhost:${server.port}/` });
    const cookies = (res.headers["set-cookie"] ?? "").split("\n");
    expect(cookies).toHaveLength(3);
    expect(cookies.map((c) => c.split("=")[0])).toEqual(["session", "csrftoken", "optout"]);
  });

  it("still returns the single cookie for the common single-cookie case", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        const headers = new Headers({ "Content-Type": "text/html" });
        headers.append("Set-Cookie", "session=abc123; Path=/; HttpOnly; Secure");
        return new Response("<!doctype html><title>t</title>", { headers });
      },
    });
    const fetcher = createFetchDocumentFetcher();
    const res = await fetcher.fetch({ url: `http://localhost:${server.port}/` });
    expect(res.headers["set-cookie"]).toBe("session=abc123; Path=/; HttpOnly; Secure");
  });

  it("no Set-Cookie header: absent from the record, not an empty string", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("<!doctype html><title>t</title>", {
          headers: { "Content-Type": "text/html" },
        }),
    });
    const fetcher = createFetchDocumentFetcher();
    const res = await fetcher.fetch({ url: `http://localhost:${server.port}/` });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("other headers are unaffected by the Set-Cookie special-casing", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        const headers = new Headers({ "Content-Type": "text/html", "X-Custom": "value" });
        headers.append("Set-Cookie", "a=1");
        return new Response("<!doctype html><title>t</title>", { headers });
      },
    });
    const fetcher = createFetchDocumentFetcher();
    const res = await fetcher.fetch({ url: `http://localhost:${server.port}/` });
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["x-custom"]).toBe("value");
  });
});
