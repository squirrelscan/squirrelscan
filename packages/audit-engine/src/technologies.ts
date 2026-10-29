import {
  SERVICE_LIMITS,
  type ReportTechnologies,
  type ReportTechnology,
} from "@squirrelscan/core-contracts";
import {
  detectTechnologies,
  SEGMENT_SEPARATOR,
  sampleBundleExtras,
  type DetectedTechnology,
} from "@squirrelscan/tech-detect";
import { recordToHeaders } from "@squirrelscan/utils/headers";
import { byteLength, truncateToBytes } from "@squirrelscan/utils/bytes";
import { detectWaf, getWafProviderName } from "@squirrelscan/waf-detect";

/** Cross-scan diff returned by the cloud tech-detect gate (absent for local). */
export interface TechScanDiff {
  added: string[];
  removed: string[];
  firstScan: boolean;
  advisories?: ReportTechnologies["advisories"];
}

export function buildReportTechnologies(
  technologies: DetectedTechnology[],
  diff?: TechScanDiff,
): ReportTechnologies {
  return {
    items: technologies.map((technology) => ({
      ...technology,
      category: technology.category as ReportTechnology["category"],
    })),
    added: diff?.added ?? [],
    removed: diff?.removed ?? [],
    firstScan: diff?.firstScan ?? false,
    ...(diff?.advisories?.length ? { advisories: diff.advisories } : {}),
  };
}

export function withWafTech(
  technologies: DetectedTechnology[],
  headers: Record<string, string>,
  html: string,
): DetectedTechnology[] {
  const waf = detectWaf(recordToHeaders(headers), html);
  if (!waf.detected || !waf.provider) return technologies;
  const id = `waf-${waf.provider}`;
  if (technologies.some((technology) => technology.id === id)) return technologies;
  return [
    ...technologies,
    {
      id,
      name: getWafProviderName(waf.provider),
      category: "security",
      version: null,
      confidence: waf.confidence,
      detectedBy: "waf-detect",
    },
  ];
}

export interface LocalTechInput {
  url: string;
  headers: Record<string, string>;
  html: string;
  /** `<meta name>` → content; absent: parsed from the HTML. */
  meta?: Record<string, string>;
  /** Absent: script-url detectors scan the page HTML instead. */
  scripts?: { url: string; content?: string }[];
}

const TECH_CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 } as const;

export function detectReportTechnologiesMulti(
  pages: LocalTechInput[],
  diff?: TechScanDiff,
): ReportTechnologies {
  const byId = new Map<string, DetectedTechnology>();
  for (const page of pages) {
    for (const technology of detectTechnologies(page)) {
      const previous = byId.get(technology.id);
      const better =
        !previous ||
        (!previous.version && !!technology.version) ||
        (!!previous.version === !!technology.version &&
          TECH_CONFIDENCE_RANK[technology.confidence] > TECH_CONFIDENCE_RANK[previous.confidence]);
      if (better) byId.set(technology.id, technology);
    }
  }
  const home = pages[0];
  const technologies = home
    ? withWafTech([...byId.values()], home.headers, home.html)
    : [...byId.values()];
  return buildReportTechnologies(technologies, diff);
}

export function detectReportTechnologies(
  input: LocalTechInput,
  diff?: TechScanDiff,
): ReportTechnologies {
  return detectReportTechnologiesMulti([input], diff);
}

/** Every bundle gets at least this much head before any gets more (#1254). */
const TECH_BUNDLE_FLOOR_BYTES = 16 * 1024;
/** Most bytes of vendor-literal windows and tail added to a bundle that does not fit whole. */
const TECH_BUNDLE_EXTRAS_BYTES = 24 * 1024;

/** Bytes of first-party script bodies detection may read (#1254). */
export interface TechBundleLimits {
  /** Per bundle: only its first bytes are matched. 0 hands detection no bodies. */
  bundleBytes: number;
  /** Per page, over every bundle attached to it. */
  pageBytes: number;
  /** Per audit, over every bundle attached to any page. */
  auditBytes: number;
}

export const DEFAULT_TECH_BUNDLE_LIMITS: TechBundleLimits = {
  bundleBytes: SERVICE_LIMITS.techDetectBundleBytes,
  pageBytes: SERVICE_LIMITS.techDetectPageScriptBytes,
  auditBytes: SERVICE_LIMITS.techDetectAuditScriptBytes,
};

/** A script the crawl already fetched (for the secret rules); never refetched here. */
export interface TechFetchedScript {
  url: string;
  content?: string | null;
  /** Pages that reference it; absent or empty means the home page. */
  sourcePages?: readonly string[];
}

/** One crawled HTML page, home page first in the list handed to {@link buildTechInputs}. */
export interface TechPageSource {
  url: string;
  /** The URL as crawled, when `url` is the final (redirected) one. */
  requestedUrl?: string;
  headers: Record<string, string>;
  html: string;
  meta?: Record<string, string>;
}

