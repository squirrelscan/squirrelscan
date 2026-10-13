// #750: a vendor's cookie names it as surely as its headers do, a bot vendor
// behind a CDN is attributed to the vendor, and AWS infrastructure headers are
// not AWS WAF.

import { describe, expect, test } from "bun:test";

import {
  cookieNamesFromHeaders,
  detectWaf,
  detectWafFromCookies,
  detectWafFromHeaders,
  isLikelyWafBlock,
  type WafProvider,
} from "../src";

/** Headers with one `set-cookie` per entry, the way a response carries them. */
function withCookies(cookies: string[], base: Record<string, string> = {}): Headers {
  const headers = new Headers(base);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return headers;
}

describe("cookie fingerprints", () => {
  test.each<[WafProvider, string]>([
    ["cloudflare", "__cf_bm=abc.def-123; path=/; expires=Wed, 14 Oct 2026 12:00:00 GMT; HttpOnly"],
    ["cloudflare", "cf_clearance=abc; path=/; Secure"],
    ["datadome", "datadome=AHrlqAAAAAMA...; Max-Age=31536000; Domain=.example.com; Path=/"],
    ["perimeterx", "_px3=abc:def; Expires=Thu, 15 Oct 2026 12:00:00 GMT; path=/"],
    ["perimeterx", "_pxvid=1234-5678; Max-Age=31536000; path=/"],
    ["kasada", "KP_UIDz=abc; Path=/; Secure; HttpOnly"],
    ["kasada", "KP_UIDz-ssn=abc; Path=/; Secure"],
    ["akamai", "_abck=0B6...~-1~...; Domain=.example.com; Path=/"],
    ["akamai", "ak_bmsc=abc; Domain=.example.com; Path=/; HttpOnly"],
    ["akamai", "bm_sz=abc; Domain=.example.com; Path=/"],
    ["imperva", "visid_incap_123456=abc; expires=Thu, 14 Oct 2027 12:00:00 GMT; path=/"],
    ["imperva", "incap_ses_1234_567890=abc; path=/; Domain=.example.com"],
    ["imperva", "reese84=3:abc; Path=/; Secure"],
    ["aws-waf", "aws-waf-token=abc:def; Path=/; Secure"],
  ])("%s from a response that sets only %s", (provider, cookie) => {
    const result = detectWafFromHeaders(withCookies([cookie]));
    expect(result.detected).toBe(true);
    expect(result.provider).toBe(provider);
  });

  test("names only: the value never reaches the indicators", () => {
    const result = detectWafFromHeaders(withCookies(["datadome=SECRETVALUE123; Path=/"]));
    expect(result.indicators).toEqual(["cookie:datadome"]);
    expect(JSON.stringify(result)).not.toContain("SECRETVALUE123");
  });

  test("cookieNamesFromHeaders keeps each name once and drops every value", () => {
    const headers = withCookies(["a=1; Path=/", "b=2", "a=3", "flag"]);
    expect(cookieNamesFromHeaders(headers)).toEqual(["a", "b", "flag"]);
  });

  test("detectWafFromCookies reads stored names", () => {
    expect(detectWafFromCookies(["session", "_pxhd"]).provider).toBe("perimeterx");
    expect(detectWafFromCookies(["session", "csrftoken"]).detected).toBe(false);
  });

  test("an ordinary site's cookies are not a vendor", () => {
    const result = detectWafFromHeaders(
      withCookies(["sessionid=abc; Path=/", "_ga=GA1.2.3; Path=/", "px=1; Path=/", "datadomain=x"]),
    );
    expect(result.detected).toBe(false);
  });
});

describe("stacked vendors (#750)", () => {
  const CF = { "cf-ray": "8d1f2a3b4c5d6e7f-SYD", server: "cloudflare" };

  test("DataDome behind Cloudflare is DataDome, by header", () => {
    const result = detectWafFromHeaders(new Headers({ ...CF, "x-datadome": "protected" }));
    expect(result.provider).toBe("datadome");
    expect(result.providers).toEqual(["datadome", "cloudflare"]);
  });

  test("DataDome behind Cloudflare is DataDome, by cookie alone", () => {
    const result = detectWafFromHeaders(withCookies(["datadome=abc; Path=/"], CF));
    expect(result.provider).toBe("datadome");
  });

  test("DataDome behind Cloudflare is DataDome, by block page alone", () => {
    const body =
      '<html><head><title>example.com</title></head><body><script src="https://ct.captcha-delivery.com/c.js"></script></body></html>';
    const result = detectWaf(new Headers(CF), body);
    expect(result.provider).toBe("datadome");
    expect(result.providers).toContain("cloudflare");
  });

  test("Kasada behind Akamai is Kasada", () => {
    const result = detectWafFromHeaders(
      new Headers({ server: "AkamaiGHost", "x-kpsdk-ct": "abc" }),
    );
    expect(result.provider).toBe("kasada");
  });

  test("Cloudflare alone is still Cloudflare", () => {
    const result = detectWaf(new Headers(CF));
    expect(result.provider).toBe("cloudflare");
    expect(result.confidence).toBe("high");
  });
});

