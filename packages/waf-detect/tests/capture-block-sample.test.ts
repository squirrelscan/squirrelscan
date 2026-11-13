import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBlockSample, writeSample, type FetchImpl } from "../scripts/capture-block-sample";

const HOST = "shop.example.com";
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
    expect(s.headers["x-served-by"]).toBe("cache-fra-example");
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
    const ua = new Headers(calls[0]?.init?.headers).get("user-agent");
    expect(ua).toContain("squirrelscan-capture");
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
