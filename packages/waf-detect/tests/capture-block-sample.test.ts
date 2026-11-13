import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBlockSample, writeSample, type FetchImpl } from "../scripts/capture-block-sample";

const HOST = "shop.example.com";
const NETLIFY = "fixture-shop.netlify.app";
const IP = "203.0.113.77";
const UUID_VALUE = "123e4567-e89b-42d3-a456-426614174000";
const SECRET = ["tok", "en"].join("");

function blockResponse(body: string): Response {
  const headers = new Headers({
    "content-type": "text/html",
    "x-forwarded-for": IP,
    "x-nf-request-id": "01ABCDEFGHJKMNPQRSTVWXYZ12",
    "x-served-by": "cache-fra-example",
    location: `https://www.${HOST}/blocked`,
  });
  headers.append("set-cookie", "a=1; Path=/");
  headers.append("set-cookie", "b=2; Path=/");
  return new Response(body, { status: 403, headers });
}

const BODY =
  `<html><body><h1>Blocked</h1><p>Request to ${HOST} from ${IP} ` +
  `id ${UUID_VALUE}</p><a href="https://www.${HOST}/x?${SECRET}=abc123">x</a></body></html>`;

function spyFetch(make: () => Response) {
  const calls: { input: string; init?: RequestInit }[] = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    calls.push({ input, init });
    return make();
  };
  return { fetchImpl, calls };
}

const fixedNow = () => new Date("2026-11-01T10:00:00Z");

