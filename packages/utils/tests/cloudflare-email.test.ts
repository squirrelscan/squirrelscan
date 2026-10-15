// pub#811: Cloudflare's email obfuscation rewrites `mailto:` links to
// `/cdn-cgi/l/email-protection#<hex>`, which is not a page.

import { describe, expect, test } from "bun:test";

import { decodeCloudflareEmail, isCloudflareEmailProtectionUrl } from "../src/cloudflare-email";

/** Cloudflare's encoding: a key byte, then each UTF-8 byte XOR the key, all hex. */
function encode(text: string, key = 0x5a): string {
  const bytes = [key, ...new TextEncoder().encode(text).map((b) => b ^ key)];
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("isCloudflareEmailProtectionUrl", () => {
  test("the email-protection path, relative or absolute, any host, with or without a hash", () => {
    expect(isCloudflareEmailProtectionUrl("/cdn-cgi/l/email-protection#abcd")).toBe(true);
    expect(isCloudflareEmailProtectionUrl("/cdn-cgi/l/email-protection")).toBe(true);
    expect(isCloudflareEmailProtectionUrl("https://example.com/cdn-cgi/l/email-protection#a1b2")).toBe(
      true,
    );
    expect(isCloudflareEmailProtectionUrl("https://other.example/CDN-CGI/L/Email-Protection")).toBe(
      true,
    );
  });

  test("anything else under /cdn-cgi/ is not: image resizing URLs are real resources", () => {
    expect(isCloudflareEmailProtectionUrl("/cdn-cgi/image/width=1200/photo.jpg")).toBe(false);
    expect(isCloudflareEmailProtectionUrl("/cdn-cgi/l/email-protection-guide")).toBe(false);
    expect(isCloudflareEmailProtectionUrl("/blog/cdn-cgi/l/email-protection")).toBe(false);
    expect(isCloudflareEmailProtectionUrl("mailto:hi@example.com")).toBe(false);
    expect(isCloudflareEmailProtectionUrl("")).toBe(false);
  });
});

describe("decodeCloudflareEmail", () => {
  test("decodes the hex payload Cloudflare's script would", () => {
    expect(decodeCloudflareEmail(encode("hi@example.com"))).toBe("hi@example.com");
    expect(decodeCloudflareEmail(encode("hi@example.com", 0xd3).toUpperCase())).toBe("hi@example.com");
    expect(decodeCloudflareEmail(encode("josé@exämple.com"))).toBe("josé@exämple.com");
  });

  test("null for anything that is not a well-formed payload", () => {
    expect(decodeCloudflareEmail("")).toBeNull();
    expect(decodeCloudflareEmail("5a")).toBeNull();
    expect(decodeCloudflareEmail("abc")).toBeNull();
    expect(decodeCloudflareEmail("zz11")).toBeNull();
    // Decodes to bytes that are not UTF-8.
    expect(decodeCloudflareEmail("00ff")).toBeNull();
    // Decodes to a control character.
    expect(decodeCloudflareEmail("0001")).toBeNull();
  });
});
