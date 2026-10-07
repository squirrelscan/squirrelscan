// content/placeholder-media - Images that were never replaced with real content.
//
// Two signals that nothing else audits: an image whose SOURCE is a placeholder
// (a placeholder service, a "placeholder" filename, or a 1x1 data URI standing in
// for content) and an alt that is a camera-default name. The plain junk-alt words
// ("image", "photo", ...) and an alt equal to the filename are deliberately left
// to a11y/image-redundant-alt, which already flags them: reporting them here too
// would ding a page twice for one root cause.

import type { CheckItem } from "@squirrelscan/core-contracts";
import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export type PlaceholderMediaKind = "placeholder-source" | "blank-pixel" | "camera-alt";

export interface PlaceholderMediaFinding {
  kind: PlaceholderMediaKind;
  /** What the reader should look for: the offending URL or alt text. */
  sample: string;
}

const MAX_ITEMS = 10;
const MAX_SAMPLE_CHARS = 80;

const truncate = (s: string): string =>
  s.length <= MAX_SAMPLE_CHARS ? s : `${s.slice(0, MAX_SAMPLE_CHARS - 1)}…`;

/** Hosts whose whole purpose is serving stand-in images. */
const PLACEHOLDER_HOSTS = /(^|\.)(via\.placeholder\.com|placehold\.it|placehold\.co|dummyimage\.com|lorempixel\.com)$/i;

/** `source.unsplash.com/random` and the `/featured/?keyword` endpoints return a random photo. */
const isRandomUnsplash = (host: string, path: string): boolean =>
  host === "source.unsplash.com" && (/^\/(random|featured)(\/|$)/i.test(path) || path.startsWith("/?"));

/** Attributes that carry the real image when `src` is only a lazy-load stub. */
const LAZY_ATTRS = ["data-src", "data-lazy-src", "data-original", "data-srcset", "data-lazy-srcset"];

/** `DSC_0001`, `IMG_1234`, `DSCN0042`, `DCIM0001`, `P1000123`, optionally with an extension. */
const CAMERA_ALT = /^(?:dsc[nf]?|img|dcim|pict|mvc)[-_ ]?\d{3,}(?:\.(?:jpe?g|png|gif|webp|heic))?$/i;

/** "placeholder" as a whole word of a filename: `placeholder.png`, `hero-placeholder_2x.jpg`. */
const PLACEHOLDER_FILE = /(^|[-_.\s])placeholder([-_.\s]|$)/i;

const basename = (path: string): string => path.split("/").pop() ?? "";

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw, "https://placeholder.invalid/");
  } catch {
    return null;
  }
}

/** First URL of a srcset value. */
const firstSrcsetUrl = (srcset: string): string => srcset.trim().split(/\s*,\s*/)[0]?.split(/\s+/)[0] ?? "";

/** True when the URL points at a placeholder service or has "placeholder" in its path or filename. */
export function isPlaceholderSource(raw: string): boolean {
  const value = raw.trim();
  if (!value || value.startsWith("data:")) return false;
  const url = parseUrl(value);
  if (!url) return PLACEHOLDER_FILE.test(basename(value.split(/[?#]/)[0] ?? ""));
  const host = url.hostname.toLowerCase();
  if (PLACEHOLDER_HOSTS.test(host)) return true;
  if (isRandomUnsplash(host, url.pathname + url.search)) return true;
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path
  }
  // Only the filename counts: "/blog/placeholder-text-guide/hero.jpg" is a real photo.
  return PLACEHOLDER_FILE.test(basename(path));
}

/** Pixel size of a base64 GIF or PNG data URI, or null when it is neither or too short to say. */
export function dataUriDimensions(raw: string): { width: number; height: number } | null {
  const m = /^data:image\/(gif|png);base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw.trim());
  if (!m) return null;
  // The header is in the first 24 bytes, which is 32 base64 characters.
  const head = m[2]!.replace(/\s+/g, "").slice(0, 32);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(head.slice(0, head.length - (head.length % 4))), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (m[1]!.toLowerCase() === "gif") {
    if (bytes.length < 10) return null;
    return { width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8) };
  }
  if (bytes.length < 24) return null;
  const be = (o: number) => ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!) >>> 0;
  return { width: be(16), height: be(20) };
}

const isOnePixel = (raw: string): boolean => {
  const d = dataUriDimensions(raw);
  return d !== null && d.width === 1 && d.height === 1;
};

/** A spacer or tracking image says so: hidden, presentational, or sized to a pixel. */
function isMarkedDecorative(img: Element): boolean {
  if (img.getAttribute("aria-hidden") === "true" || img.hasAttribute("hidden")) return true;
  const role = img.getAttribute("role");
  if (role === "presentation" || role === "none") return true;
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(img.getAttribute("style") ?? "")) return true;
  const w = img.getAttribute("width");
  const h = img.getAttribute("height");
  return (w !== null && Number.parseInt(w, 10) <= 1) || (h !== null && Number.parseInt(h, 10) <= 1);
}

