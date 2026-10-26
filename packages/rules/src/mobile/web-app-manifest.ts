// mobile/web-app-manifest - the web app manifest the pages link (#710)
//
// The manifest sets the home-screen icon and name, the splash screen and the
// browser chrome colour when a visitor installs or pins the site. Nothing
// breaks visibly on a desktop browser when it rots, which is why it is checked
// here: a redesign renames the icons, a deploy drops the file, or a starter
// ships a manifest that still says "My App".
//
// The engine fetches each linked same-site manifest ONCE (however many pages
// link it), reads the icons it declares, and hands both to this rule as
// `ctx.site.webAppManifests`. The rule itself sends nothing. Relative
// `start_url`, `scope` and icon `src` values resolve against the MANIFEST URL,
// not the page, so every resolution below goes through `resolveUrl(..., manifestUrl)`.
//
// One check per manifest URL, whatever the number of pages linking it. Its
// status is the worst problem found; each problem is an item. A manifest that
// does not load or parse is a single error, because nothing inside it can be
// judged.

import type { CheckItem, CheckResult, CheckStatus } from "@squirrelscan/core-contracts";
import { ASSET_FETCH_REFUSED_ERROR } from "@squirrelscan/utils/constants";

import { notCheckedCheck } from "../ax/discovery-probe-state";
import type { Rule, RuleContext, RuleResult, WebAppManifestData } from "../types";

const CHECK_NAME = "web-app-manifest";

/** Content types browsers accept for a manifest. Anything else only warns. */
const MANIFEST_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "application/manifest+json",
  "application/json",
]);

/** Icons read per manifest. A manifest declares a handful; this bounds a hostile one. */
export const WEB_APP_MANIFEST_ICON_LIMIT = 20;

/**
 * Icon entries scanned per manifest for the declared-size and maskable checks.
 * Far above any real manifest, and it bounds the work a hostile array of a
 * million entries could cost.
 */
const ICON_SCAN_LIMIT = 200;

/** Longest `sizes` value parsed; real ones are a few tokens. */
const MAX_SIZES_LENGTH = 256;

/** Pages listed by name before the rest are counted. */
const PAGES_NAMED = 5;

/**
 * Longest site-controlled string quoted in a message: manifest text, a header
 * value, a URL. The full value stays in `value` or the item id.
 */
const MAX_QUOTED = 120;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function clip(value: string): string {
  return value.length > MAX_QUOTED ? `${value.slice(0, MAX_QUOTED)}...` : value;
}

/** `#rgb` or `#rrggbb` (with optional alpha): the forms compared exactly. */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

interface ManifestIcon {
  url: string;
  sizes: Array<[number, number]>;
  type: string | null;
  purposes: string[];
}