describe("AWS (#750)", () => {
  test("CloudFront alone is not AWS WAF", () => {
    const result = detectWaf(
      new Headers({
        "x-amz-cf-id": "Jq6RqZ3abc==",
        "x-amz-cf-pop": "SYD62-P1",
        via: "1.1 0123456789abcdef.cloudfront.net (CloudFront)",
        "x-cache": "Error from cloudfront",
      }),
    );
    expect(result.detected).toBe(false);
  });

  test("an AWS WAF challenge is AWS WAF, by its action header or its token host", () => {
    expect(detectWaf(new Headers({ "x-amzn-waf-action": "challenge" })).provider).toBe("aws-waf");
    const body =
      '<html><head><script src="https://abc123.edge.sdk.awswaf.com/abc123/def456/challenge.js"></script>' +
      '<script src="https://0a1b2c3d4e5f.us-east-1.token.awswaf.com/0a1b2c3d4e5f/jsapi.js"></script></head></html>';
    expect(detectWaf(new Headers(), body).provider).toBe("aws-waf");
  });
});

describe("AWS WAF Block on CloudFront (#750)", () => {
  const CLOUDFRONT = { "x-amz-cf-id": "Jq6RqZ3abc==", "x-amz-cf-pop": "SYD62-P1", server: "CloudFront" };
  /** CloudFront's error page for a request AWS WAF blocked, as served with a plain 403. */
  const BLOCK_PAGE =
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">' +
    '<HTML><HEAD><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=iso-8859-1"><TITLE>ERROR: The request could not be satisfied</TITLE></HEAD>' +
    "<BODY><H1>403 ERROR</H1><H2>The request could not be satisfied.</H2><HR noshade size=\"1px\">Request blocked.\n" +
    "We can't connect to the server for this app or website at this time. There might be too much traffic or a configuration error. Try again later, or contact the app or website owner.<BR clear=\"all\">" +
    "If you provide content to customers through CloudFront, you can find steps to troubleshoot and help prevent this error by reviewing the CloudFront documentation.<BR clear=\"all\">" +
    "<HR noshade size=\"1px\"><PRE>\nGenerated by cloudfront (CloudFront)\nRequest ID: Jq6RqZ3abc==\n</PRE><ADDRESS></ADDRESS></BODY></HTML>";
  /** S3's answer for an object that is not there (or not public): a real 403, not a WAF. */
  const S3_ACCESS_DENIED =
    '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message>' +
    "<RequestId>ABC123</RequestId><HostId>abc=</HostId></Error>";

  test("a 403 with CloudFront headers and its block page is an AWS WAF block", () => {
    const result = detectWaf(new Headers(CLOUDFRONT), BLOCK_PAGE);
    expect(result.provider).toBe("aws-waf");
    expect(isLikelyWafBlock(403, new Headers(CLOUDFRONT), BLOCK_PAGE)).toBe(true);
  });

  test("the same 403 with S3's AccessDenied body is not a WAF", () => {
    expect(detectWaf(new Headers(CLOUDFRONT), S3_ACCESS_DENIED).detected).toBe(false);
    expect(isLikelyWafBlock(403, new Headers(CLOUDFRONT), S3_ACCESS_DENIED)).toBe(false);
  });

  test("the token-host pattern stays linear on a long run of host characters", () => {
    const body = `${"a".repeat(20_000)}.token.awswaf.co`;
    const started = performance.now();
    detectWaf(new Headers(), body);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("nothing known", () => {
  test("an unknown signature stays undetected, never a guess", () => {
    const result = detectWaf(
      new Headers({ server: "nginx", "x-powered-by": "Express", via: "1.1 varnish" }),
      "<html><body><h1>Forbidden</h1></body></html>",
    );
    expect(result).toEqual({
      detected: false,
      provider: null,
      confidence: "low",
      indicators: [],
      providers: [],
    });
  });
});