describe("captureBlockSample", () => {
  test("sanitises headers and body and leaks neither host nor ip", async () => {
    const { fetchImpl } = spyFetch(() => blockResponse(BODY));
    const s = await captureBlockSample({
      url: `https://${HOST}/p?q=secret`,
      name: "netlify-test",
      fetchImpl,
      now: fixedNow,
    });
    expect(s.how).toBe("live");
    expect(s.status).toBe(403);
    expect(s.capturedAt).toBe("2026-11-01");
    expect(s.source).toBe("https://example.com/p?q=REDACTED");
    expect(s.headers["set-cookie"]).toBeUndefined();
    expect(s.redactions.cookies).toBe(2);
    expect(s.headers["x-forwarded-for"]).toBe("REDACTED-IP");
    expect(s.headers["x-nf-request-id"]).toBe("REDACTED-REQUEST-ID");
    expect(s.headers["x-served-by"]).toBe("REDACTED-REQUEST-ID");
    expect(s.headers["location"]).toBe("https://example.com/blocked");
    expect(s.html).toContain("Request to example.com from REDACTED-IP");
    expect(s.html).toContain("id REDACTED-ID");
    expect(s.html).toContain(`${SECRET}=REDACTED-TOKEN`);
    expect(s.redactions.hosts).toBeGreaterThanOrEqual(3);
    expect(s.redactions.ips).toBeGreaterThanOrEqual(2);
    expect(s.redactions.requestIds).toBeGreaterThanOrEqual(2);
    expect(s.redactions.tokens).toBe(1);

    const json = JSON.stringify(s);
    expect(json).not.toContain(HOST);
    expect(json).not.toContain(IP);
    expect(json).not.toContain(UUID_VALUE);
    expect(json).not.toContain("abc123");
    expect(json).not.toContain("secret");
    expect(json).not.toContain("cache-fra-example");
  });

  test("replaces every *.netlify.app origin in the body and Location, not only the target", async () => {
    const body =
      `<a href="https://${NETLIFY}/">origin</a>` +
      `<a href="https://api.${NETLIFY}/x">api</a>` +
      `<a href="https://${NETLIFY}.evil.test/">lookalike</a>` +
      `<a href="https://app.netlify.com/docs">netlify docs</a>`;
    const { fetchImpl } = spyFetch(
      () =>
        new Response(body, {
          status: 403,
          headers: { location: `https://${NETLIFY}/blocked?ref=1` },
        }),
    );
    const s = await captureBlockSample({ url: `https://${HOST}/`, fetchImpl, now: fixedNow });
    expect(s.headers["location"]).toBe("https://example.com/blocked?ref=1");
    expect(s.html).toContain('href="https://example.com/"');
    expect(s.html).toContain('href="https://example.com/x">api');
    expect(s.html).toContain('href="https://example.com/">lookalike');
    // The provider's own domain is evidence, so it is kept.
    expect(s.html).toContain("https://app.netlify.com/docs");
    const json = JSON.stringify(s);
    expect(json).not.toContain(NETLIFY);
    expect(json).not.toContain("evil.test");
  });

  test("replaces the host of any absolute Location and keeps a relative one", async () => {
    const cases: [string, string][] = [
      ["https://checkout.example.com/hold?x=1", "https://example.com/hold?x=1"],
      ["//edge.example.com/x", "https://example.com/x"],
      ["https://u:p@checkout.example.com/", "https://example.com/"],
      ["/blocked?ref=1", "/blocked?ref=1"],
    ];
    for (const [location, expected] of cases) {
      const { fetchImpl } = spyFetch(
        () => new Response("", { status: 302, headers: { location } }),
      );
      const s = await captureBlockSample({ url: `https://${HOST}/`, fetchImpl, now: fixedNow });
      expect(s.headers["location"]).toBe(expected);
      const json = JSON.stringify(s);
      expect(json).not.toContain("checkout");
      expect(json).not.toContain("edge.example");
      expect(json).not.toContain("u:p@");
    }
  });

  test("scrubs IPv6 addresses but leaves times and CSS pseudo-elements alone", async () => {
    const body =
      "<p>from 2001:db8::1 and 2001:0db8:85a3:0000:0000:8a2e:0370:7334</p>" +
      "<p>at 12:30:45</p><style>a::before{content:''}</style>";
    const { fetchImpl } = spyFetch(
      () =>
        new Response(body, {
          status: 403,
          headers: { "x-sigsci-tags": "from 2001:db8::3 SQLI", "x-forwarded-for": "2001:db8::2" },
        }),
    );
    const s = await captureBlockSample({ url: `https://${HOST}/`, fetchImpl, now: fixedNow });
    expect(s.html).toContain("from REDACTED-IP and REDACTED-IP");
    expect(s.html).toContain("at 12:30:45");
    expect(s.html).toContain("a::before{content:''}");
    expect(s.headers["x-sigsci-tags"]).toBe("from REDACTED-IP SQLI");
    expect(s.headers["x-forwarded-for"]).toBe("REDACTED-IP");
    const json = JSON.stringify(s);
    expect(json).not.toContain("2001:db8");
    expect(json).not.toContain("8a2e");
  });

  test("redacts cf-ray and x-amz-cf-id values and keeps their names", async () => {
    const CF_RAY = "8f1d2c3b4a596877-FRA";
    const AMZ_CF_ID = "Zq8w0Xy2AbCdEf1234567890QrStUvWxYz==";
    const { fetchImpl } = spyFetch(
      () =>
        new Response("", {
          status: 403,
          headers: { "cf-ray": CF_RAY, "x-amz-cf-id": AMZ_CF_ID },
        }),
    );
    const s = await captureBlockSample({ url: `https://${HOST}/`, fetchImpl, now: fixedNow });
    expect(s.headers["cf-ray"]).toBe("REDACTED-REQUEST-ID");
    expect(s.headers["x-amz-cf-id"]).toBe("REDACTED-REQUEST-ID");
    expect(s.redactions.requestIds).toBe(2);
    const json = JSON.stringify(s);
    expect(json).not.toContain(CF_RAY);
    expect(json).not.toContain(AMZ_CF_ID);
  });

  test("replaces Netlify and Fastly client-IP headers whole, whatever their value looks like", async () => {
    // A value no IP pattern matches: only the header name can get it redacted.
    const { fetchImpl } = spyFetch(
      () =>
        new Response("", {
          status: 403,
          headers: {
            "x-nf-client-connection-ip": "opaque-client-7f3a",
            "fastly-client-ip": "2001:db8::9",
          },
        }),
    );
    const s = await captureBlockSample({ url: `https://${HOST}/`, fetchImpl, now: fixedNow });
    expect(s.headers["x-nf-client-connection-ip"]).toBe("REDACTED-IP");
    expect(s.headers["fastly-client-ip"]).toBe("REDACTED-IP");
    expect(s.redactions.ips).toBe(2);
    const json = JSON.stringify(s);
    expect(json).not.toContain("opaque-client-7f3a");
    expect(json).not.toContain("2001:db8::9");
  });

  test("redacts only the id part of x-sigsci headers", async () => {
    const { fetchImpl } = spyFetch(
      () => new Response("", { status: 406, headers: { "x-sigsci-tags": `SQLI ${UUID_VALUE}` } }),
    );
    const s = await captureBlockSample({ url: `https://${HOST}/`, fetchImpl, now: fixedNow });
    expect(s.headers["x-sigsci-tags"]).toBe("SQLI REDACTED-ID");
    expect(s.html).toBeNull();
    expect(s.name).toBe("live-406-2026-11-01");
  });

  test("asks for manual redirects, no credentials, plain user agent", async () => {
    const { fetchImpl, calls } = spyFetch(() => blockResponse(BODY));
    await captureBlockSample({ url: `https://${HOST}/`, fetchImpl, now: fixedNow });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[0]?.init?.credentials).toBe("omit");
    const sent = new Headers(calls[0]?.init?.headers);
    expect(sent.get("user-agent")).toContain("squirrelscan-capture");
    // The script never sends credentials or cookies of its own.
    expect(sent.has("authorization")).toBe(false);
    expect(sent.has("cookie")).toBe(false);
  });

  test("rejects bad URLs before any fetch", async () => {
    const { fetchImpl, calls } = spyFetch(() => blockResponse(BODY));
    for (const url of [
      "ftp://example.com/",
      "file:///etc/hosts",
      "https://u:p@example.com/",
      "nope",
    ]) {
      await expect(captureBlockSample({ url, fetchImpl })).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });

  test("truncates a body over the cap", async () => {
    const { fetchImpl } = spyFetch(() => new Response("a".repeat(100), { status: 403 }));
    const s = await captureBlockSample({
      url: `https://${HOST}/`,
      fetchImpl,
      now: fixedNow,
      maxBytes: 10,
    });
    expect(s.truncated).toBe(true);
    expect(s.html).toBe("a".repeat(10));
  });

  test("does not flag a body at exactly the cap", async () => {
    const { fetchImpl } = spyFetch(() => new Response("a".repeat(10), { status: 403 }));
    const s = await captureBlockSample({ url: `https://${HOST}/`, fetchImpl, maxBytes: 10 });
    expect(s.truncated).toBe(false);
  });
});

describe("writeSample", () => {
  test("refuses to overwrite without force, creates parent dirs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-block-"));
    try {
      const { fetchImpl } = spyFetch(() => blockResponse(BODY));
      const s = await captureBlockSample({ url: `https://${HOST}/`, fetchImpl, now: fixedNow });
      const file = join(dir, "nested", "sample.json");
      await writeSample(file, s, false);
      expect(existsSync(file)).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(text.endsWith("}\n")).toBe(true);
      expect(JSON.parse(text).how).toBe("live");

      await expect(writeSample(file, { ...s, name: "other" }, false)).rejects.toThrow(/--force/);
      expect(JSON.parse(readFileSync(file, "utf8")).name).toBe(s.name);

      await writeSample(file, { ...s, name: "other" }, true);
      expect(JSON.parse(readFileSync(file, "utf8")).name).toBe("other");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