/** Parse a manifest body. Null for anything that is not a JSON object. */
export function parseWebAppManifest(content: string | null): Record<string, unknown> | null {
  if (content === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** An absolute URL for `href` against `base`, or null when it does not parse. */
function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** `"48x48 96x96"` to `[[48, 48], [96, 96]]`. `"any"` and junk are dropped. */
function parseSizes(value: unknown): Array<[number, number]> {
  if (typeof value !== "string") return [];
  const out: Array<[number, number]> = [];
  for (const token of value.slice(0, MAX_SIZES_LENGTH).trim().split(/\s+/)) {
    const match = /^(\d+)x(\d+)$/i.exec(token);
    if (match) out.push([Number(match[1]), Number(match[2])]);
  }
  return out;
}

function readIcons(manifest: Record<string, unknown>, manifestUrl: string): ManifestIcon[] {
  if (!Array.isArray(manifest.icons)) return [];
  const icons: ManifestIcon[] = [];
  for (const entry of manifest.icons.slice(0, ICON_SCAN_LIMIT)) {
    if (entry === null || typeof entry !== "object") continue;
    const icon = entry as Record<string, unknown>;
    const src = nonEmptyString(icon.src);
    const url = src === null ? null : resolveUrl(src, manifestUrl);
    if (url === null) continue;
    icons.push({
      url,
      sizes: parseSizes(icon.sizes),
      type: nonEmptyString(icon.type)?.toLowerCase() ?? null,
      purposes: (nonEmptyString(icon.purpose) ?? "").toLowerCase().split(/\s+/).filter(Boolean),
    });
  }
  return icons;
}

/** A PNG icon: declared `image/png`, or undeclared with a `.png` path. */
function isPngIcon(icon: ManifestIcon): boolean {
  if (icon.type !== null) return icon.type === "image/png";
  try {
    return new URL(icon.url).pathname.toLowerCase().endsWith(".png");
  } catch {
    return false;
  }
}

/**
 * The absolute icon URLs a manifest declares, in order and deduped, capped at
 * WEB_APP_MANIFEST_ICON_LIMIT. The engine fetches these to read their sizes;
 * the rule reads the same list, so the two never disagree on an icon's URL.
 */
export function listWebAppManifestIconUrls(content: string | null, manifestUrl: string): string[] {
  const manifest = parseWebAppManifest(content);
  if (!manifest) return [];
  const urls = [...new Set(readIcons(manifest, manifestUrl).map((icon) => icon.url))];
  return urls.slice(0, WEB_APP_MANIFEST_ICON_LIMIT);
}

/** Lowercase, and `#abc` expanded to `#aabbcc`, so equal colours compare equal. */
function normalizeColor(value: string): string {
  const v = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : v;
}

function mediaType(contentType: string | null): string | null {
  if (contentType === null) return null;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "" ? null : type;
}

function describePages(pages: string[]): string {
  if (pages.length === 0) return "no page";
  const named = pages.slice(0, PAGES_NAMED).join(", ");
  return pages.length > PAGES_NAMED ? `${named} and ${pages.length - PAGES_NAMED} more` : named;
}

interface Problem {
  id: string;
  status: CheckStatus;
  message: string;
  pages?: string[];
}

const STATUS_RANK: Record<string, number> = { pass: 0, skipped: 0, info: 1, warn: 2, fail: 3 };

function worstStatus(problems: Problem[]): CheckStatus {
  let worst: CheckStatus = "pass";
  for (const problem of problems) {
    if ((STATUS_RANK[problem.status] ?? 0) > (STATUS_RANK[worst] ?? 0)) worst = problem.status;
  }
  return worst;
}

function checkManifest(manifest: WebAppManifestData): CheckResult {
  const pages = manifest.sourcePages;
  const linked = describePages(pages);
  const url = clip(manifest.url);

  if (manifest.content === null) {
    // Throttled or answered by a WAF: the status says nothing about the file.
    const withheld = manifest.headersWithheld === true;
    const unverifiable = manifest.rateLimited === true || manifest.wafBlocked === true || withheld;
    if (!unverifiable && manifest.status !== null && manifest.status >= 400) {
      return {
        name: CHECK_NAME,
        status: "fail",
        message: `Linked web app manifest ${url} answers HTTP ${manifest.status} (linked from ${linked})`,
        value: manifest.url,
        pages,
      };
    }
    const reason = unverifiable
      ? withheld
        ? `${hostOf(manifest.url)} answered HTTP ${manifest.status} to a request without the custom headers; name it in header_hosts or --header-host to send them`
        : `HTTP ${manifest.status} was ${manifest.rateLimited ? "a rate limit" : "a WAF or bot challenge"}, not the file`
      : manifest.error === ASSET_FETCH_REFUSED_ERROR
        ? "it redirects off the site, which is not followed"
        : clip(manifest.error ?? "no response");
    return {
      name: CHECK_NAME,
      status: "info",
      message: `Web app manifest ${url} not checked: ${reason} (linked from ${linked})`,
      value: manifest.url,
      pages,
    };
  }

  const parsed = parseWebAppManifest(manifest.content);
  if (parsed === null) {
    return {
      name: CHECK_NAME,
      status: "fail",
      message: `Linked web app manifest ${url} is not a valid JSON object (linked from ${linked})`,
      value: manifest.url,
      pages,
    };
  }

  const problems: Problem[] = [];

  const type = mediaType(manifest.contentType);
  if (type === null || !MANIFEST_CONTENT_TYPES.has(type)) {
    problems.push({
      id: "content-type",
      status: "warn",
      message:
        type === null
          ? "served without a Content-Type; browsers expect application/manifest+json"
          : `served as ${clip(type)}; browsers expect application/manifest+json`,
    });
  }

  if (nonEmptyString(parsed.name) === null && nonEmptyString(parsed.short_name) === null) {
    problems.push({ id: "name", status: "warn", message: 'missing both "name" and "short_name"' });
  }

  const startUrl = nonEmptyString(parsed.start_url);
  if (startUrl === null) {
    problems.push({ id: "start_url", status: "warn", message: 'missing "start_url"' });
  } else {
    const resolved = resolveUrl(startUrl, manifest.url);
    if (resolved === null) {
      problems.push({
        id: "start_url",
        status: "warn",
        message: `"start_url" ${clip(startUrl)} is not a valid URL`,
      });
    } else if (new URL(resolved).origin !== new URL(manifest.url).origin) {
      problems.push({
        id: "start_url",
        status: "warn",
        message: `"start_url" resolves to ${clip(new URL(resolved).origin)}, another origin from the manifest (${clip(new URL(manifest.url).origin)})`,
      });
    }
  }

  if (nonEmptyString(parsed.display) === null) {
    problems.push({ id: "display", status: "warn", message: 'missing "display"' });
  }

  const icons = readIcons(parsed, manifest.url);
  const pngSizes = new Set<string>();
  for (const icon of icons) {
    if (!isPngIcon(icon)) continue;
    for (const [w, h] of icon.sizes) pngSizes.add(`${w}x${h}`);
  }
  if (!pngSizes.has("192x192")) {
    problems.push({ id: "icon-192", status: "warn", message: "no 192x192 PNG icon declared" });
  }
  if (!pngSizes.has("512x512")) {
    problems.push({ id: "icon-512", status: "warn", message: "no 512x512 PNG icon declared" });
  }

  const checked = new Map(manifest.icons.map((check) => [check.url, check]));
  const manifestOrigin = new URL(manifest.url).origin;
  let offOrigin = 0;
  let pastCap = 0;
  for (const icon of icons) {
    const check = checked.get(icon.url);
    if (!check) {
      // A `data:` icon needs no request, so it is not "not checked".
      if (!/^https?:/i.test(icon.url)) continue;
      if (new URL(icon.url).origin !== manifestOrigin) offOrigin++;
      else pastCap++;
      continue;
    }
    // A throttled or WAF-challenged icon request says nothing about the icon.
    if (check.rateLimited === true || check.wafBlocked === true || check.headersWithheld === true) {
      problems.push({
        id: "icon-unverified",
        status: "info",
        message: `icon ${clip(icon.url)} not checked: ${
          check.headersWithheld === true
            ? `${hostOf(icon.url)} answered HTTP ${check.status} to a request without the custom headers; name it in header_hosts or --header-host to send them`
            : `HTTP ${check.status} was ${check.rateLimited ? "a rate limit" : "a WAF or bot challenge"}`
        }`,
      });
      continue;
    }
    if (check.error === ASSET_FETCH_REFUSED_ERROR) {
      problems.push({
        id: "icon-unverified",
        status: "info",
        message: `icon ${clip(icon.url)} not checked: it redirects off the site, which is not followed`,
      });
      continue;
    }
    if (check.status !== null && check.status >= 400) {
      problems.push({
        id: "icon-status",
        status: "warn",
        message: `icon ${clip(icon.url)} answers HTTP ${check.status}`,
      });
      continue;
    }
    if (check.naturalWidth === null || check.naturalHeight === null || icon.sizes.length === 0)
      continue;
    const real = `${check.naturalWidth}x${check.naturalHeight}`;
    const declared = icon.sizes.map(([w, h]) => `${w}x${h}`);
    if (!declared.includes(real)) {
      problems.push({
        id: "icon-size",
        status: "warn",
        message: `icon ${clip(icon.url)} is declared ${clip(declared.join(" "))} but is ${real}`,
      });
    }
  }

  if (offOrigin > 0) {
    problems.push({
      id: "icon-off-origin",
      status: "info",
      message: `${offOrigin} icon(s) on another origin not checked`,
    });
  }
  if (pastCap > 0) {
    problems.push({
      id: "icon-cap",
      status: "info",
      message: `${pastCap} icon(s) past the first ${WEB_APP_MANIFEST_ICON_LIMIT} not checked`,
    });
  }

  if (icons.length > 0 && !icons.some((icon) => icon.purposes.includes("maskable"))) {
    problems.push({
      id: "maskable",
      status: "info",
      message: 'no icon with purpose "maskable"; Android crops the others into a circle',
    });
  }

  // Compared only when both sides are hex: `rgb()`, `hsl()` and named colours
  // can be equal in other spellings, so a string compare would warn falsely.
  const themeColor = nonEmptyString(parsed.theme_color);
  if (themeColor !== null && HEX_COLOR.test(themeColor)) {
    const wanted = normalizeColor(themeColor);
    const mismatched = pages.filter((page) => {
      const metas = (manifest.themeColorsByPage[page] ?? []).filter((meta) =>
        HEX_COLOR.test(meta.content.trim()),
      );
      return metas.length > 0 && !metas.some((meta) => normalizeColor(meta.content) === wanted);
    });
    if (mismatched.length > 0) {
      problems.push({
        id: "theme-color",
        status: "warn",
        message: `theme-color on ${mismatched.length} page(s) differs from the manifest theme_color ${clip(themeColor)}`,
        pages: mismatched,
      });
    }
  }

  if (problems.length === 0) {
    return {
      name: CHECK_NAME,
      status: "pass",
      message: `Web app manifest ${url} is valid (linked from ${linked})`,
      value: manifest.url,
      pages,
    };
  }

  const items: CheckItem[] = problems.map((problem) => ({
    id: problem.id,
    label: problem.message,
    ...(problem.pages ? { sourcePages: problem.pages } : {}),
    meta: { status: problem.status },
  }));
  return {
    name: CHECK_NAME,
    status: worstStatus(problems),
    message: `Web app manifest ${url} has ${problems.length} issue(s) (linked from ${linked})`,
    value: manifest.url,
    pages,
    items,
  };
}

export const webAppManifestRule: Rule = {
  meta: {
    id: "mobile/web-app-manifest",
    name: "Web App Manifest",
    description:
      "Checks the web app manifest the pages link: that it loads and parses, its name, start_url and display, its 192px and 512px PNG icons, and that its theme_color matches the pages' theme-color",
    solution:
      "The web app manifest (usually site.webmanifest) sets the name, icons, splash colours and start page used when someone adds the site to their home screen. Serve it as application/manifest+json, give it a name, a start_url and a display mode, and declare 192x192 and 512x512 PNG icons. Add a maskable icon so Android can crop it to the launcher shape without clipping. Keep the manifest's theme_color equal to the theme-color meta on your pages. A site that links no manifest gets advice only, and that does not affect the score.",
    category: "mobile",
    scope: "site",
    // A manifest that 404s or is not JSON fails; the report reads a failed check
    // at the rule's severity, so that is an error. Warn-only results stay warnings.
    severity: "error",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const manifests = ctx.site?.webAppManifests;
    if (manifests === undefined) {
      return { checks: [notCheckedCheck(CHECK_NAME, "Web app manifest", undefined, "no-result")] };
    }
    if (manifests.length === 0) {
      return {
        checks: [
          {
            name: "web-app-manifest-linked",
            status: "info",
            message:
              "No page links a web app manifest; add one to control the home-screen icon and name",
            value: "absent",
          },
        ],
      };
    }
    const sorted = [...manifests].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    const checks = sorted.map(checkManifest);
    const dropped = ctx.site?.webAppManifestsDropped ?? 0;
    if (dropped > 0) {
      checks.push({
        name: "web-app-manifest-unchecked",
        status: "info",
        message: `${dropped} more linked web app manifest(s) not checked: the first ${manifests.length} were`,
        value: dropped,
      });
    }
    return { checks };
  },
};
