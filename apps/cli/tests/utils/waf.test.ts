// WAF detection utility tests

import { describe, expect, it } from "bun:test";

import {
  detectWafFromHeaders,
  detectWafFromContent,
  detectWaf,
  isLikelyWafBlock,
  getWafProviderName,
} from "@/utils/waf";

describe("detectWafFromHeaders", () => {
  it("detects Cloudflare from CF-Ray header", () => {
    const headers = new Headers({ "cf-ray": "abc123-LAX" });
    const result = detectWafFromHeaders(headers);

    expect(result.detected).toBe(true);
    expect(result.provider).toBe("cloudflare");
    expect(result.confidence).toBe("high");
    expect(result.indicators.length).toBeGreaterThan(0);
  });

  it("detects Cloudflare from Server header", () => {
    const headers = new Headers({ server: "cloudflare" });
    const result = detectWafFromHeaders(headers);

    expect(result.detected).toBe(true);
    expect(result.provider).toBe("cloudflare");
  });

  it("detects Akamai from Server header", () => {
    const headers = new Headers({ server: "AkamaiGHost" });
    const result = detectWafFromHeaders(headers);

    expect(result.detected).toBe(true);
    expect(result.provider).toBe("akamai");
    expect(result.confidence).toBe("high");
  });

  it("detects Akamai from X-Akamai-Transformed header", () => {
    const headers = new Headers({
      "x-akamai-transformed": "9 12345 0 pmb=mRUM",
    });
    const result = detectWafFromHeaders(headers);

    expect(result.detected).toBe(true);
    expect(result.provider).toBe("akamai");
  });

  it("detects AWS WAF from x-amzn-requestid header", () => {
    const headers = new Headers({ "x-amzn-requestid": "abc-123-def" });
    const result = detectWafFromHeaders(headers);

    expect(result.detected).toBe(true);
    expect(result.provider).toBe("aws-waf");
    expect(result.confidence).toBe("medium");
  });

  it("detects Sucuri from X-Sucuri-ID header", () => {
    const headers = new Headers({ "x-sucuri-id": "12345" });
    const result = detectWafFromHeaders(headers);

    expect(result.detected).toBe(true);
    expect(result.provider).toBe("sucuri");
    expect(result.confidence).toBe("high");
  });

  it("detects Imperva from X-CDN header", () => {
    const headers = new Headers({ "x-cdn": "Incapsula" });
    const result = detectWafFromHeaders(headers);

    expect(result.detected).toBe(true);
    expect(result.provider).toBe("imperva");
  });

  it("detects DataDome from x-datadome header", () => {
    const headers = new Headers({ "x-datadome": "some-value" });
    const result = detectWafFromHeaders(headers);

    expect(result.detected).toBe(true);
    expect(result.provider).toBe("datadome");
  });

  it("detects PerimeterX from x-px-pp header", () => {
    const headers = new Headers({ "x-px-pp": "some-value" });
    const result = detectWafFromHeaders(headers);

    expect(result.detected).toBe(true);
    expect(result.provider).toBe("perimeterx");
  });

  it("returns not detected for normal headers", () => {
    const headers = new Headers({
      "content-type": "text/html",
      server: "nginx",
    });
    const result = detectWafFromHeaders(headers);

    expect(result.detected).toBe(false);
    expect(result.provider).toBe(null);
  });

  it("returns not detected for empty headers", () => {
    const headers = new Headers();
    const result = detectWafFromHeaders(headers);

    expect(result.detected).toBe(false);
  });
});

