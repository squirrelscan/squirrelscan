// Unsampled link target sets for a published report (squirrelscan/repo#2861).
//
// A published report is a sample: a link rule's failing row keeps a few of its
// broken targets beside their count. Broken link alerts have to tell a target
// that broke since the previous audit from one that was already broken, and a
// sample cannot say a target was NOT broken then. So the publish capper also
// carries, per link rule, the set of every target the rule reported broken and
// every one it could not verify, as hashes: a few bytes each, kept whole at
// every tier.
//
// One function hashes for both sides, so a reader (the cloud alert) tests a
// target it reads off one report against the set another report carries:
// `linkTargetHash`, over the target query-blind (`normalizeUrl`: scheme and
// host lowercased, no query, no fragment, no trailing slash). Query-blind on
// purpose: a link that only changed its tracking parameters (`?utm_source=`)
// is the same link, and two links that differ by a real query read as one,
// which can only make a target read as listed. That, and a hash collision, is
// a missed alert, never a false one. FNV-1a is not collision-resistant against
// a site that crafts its own URLs to collide: the worst such a site can do is
// hold back an alert about its own broken links.
//
// Pure and dependency-free beyond the url helpers: runs in the CLI, the cloud
// container and the API Worker alike.

import type { LinkTargetSet } from "@squirrelscan/core-contracts";
import { normalizeUrl } from "./url";

/** At most this many hashes per set (8 bytes each, about 11 base64 characters). */
export const LINK_TARGET_SET_MAX_HASHES = 2000;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;
const HASH_BYTES = 8;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const UTF8 = new TextEncoder();

/** 64-bit FNV-1a over the UTF-8 bytes of `text`, as 16 hex digits. */
function fnv1a64(text: string): string {
  let h = FNV_OFFSET;
  for (const byte of UTF8.encode(text)) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}

/** A target's hash: 16 hex digits over the target, query-blind. */
export function linkTargetHash(url: string): string {
  return fnv1a64(normalizeUrl(url));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!BASE64URL.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * The set of `urls`, hashed, de-duplicated and sorted (so the same targets give
 * the same bytes). `count` is how many distinct targets there were; `complete`
 * is false when the hashes leave some out (over `maxHashes`, the lowest hashes
 * kept) or the caller says its list was already partial. A reader can say a
 * target is NOT in the set only when it is complete.
 */
export function encodeLinkTargetSet(
  urls: Iterable<string>,
  options: { partial?: boolean; maxHashes?: number } = {},
): LinkTargetSet {
  const max = options.maxHashes ?? LINK_TARGET_SET_MAX_HASHES;
  const hashes = [...new Set([...urls].map(linkTargetHash))].sort();
  const kept = hashes.slice(0, max);
  const bytes = new Uint8Array(kept.length * HASH_BYTES);
  kept.forEach((hex, i) => {
    for (let b = 0; b < HASH_BYTES; b++) {
      bytes[i * HASH_BYTES + b] = Number.parseInt(hex.slice(b * 2, b * 2 + 2), 16);
    }
  });
  return {
    hashes: toBase64Url(bytes),
    count: hashes.length,
    complete: !options.partial && kept.length === hashes.length,
  };
}

/**
 * The hashes a set carries, as `linkTargetHash` spells them, or null for a
 * value that is not a well-formed set (a reader then treats the set as absent).
 */
export function decodeLinkTargetSet(value: unknown): ReadonlySet<string> | null {
  if (!value || typeof value !== "object") return null;
  const hashes = (value as { hashes?: unknown }).hashes;
  if (typeof hashes !== "string") return null;
  const bytes = fromBase64Url(hashes);
  if (!bytes || bytes.length % HASH_BYTES !== 0) return null;
  const out = new Set<string>();
  for (let i = 0; i < bytes.length; i += HASH_BYTES) {
    let hex = "";
    for (let b = 0; b < HASH_BYTES; b++) hex += bytes[i + b]!.toString(16).padStart(2, "0");
    out.add(hex);
  }
  return out;
}
