// security/url-sensitive-params flags sensitive query parameters and never prints their values (#2338).

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { CheckResult, RuleContext } from "../src/types";

import { redactSecretsInUrl } from "../src/security/leaked-secrets";
import {
  MAX_QUERY_URLS_PER_PAGE,
  sensitiveParamsOf,
  urlSensitiveParamsRule,
} from "../src/security/url-sensitive-params";

async function runPage(
  body: string,
  head = "",
  url = "https://example.com/"
): Promise<CheckResult[]> {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title>${head}</head><body>${body}</body></html>`;
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  return (await urlSensitiveParamsRule.run(ctx)).checks;
}

const STRIPE = `${"sk_"}${"live_"}${"A1b2C3d4E5f6G7h8I9j0K1l2"}`;

describe("security/url-sensitive-params", () => {
  test("flags a credential-named parameter in a link at fail", async () => {
    const checks = await runPage(
      `<a href="/dash?access_token=abc123def456">x</a>`
    );
    const check = checks.find((c) => c.name === "url-sensitive-params");
    expect(check?.status).toBe("fail");
    expect(check?.items?.[0]?.meta?.param).toBe("access_token");
  });

  test("never prints the value", async () => {
    const value = "hunter2-very-secret";
    const checks = await runPage(
      `<a href="/login?password=${value}">x</a>`,
      `<link rel="canonical" href="https://example.com/?token=${value}">`
    );
    expect(JSON.stringify(checks)).not.toContain(value);
  });

  test("flags a secret-shaped value under an innocent name, using the leaked-secrets matcher", async () => {
    const url = `https://example.com/?ref=${STRIPE}`;
    // The reused matcher itself calls this a secret.
    expect(redactSecretsInUrl(url)).not.toBe(url);
    const checks = await runPage(`<a href="${url}">x</a>`);
    const check = checks.find((c) => c.name === "url-sensitive-params");
    expect(check?.status).toBe("fail");
    expect(JSON.stringify(checks)).not.toContain(STRIPE);
  });

  test("never prints a secret in the path or a secret used as the parameter name", async () => {
    const jwt = `${"eyJhbGciOiJIUzI1NiJ9"}.${"eyJzdWIiOiIxMjM0NTY3ODkwIn0"}.${"dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}`;
    // Each URL on its own is a finding the matcher sees: a secret path segment, a secret name.
    expect(
      redactSecretsInUrl(`https://example.com/reset/${jwt}`)
    ).not.toContain(jwt);
    const checks = await runPage(
      `<a href="/reset/${jwt}?token=abcdefgh1234">x</a><a href="/hook?${STRIPE}=subscribed">y</a>`
    );
    const check = checks.find((c) => c.name === "url-sensitive-params");
    expect(check?.items?.length).toBe(2);
    const out = JSON.stringify(checks);
    expect(out).not.toContain(jwt);
    expect(out).not.toContain(STRIPE);
  });

  test("an email is a lower-severity warning", async () => {
    const checks = await runPage(`<a href="/u?email=jo@example.org">x</a>`);
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["url-personal-params", "warn"],
    ]);
    expect(JSON.stringify(checks)).not.toContain("jo@example.org");
  });

  test("reads form actions, canonical, og:url and the page URL", async () => {
    const checks = await runPage(
      `<form action="/go?apikey=k1k2k3k4k5"><input name=q></form>`,
      `<link rel="canonical" href="https://example.com/a?jwt=zzzz1111">
       <meta property="og:url" content="https://example.com/b?secret=s3cr3t00">`,
      "https://example.com/p?sessionid=1234abcd"
    );
    const sources = (
      checks.find((c) => c.name === "url-sensitive-params")?.items ?? []
    ).map((i) => i.meta?.source);
    expect(sources.sort()).toEqual([
      "canonical",
      "form action",
      "og:url",
      "page URL",
    ]);
  });

  test("ordinary parameters pass", async () => {
    const checks = await runPage(
      `<a href="/list?page=2&utm_source=news&id=42&q=shoes&sort=price&next_page_token=abc12345&csrf_token=zz9988xx">x</a>`
    );
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["url-sensitive-params", "pass"],
    ]);
  });

  test.each([
    ["empty value", "token="],
    ["placeholder", "token={token}"],
    ["flag", "password=true"],
  ])("skips an inert value: %s", (_label, query) => {
    expect(sensitiveParamsOf(`https://example.com/?${query}`)).toEqual([]);
  });

  test("an unsubscribe token is not reported", async () => {
    // Opaque one-click unsubscribe ids, the shapes mail platforms put in footers.
    const checks = await runPage(
      `<a href="/unsubscribe?unsubscribe_token=9f8e7d6c5b4a39281706f5e4d3c2b1a0">x</a><a href="/u?unsubscribeToken=Zm9vYmFyYmF6cXV4MTIzNDU2">y</a>`
    );
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["url-sensitive-params", "pass"],
    ]);
  });

  test("the cap is 500 query-bearing URLs per page", () => {
    expect(MAX_QUERY_URLS_PER_PAGE).toBe(500);
  });

  const benign = (n: number): string =>
    Array.from(
      { length: n },
      (_, i) => `<a href="/l${i}?page=${i}">x</a>`
    ).join("");
  const leak = `<a href="/dash?access_token=abc123def456">x</a>`;

  test("exactly 500 query-bearing URLs are all read and the page is not capped", async () => {
    const checks = await runPage(benign(499) + leak);
    const check = checks.find((c) => c.name === "url-sensitive-params");
    expect(check?.status).toBe("fail");
    expect(check?.details).toEqual({
      urlsChecked: 500,
      total: 1,
      capped: false,
    });
  });

  test("500 query-bearing URLs plus repeats and query-less links are not capped", async () => {
    const checks = await runPage(
      benign(500) + benign(3) + `<a href="/plain">x</a><a href="#top">y</a>`
    );
    expect(
      checks.find((c) => c.name === "url-sensitive-params")?.details
    ).toEqual({ urlsChecked: 500, capped: false });
  });

  test("the 501st query-bearing URL is not read and the page is capped", async () => {
    const checks = await runPage(benign(500) + leak);
    const check = checks.find((c) => c.name === "url-sensitive-params");
    expect(check?.status).toBe("pass");
    expect(check?.details).toEqual({ urlsChecked: 500, capped: true });
  });

  test("ignores non-http URLs and oversized input", () => {
    expect(sensitiveParamsOf("mailto:a@example.com?token=abcdefgh")).toEqual(
      []
    );
    expect(
      sensitiveParamsOf(`https://example.com/?token=${"a".repeat(5000)}`)
    ).toEqual([]);
  });
});