describe("detectWafFromContent", () => {
  it("detects Cloudflare challenge page", () => {
    const html = `
      <html>
        <head><title>Just a moment...</title></head>
        <body>
          <div>Checking your browser before accessing the site.</div>
          <div id="cf-browser-verification">Please wait...</div>
        </body>
      </html>
    `;
    const result = detectWafFromContent(html);

    expect(result.detected).toBe(true);
    expect(result.provider).toBe("cloudflare");
  });

  it("detects Cloudflare Ray ID in content", () => {
    const html = `
      <html>
        <body>
          <p>Access denied</p>
          <p>Cloudflare Ray ID: abc123</p>
        </body>
      </html>
    `;
    const result = detectWafFromContent(html);

    expect(result.detected).toBe(true);
    expect(result.provider).toBe("cloudflare");
  });

  it("detects Sucuri firewall page", () => {
    const html = `
      <html>
        <body>
          <h1>Sucuri Website Firewall</h1>
          <p>Access Denied - Sucuri Website Firewall</p>
        </body>
      </html>
    `;
    const result = detectWafFromContent(html);

    expect(result.detected).toBe(true);
    expect(result.provider).toBe("sucuri");
  });

  it("detects Imperva/Incapsula page", () => {
    const html = `
      <html>
        <body>
          <p>Incapsula incident ID: 123456</p>
        </body>
      </html>
    `;
    const result = detectWafFromContent(html);

    expect(result.detected).toBe(true);
    expect(result.provider).toBe("imperva");
  });

  it("detects PerimeterX captcha", () => {
    const html = `
      <html>
        <body>
          <div id="px-captcha">Please verify you are human</div>
        </body>
      </html>
    `;
    const result = detectWafFromContent(html);

    expect(result.detected).toBe(true);
    expect(result.provider).toBe("perimeterx");
  });

  it("returns not detected for normal HTML", () => {
    const html = `
      <html>
        <head><title>My Website</title></head>
        <body>
          <h1>Welcome</h1>
          <p>This is a normal page.</p>
        </body>
      </html>
    `;
    const result = detectWafFromContent(html);

    expect(result.detected).toBe(false);
  });

  it("handles empty content", () => {
    const result = detectWafFromContent("");
    expect(result.detected).toBe(false);
  });

  it("only checks first 10KB of content", () => {
    // Create content with WAF indicator after 10KB
    const padding = "x".repeat(11000);
    const html = padding + "Cloudflare Ray ID: abc123";
    const result = detectWafFromContent(html);

    expect(result.detected).toBe(false); // Should not detect because it's after 10KB
  });
});

describe("detectWaf", () => {
  it("returns header result if high confidence", () => {
    const headers = new Headers({ "cf-ray": "abc123" });
    const result = detectWaf(headers);

    expect(result.detected).toBe(true);
    expect(result.provider).toBe("cloudflare");
  });

  it("checks body if headers have low/medium confidence", () => {
    const headers = new Headers({ "x-amzn-requestid": "abc" }); // medium confidence
    const body = "<html><body>Cloudflare Ray ID: xyz</body></html>";
    const result = detectWaf(headers, body);

    // Should prefer cloudflare from body (high confidence) over aws-waf
    expect(result.detected).toBe(true);
    expect(result.provider).toBe("cloudflare");
  });

  it("merges indicators from headers and body", () => {
    const headers = new Headers({ "x-amzn-requestid": "abc" });
    const body = "Cloudflare Ray ID: xyz";
    const result = detectWaf(headers, body);

    expect(result.indicators.length).toBeGreaterThanOrEqual(2);
  });

  it("returns not detected if neither headers nor body match", () => {
    const headers = new Headers({ server: "nginx" });
    const body = "<html><body>Normal page</body></html>";
    const result = detectWaf(headers, body);

    expect(result.detected).toBe(false);
  });
});

describe("isLikelyWafBlock", () => {
  it("returns true for 403 with WAF headers", () => {
    const headers = new Headers({ "cf-ray": "abc123" });
    const result = isLikelyWafBlock(403, headers);

    expect(result).toBe(true);
  });

  it("returns true for 403 with WAF body", () => {
    const headers = new Headers();
    const body = "Cloudflare Ray ID: abc123";
    const result = isLikelyWafBlock(403, headers, body);

    expect(result).toBe(true);
  });

  it("returns false for 403 without WAF indicators", () => {
    const headers = new Headers({ server: "nginx" });
    const body = "<html><body>Forbidden</body></html>";
    const result = isLikelyWafBlock(403, headers, body);

    expect(result).toBe(false);
  });

  it("returns false for non-403 status codes", () => {
    const headers = new Headers({ "cf-ray": "abc123" });
    const result = isLikelyWafBlock(404, headers);

    expect(result).toBe(false);
  });

  it("returns false for 200 even with WAF headers", () => {
    const headers = new Headers({ "cf-ray": "abc123" });
    const result = isLikelyWafBlock(200, headers);

    expect(result).toBe(false);
  });
});

describe("getWafProviderName", () => {
  it("returns human-readable names", () => {
    expect(getWafProviderName("cloudflare")).toBe("Cloudflare");
    expect(getWafProviderName("akamai")).toBe("Akamai");
    expect(getWafProviderName("aws-waf")).toBe("AWS WAF");
    expect(getWafProviderName("sucuri")).toBe("Sucuri");
    expect(getWafProviderName("imperva")).toBe("Imperva/Incapsula");
    expect(getWafProviderName("datadome")).toBe("DataDome");
    expect(getWafProviderName("perimeterx")).toBe("PerimeterX");
    expect(getWafProviderName("kasada")).toBe("Kasada");
    expect(getWafProviderName("unknown")).toBe("Unknown WAF");
  });
});