/** Extract `<script src>` values from raw HTML (substring patterns match either). */
export function extractScriptSrcs(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/**
 * Tech-detect input for each page, with the first-party script bodies the crawl
 * already fetched attached as `scripts[].content` (#1254). One shared builder for
 * the local scan and the cloud payload, so both see the same bytes and agree.
 *
 * - The home page (index 0) lists every fetched script plus its own `<script src>`
 *   values, so script-url detectors see every origin; another page lists its own
 *   `<script src>` values and carries a `scripts` array only when a body is
 *   attached to it (otherwise script-url detectors keep scanning its HTML).
 * - A bundle's body is attached to ONE page per audit, the first that references
 *   it (the home page for a shared bundle): detection unions over pages, so a
 *   second copy adds bytes and no signal.
 * - Bodies are cut to `bundleBytes`, then `pageBytes` per page and `auditBytes`
 *   per audit; a body past a cap is dropped, the script's URL stays listed.
 */
export function buildTechInputs(
  pages: TechPageSource[],
  scripts: readonly TechFetchedScript[],
  limits: TechBundleLimits = DEFAULT_TECH_BUNDLE_LIMITS,
): LocalTechInput[] {
  const attached = new Set<string>();
  let auditBytes = 0;
  return pages.map((page, index) => {
    const own = new Set([page.url, ...(page.requestedUrl ? [page.requestedUrl] : [])]);
    const owned = scripts.filter((script) =>
      script.sourcePages?.length
        ? script.sourcePages.some((source) => own.has(source))
        : index === 0,
    );

    // Three passes over the page's bundles, so a page with many scripts gives every
    // one a body before any one gets a big one:
    //   1. a floor (the head of each script, as before #1254),
    //   2. the parts of a bundle past its head that detection needs: windows around
    //      the vendor literals and the tail, where a bundled app's own code sits
    //      after the framework it ships with,
    //   3. the rest of the per-bundle cap, as more head.
    let pageBytes = 0;
    const room = (): number =>
      Math.min(limits.pageBytes - pageBytes, limits.auditBytes - auditBytes);
    const charge = (n: number): void => {
      pageBytes += n;
      auditBytes += n;
    };
    const plan = (limits.bundleBytes > 0 ? owned : [])
      .filter((script) => script.content && !attached.has(script.url))
      .map((script) => ({
        url: script.url,
        content: script.content as string,
        head: "",
        headBytes: 0,
        extras: "",
        extrasBytes: 0,
      }));
    const floor = Math.min(TECH_BUNDLE_FLOOR_BYTES, limits.bundleBytes);
    for (const item of plan) {
      const r = Math.min(floor, room());
      if (r <= 0) break;
      item.head = truncateToBytes(item.content, r);
      item.headBytes = byteLength(item.head);
      charge(item.headBytes);
    }
    for (const item of plan) {
      if (!item.head || item.head.length >= item.content.length) continue;
      const r = Math.min(
        TECH_BUNDLE_EXTRAS_BYTES,
        limits.bundleBytes - item.headBytes - SEGMENT_SEPARATOR.length,
        room() - SEGMENT_SEPARATOR.length,
      );
      if (r <= 0) continue;
      item.extras = truncateToBytes(sampleBundleExtras(item.content, item.head.length, r), r);
      if (!item.extras) continue;
      item.extrasBytes = byteLength(item.extras) + SEGMENT_SEPARATOR.length;
      charge(item.extrasBytes);
    }
    for (const item of plan) {
      if (!item.head || item.head.length >= item.content.length) continue;
      const r = Math.min(limits.bundleBytes - item.headBytes - item.extrasBytes, room());
      if (r <= 0) continue;
      const head = truncateToBytes(item.content, item.headBytes + r);
      const bytes = byteLength(head);
      charge(bytes - item.headBytes);
      item.head = head;
      item.headBytes = bytes;
    }
    const withBody: { url: string; content: string }[] = [];
    for (const item of plan) {
      if (!item.head) continue;
      attached.add(item.url);
      withBody.push({
        url: item.url,
        content: item.extras ? `${item.head}${SEGMENT_SEPARATOR}${item.extras}` : item.head,
      });
    }

    const srcs = extractScriptSrcs(page.html);
    const base: LocalTechInput = {
      url: page.url,
      headers: page.headers,
      html: page.html,
      ...(page.meta ? { meta: page.meta } : {}),
    };
    if (index > 0 && withBody.length === 0) return base;

    const urls = new Set<string>(withBody.map((script) => script.url));
    for (const src of srcs) urls.add(src);
    if (index === 0) for (const script of scripts) urls.add(script.url);
    const bodies = new Map(withBody.map((script) => [script.url, script.content]));
    return {
      ...base,
      scripts: [...urls]
        .slice(0, SERVICE_LIMITS.techDetectMaxScriptsPerPage)
        .map((url) => ({ url, content: bodies.get(url) })),
    };
  });
}
