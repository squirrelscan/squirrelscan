// Cloudflare's email obfuscation (pub#811). With "Email Address Obfuscation"
// on, Cloudflare rewrites every `mailto:` link to
// `/cdn-cgi/l/email-protection#<hex>` and every address in the text to
// `<a href="/cdn-cgi/l/email-protection" data-cfemail="<hex>">`, and a script
// puts the address back in the browser. The URL is not a page: requested, it
// answers an error status. Pure (no I/O, no node built-ins).

const EMAIL_PROTECTION_PATH = "/cdn-cgi/l/email-protection";

/** True when `url` (absolute, or relative to any base) is a Cloudflare email-protection link, on any host. */
export function isCloudflareEmailProtectionUrl(url: string): boolean {
  if (!url) return false;
  let pathname: string;
  try {
    pathname = new URL(url, "http://base.invalid").pathname.toLowerCase();
  } catch {
    return false;
  }
  return pathname === EMAIL_PROTECTION_PATH || pathname === `${EMAIL_PROTECTION_PATH}/`;
}

/**
 * The text a Cloudflare email-protection payload (the link's `#<hex>`, or a
 * `data-cfemail` value) stands for, decoded the way Cloudflare's script does
 * it: the first byte is a key each following byte is XORed with, and the
 * result is UTF-8. Null for a payload that is not well-formed hex, does not
 * decode as UTF-8, or decodes to a control character.
 */
export function decodeCloudflareEmail(hex: string): string | null {
  if (hex.length < 4 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const key = Number.parseInt(hex.slice(0, 2), 16);
  const bytes = new Uint8Array(hex.length / 2 - 1);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16) ^ key;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  // oxlint-disable-next-line no-control-regex -- rejecting control characters is the point
  return /[\u0000-\u001f\u007f]/.test(text) ? null : text;
}
