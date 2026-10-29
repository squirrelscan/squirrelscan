// The start URL's redirect chain (squirrelscan/squirrelscan#1281): where it
// ends, whether that is the same site, and that every hop goes through the
// egress guard. The transport is a stub keyed on the URL asked; DNS is injected.

import { describe, expect, test } from "bun:test";

import { MAX_SEED_REDIRECT_HOPS } from "@squirrelscan/core-contracts/seed-redirect";

import { resolveStartRedirect } from "../src/seed-redirect";

// Built at runtime so no credential-shaped literal sits in the file (secret scan).
const USERINFO = ["u", "pw"].join(":");

type Answer = { status: number; location?: string };

/** A transport answering from a table; records what it was asked. */
function table(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const transport = async (url: string): Promise<Response> => {
    asked.push(url);
    const answer = answers[url] ?? { status: 404 };
    return new Response(null, {
      status: answer.status,
      headers: answer.location ? { location: answer.location } : {},
    });
  };
  return { transport, asked };
}

const PUBLIC = async () => ["93.184.216.34"];
const OPTIONS = { pin: false, policy: { resolve: PUBLIC } } as const;

describe("resolveStartRedirect", () => {
  test("a start URL that does not redirect resolves to itself", async () => {
    const { transport } = table({ "https://example.com/": { status: 200 } });
    const result = await resolveStartRedirect("https://example.com/", { ...OPTIONS, transport });
    expect(result.kind).toBe("none");
    expect(result.finalUrl).toBe("https://example.com/");
    expect(result.chain).toEqual([{ url: "https://example.com/", status: 200 }]);
  });

  test("http to https to www is the same site and ends on the final URL", async () => {
    const { transport } = table({
      "http://example.com/": { status: 301, location: "https://example.com/" },
      "https://example.com/": { status: 301, location: "https://www.example.com/" },
      "https://www.example.com/": { status: 200 },
    });
    const result = await resolveStartRedirect("http://example.com/", { ...OPTIONS, transport });
    expect(result.kind).toBe("same-site");
    expect(result.finalUrl).toBe("https://www.example.com/");
    expect(result.chain.map((hop) => hop.status)).toEqual([301, 301, 200]);
  });

  test("a shortener answering 301 to another domain is cross-domain", async () => {
    const { transport } = table({
      "https://bit.ly/abc": { status: 301, location: "https://example.org/pricing?ref=x" },
      "https://example.org/pricing?ref=x": { status: 200 },
    });
    const result = await resolveStartRedirect("https://bit.ly/abc", { ...OPTIONS, transport });
    expect(result.kind).toBe("cross-domain");
    expect(result.originalUrl).toBe("https://bit.ly/abc");
    // The query is the site's, and is not part of what is reported.
    expect(result.finalUrl).toBe("https://example.org/pricing");
    expect(result.chain).toEqual([
      { url: "https://bit.ly/abc", status: 301 },
      { url: "https://example.org/pricing", status: 200 },
    ]);
  });

  test("a relative Location resolves against the hop", async () => {
    const { transport } = table({
      "https://example.com/a": { status: 302, location: "/b" },
      "https://example.com/b": { status: 200 },
    });
    const result = await resolveStartRedirect("https://example.com/a", { ...OPTIONS, transport });
    expect(result.kind).toBe("same-site");
    expect(result.finalUrl).toBe("https://example.com/b");
  });

  test("a loop is reported with the chain so far", async () => {
    const { transport } = table({
      "https://a.example/": { status: 302, location: "https://b.example/" },
      "https://b.example/": { status: 302, location: "https://a.example/" },
    });
    const result = await resolveStartRedirect("https://a.example/", { ...OPTIONS, transport });
    expect(result.kind).toBe("loop");
    expect(result.chain.map((hop) => hop.url)).toEqual(["https://a.example/", "https://b.example/"]);
  });

  test("more than five hops is reported as too many and the sixth is not requested", async () => {
    const answers: Record<string, Answer> = {};
    for (let i = 0; i < 10; i++) {
      answers[`https://h${i}.example/`] = { status: 302, location: `https://h${i + 1}.example/` };
    }
    const { transport, asked } = table(answers);
    const result = await resolveStartRedirect("https://h0.example/", { ...OPTIONS, transport });
    expect(result.kind).toBe("too-many");
    expect(result.chain).toHaveLength(MAX_SEED_REDIRECT_HOPS + 1);
    expect(asked).toHaveLength(MAX_SEED_REDIRECT_HOPS + 1);
    expect(result.finalUrl).toBe(`https://h${MAX_SEED_REDIRECT_HOPS + 1}.example/`);
  });

  test("a redirect to a name that resolves to a private address is refused and never requested", async () => {
    const { transport, asked } = table({
      "https://shortener.com/x": { status: 301, location: "https://internal.test-host.com/admin" },
    });
    const resolve = async (host: string) => (host === "internal.test-host.com" ? ["10.0.0.5"] : ["93.184.216.34"]);
    const result = await resolveStartRedirect("https://shortener.com/x", {
      pin: false,
      policy: { resolve },
      transport,
    });
    expect(result.kind).toBe("refused");
    expect(result.finalUrl).toBe("https://internal.test-host.com/admin");
    expect(result.refusal).toMatch(/^refused/);
    expect(asked).toEqual(["https://shortener.com/x"]);
  });

  test("a redirect to a private IP literal or the metadata address is refused", async () => {
    for (const target of ["http://127.0.0.1:8080/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/"]) {
      const { transport, asked } = table({ "https://shortener.com/x": { status: 302, location: target } });
      const result = await resolveStartRedirect("https://shortener.com/x", { ...OPTIONS, transport });
      expect(result.kind).toBe("refused");
      expect(asked).toEqual(["https://shortener.com/x"]);
    }
  });

  test("a redirect to a non-http scheme is refused", async () => {
    const { transport } = table({ "https://shortener.com/x": { status: 302, location: "file:///etc/passwd" } });
    const result = await resolveStartRedirect("https://shortener.com/x", { ...OPTIONS, transport });
    expect(result.kind).toBe("refused");
  });

  test("a local start URL may redirect around the local network, but never to a metadata address", async () => {
    const local = table({
      "http://localhost:3000/": { status: 302, location: "http://127.0.0.1:3001/" },
      "http://127.0.0.1:3001/": { status: 200 },
    });
    const ok = await resolveStartRedirect("http://localhost:3000/", { ...OPTIONS, transport: local.transport });
    expect(ok.kind).toBe("cross-domain");
    expect(ok.finalUrl).toBe("http://127.0.0.1:3001/");

    const meta = table({
      "http://localhost:3000/": { status: 302, location: "http://169.254.169.254/" },
    });
    const refused = await resolveStartRedirect("http://localhost:3000/", { ...OPTIONS, transport: meta.transport });
    expect(refused.kind).toBe("refused");
  });

  test("a start URL the guard refuses outright is not a redirect", async () => {
    const { transport } = table({});
    const result = await resolveStartRedirect("http://169.254.169.254/", { ...OPTIONS, transport });
    expect(result.kind).toBe("none");
    expect(result.chain).toEqual([]);
  });

  test("a network failure on the destination ends the chain there", async () => {
    const transport = async (url: string): Promise<Response> => {
      if (url === "https://shortener.com/x") {
        return new Response(null, { status: 301, headers: { location: "https://gone-host.com/" } });
      }
      throw new TypeError("fetch failed");
    };
    const result = await resolveStartRedirect("https://shortener.com/x", { ...OPTIONS, transport });
    expect(result.kind).toBe("cross-domain");
    expect(result.finalUrl).toBe("https://gone-host.com/");
    expect(result.chain).toEqual([{ url: "https://shortener.com/x", status: 301 }]);
  });

  test("a detour through another domain and back is cross-domain, not same-site", async () => {
    const { transport } = table({
      "https://example.com/": { status: 302, location: "https://evil.org/hop" },
      "https://evil.org/hop": { status: 302, location: "https://www.example.com/" },
      "https://www.example.com/": { status: 200 },
    });
    const result = await resolveStartRedirect("https://example.com/", { ...OPTIONS, transport });
    expect(result.kind).toBe("cross-domain");
    expect(result.finalUrl).toBe("https://www.example.com/");
    expect(result.chain.map((hop) => hop.url)).toContain("https://evil.org/hop");
  });

  test("userinfo, query and fragment never reach the result, but the requests carry them", async () => {
    const { transport, asked } = table({
      "https://bit.ly/x": { status: 301, location: `https://${USERINFO}@app.example.com/login?token=SECRET#frag` },
      [`https://${USERINFO}@app.example.com/login?token=SECRET#frag`]: { status: 200 },
    });
    const result = await resolveStartRedirect("https://bit.ly/x", { ...OPTIONS, transport });
    expect(asked[1]).toContain("token=SECRET");
    const text = JSON.stringify(result);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("pw");
    expect(text).not.toContain("frag");
    expect(result.finalUrl).toBe("https://app.example.com/login");
  });

  test("a redirect to a non-http scheme is refused and named by scheme only", async () => {
    const { transport } = table({
      "https://shortener.com/x": { status: 302, location: "javascript:alert(document.cookie)" },
    });
    const result = await resolveStartRedirect("https://shortener.com/x", { ...OPTIONS, transport });
    expect(result.kind).toBe("refused");
    expect(result.refusal).toBe("refused scheme javascript:");
    expect(JSON.stringify(result)).not.toContain("alert");
  });
});