/** Findings for one <img>. Exported for tests. */
export function findInImage(img: Element): PlaceholderMediaFinding[] {
  const found: PlaceholderMediaFinding[] = [];
  const src = img.getAttribute("src") ?? "";
  const srcset = firstSrcsetUrl(img.getAttribute("srcset") ?? "");

  // A real lazy source makes `src` a stub by design, so the stub is never judged.
  const lazy = LAZY_ATTRS.map((a) => img.getAttribute(a)?.trim() ?? "")
    .map((v) => (v.includes(",") || /\s\d+(\.\d+)?[wx]$/.test(v) ? firstSrcsetUrl(v) : v))
    .find((v) => v !== "" && !v.startsWith("data:"));
  // Where the browser actually looks when it has a srcset or <picture>: those win over `src`,
  // so a stub `src` beside a real srcset is not a placeholder.
  const pictureSources = img.parentElement?.tagName.toLowerCase() === "picture"
    ? Array.from(img.parentElement.querySelectorAll("source"))
        .map((el) => firstSrcsetUrl(el.getAttribute("srcset") ?? ""))
        .filter(Boolean)
    : [];
  const alternates = [srcset, ...pictureSources].filter(Boolean);
  let bad: string | undefined;
  if (lazy) bad = isPlaceholderSource(lazy) ? lazy : undefined;
  else if (alternates.length > 0) bad = alternates.every(isPlaceholderSource) ? alternates[0] : undefined;
  else bad = isPlaceholderSource(src) ? src : undefined;
  if (bad) {
    found.push({ kind: "placeholder-source", sample: bad });
  } else if (!lazy && !srcset && isOnePixel(src) && !isMarkedDecorative(img)) {
    found.push({ kind: "blank-pixel", sample: "1x1 inline image" });
  }

  const alt = (img.getAttribute("alt") ?? "").trim();
  if (alt && CAMERA_ALT.test(alt)) {
    // An alt equal to the filename is image-redundant-alt's finding.
    const file = ((lazy || src).split("?")[0] ?? "").split("/").pop() ?? "";
    const norm = (s: string) => s.toLowerCase().replace(/\.[^.]+$/, "").replace(/[-_\s]+/g, "");
    if (!file || norm(file) !== norm(alt)) found.push({ kind: "camera-alt", sample: alt });
  }
  return found;
}

const KIND_LABELS: Record<PlaceholderMediaKind, string> = {
  "placeholder-source": "placeholder image",
  "blank-pixel": "blank 1x1 image used as content",
  "camera-alt": "camera-default alt text",
};

/** Source findings are certain; an alt that is a camera name is only a draft smell. */
const CERTAIN_KINDS = new Set<PlaceholderMediaKind>(["placeholder-source", "blank-pixel"]);

export const placeholderMediaRule: Rule = {
  meta: {
    id: "content/placeholder-media",
    name: "Placeholder Media",
    description: "Detects placeholder images and camera-default alt text that shipped to production",
    solution:
      "A placeholder image means the page was published before its real media was. Replace the image source with the real asset, and add the image field to whatever check gates publishing. A 1x1 inline image used as content is a stand-in that was never swapped: replace it, or if it is only a lazy-load stub, put the real URL in data-src. A camera-default alt such as DSC_0001 or IMG_1234 means the file was uploaded without being described: write alt text that says what the image shows, or use alt=\"\" when it is purely decorative. A deliberate 1x1 spacer or tracking pixel is exempt when it carries alt=\"\" with role=\"presentation\" (or aria-hidden=\"true\"). Plain junk alt like \"image\" or \"photo\" and alt text that repeats the filename are reported by a11y/image-redundant-alt.",
    category: "content",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
    skipOnSoft404: true,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) {
      checks.push({
        name: "placeholder-media",
        status: "skipped",
        message: "No document available",
        skipReason: "Parse error",
      });
      return { checks };
    }

    const images = querySelectorAllOutsideNoscript(doc, "img");
    if (images.length === 0) {
      checks.push({
        name: "placeholder-media",
        status: "skipped",
        message: "No images on the page",
        skipReason: "no-images",
      });
      return { checks };
    }

    const seen = new Set<string>();
    const findings: PlaceholderMediaFinding[] = [];
    for (const img of images) {
      for (const f of findInImage(img)) {
        const key = `${f.kind}|${f.sample}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(f);
      }
    }

    if (findings.length === 0) {
      checks.push({
        name: "placeholder-media",
        status: "pass",
        message: "No placeholder images or camera-default alt text found",
        details: { imagesChecked: images.length },
      });
      return { checks };
    }

    const items: CheckItem[] = findings.slice(0, MAX_ITEMS).map((f) => ({
      id: `${f.kind}:${f.sample}`,
      label: KIND_LABELS[f.kind],
      snippet: truncate(f.sample),
    }));
    const certain = findings.some((f) => CERTAIN_KINDS.has(f.kind));
    const kinds = [...new Set(findings.map((f) => KIND_LABELS[f.kind]))];
    checks.push({
      name: "placeholder-media",
      status: certain ? "fail" : "warn",
      message: `${findings.length} placeholder media finding(s): ${kinds.join(", ")} (${truncate(findings[0]!.sample)})`,
      value: findings.length,
      items,
      details: {
        imagesChecked: images.length,
        ...(findings.length > MAX_ITEMS ? { additional: findings.length - MAX_ITEMS } : {}),
      },
    });
    return { checks };
  },
};
