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

/**
 * The fingerprint that already reports each WAF provider, so a provider is one
 * technology and not a `waf-<provider>` twin beside it (#1253).
 */
const WAF_FINGERPRINT_IDS: Readonly<Record<string, string>> = {
  datadome: "datadome",
  imperva: "imperva-incapsula",
  kasada: "kasada",
  perimeterx: "human-perimeterx",
  sucuri: "sucuri-firewall",
};

export function withWafTech(
  technologies: DetectedTechnology[],
  headers: Record<string, string>,
  html: string,
): DetectedTechnology[] {
  const waf = detectWaf(recordToHeaders(headers), html);
  if (!waf.detected || !waf.provider) return technologies;
  const id = `waf-${waf.provider}`;
  const twin = WAF_FINGERPRINT_IDS[waf.provider];
  if (technologies.some((technology) => technology.id === id || technology.id === twin)) {
    return technologies;
  }
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

const BOTID_ID = "vercel-botid";

/**
 * Vercel BotID is Kasada's client served from a Vercel site, so a page that
 * carries the Kasada client AND Vercel's own `x-vercel-id` header is reported as
 * BotID instead of Kasada (#1253). Either way it is a technology: the page it
 * guards is ordinary content, and only a challenge response is a block.
 */
export function withVercelBotId(
  technologies: DetectedTechnology[],
  pageHeaders: ReadonlyArray<Record<string, string>>,
): DetectedTechnology[] {
  const kasada = technologies.find((t) => t.id === "kasada" || t.id === "waf-kasada");
  if (!kasada) return technologies;
  const onVercel = pageHeaders.some((headers) =>
    Object.keys(headers).some((name) => name.toLowerCase() === "x-vercel-id"),
  );
  if (!onVercel) return technologies;
  return [
    ...technologies.filter((t) => t.id !== "kasada" && t.id !== "waf-kasada"),
    {
      ...kasada,
      id: BOTID_ID,
      name: "Vercel BotID",
      icon: "vercel",
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
  /**
   * Set by {@link buildTechInputs} when a byte cap left a script of this page read
   * only in part or not at all (#1387); `time-budget` is added at detection time.
   */
  truncation?: { reasons: TechTruncationReason[]; scripts: number };
}

export type TechTruncationReason = NonNullable<ReportTechnologies["truncated"]>["reasons"][number];

const TECH_CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 } as const;

export interface DetectReportOptions {
  /** Wall-clock budget per page; default {@link TECH_DETECT_PAGE_BUDGET_MS}. */
  pageBudgetMs?: number;
  /** Characters of each script body matched; default the tech-detect package's 256 KB cap. */
  maxScriptChars?: number;
}

/**
 * The options of the local scan, which reads what the user's own crawl fetched and so matches
 * whole bundles up to the largest `bundle_bytes`, with a budget sized for that. Every other
 * caller (the cloud services, which run over client-sent bodies and hostile sites' bundles)
 * keeps the package's 256 KB per script and 5 s per page.
 */
export const LOCAL_TECH_DETECT_OPTIONS: Required<DetectReportOptions> = {
  pageBudgetMs: SERVICE_LIMITS.techDetectLocalPageBudgetMs,
  maxScriptChars: SERVICE_LIMITS.techDetectMaxBundleBytes,
};

/**
 * What the byte caps cut from `inputs` (a script read in part or not at all), as the report's
 * `truncated` field, or undefined when every body was read whole. The cloud result carries it
 * too: its payload is built from capped inputs, so the same facts apply to what it detected.
 */
export function techInputTruncation(
  inputs: readonly LocalTechInput[],
  extraReasons: Iterable<TechTruncationReason> = [],
): ReportTechnologies["truncated"] {
  const reasons = new Set<TechTruncationReason>(extraReasons);
  let scripts = 0;
  for (const input of inputs) {
    if (!input.truncation) continue;
    for (const reason of input.truncation.reasons) reasons.add(reason);
    scripts += input.truncation.scripts;
  }
  return reasons.size > 0 ? { reasons: [...reasons], scripts } : undefined;
}

export function detectReportTechnologiesMulti(
  pages: LocalTechInput[],
  diff?: TechScanDiff,
  options: DetectReportOptions = {},
): ReportTechnologies {
  const byId = new Map<string, DetectedTechnology>();
  const reasons = new Set<TechTruncationReason>();
  for (const page of pages) {
    const detected = detectTechnologies(page, undefined, {
      ...(options.pageBudgetMs !== undefined ? { budgetMs: options.pageBudgetMs } : {}),
      ...(options.maxScriptChars !== undefined ? { maxScriptChars: options.maxScriptChars } : {}),
      onBudgetExceeded: () => reasons.add("time-budget"),
    });
    for (const technology of detected) {
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
    ? withVercelBotId(
        withWafTech([...byId.values()], home.headers, home.html),
        pages.map((page) => page.headers),
      )
    : [...byId.values()];
  const section = buildReportTechnologies(technologies, diff);
  const truncated = techInputTruncation(pages, reasons);
  return truncated ? { ...section, truncated } : section;
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

/** The local scan's caps (#1387): nothing is sent anywhere, so bundles are read whole up to these. */
export const DEFAULT_LOCAL_TECH_BUNDLE_LIMITS: TechBundleLimits = {
  bundleBytes: SERVICE_LIMITS.techDetectLocalBundleBytes,
  pageBytes: SERVICE_LIMITS.techDetectLocalPageScriptBytes,
  auditBytes: SERVICE_LIMITS.techDetectLocalAuditScriptBytes,
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
 * Extract the URLs of `<link>` stylesheets, preloads and module preloads from raw
 * HTML. A script-url detector with a script list never reads the HTML, so a
 * signal that lives in a stylesheet path (`/wp-content/plugins/woocommerce/...css`,
 * a vendor's CSS host) is invisible to it unless the URL is listed beside the
 * scripts (#1263). Each tag is read once, at most 600 characters of attributes, and
 * `rel` is split into words and looked up, so quoting style does not matter and
 * nothing backtracks.
 */
const LINK_REL_WORDS = new Set(["stylesheet", "preload", "modulepreload"]);

/** The value of attribute `name` in a tag's attribute text: quoted either way, or bare. */
function attributeValue(attrs: string, name: string): string | undefined {
  const match = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]{0,2000})"|'([^']{0,2000})'|([^\\s"'>]{1,2000}))`,
    "i",
  ).exec(attrs);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function extractLinkAssetHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /<link\b([^>]{0,600})>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    // A bare value glued to a self-closing slash (`rel=stylesheet/>`) carries the slash.
    const rel = attributeValue(attrs, "rel")?.replace(/\/$/, "");
    if (
      !rel ||
      !rel
        .toLowerCase()
        .split(/\s+/)
        .some((word) => LINK_REL_WORDS.has(word))
    )
      continue;
    const href = attributeValue(attrs, "href");
    if (href) out.push(href);
  }
  return out;
}

/**
 * Most stylesheet and preload URLs listed per page, after the scripts, so they never push
 * a script out. A URL longer than MAX_LINK_HREF_CHARS is not listed, so the worst case is
 * 40 x 1000 chars = ~40 KB a page (the cloud payload carries them).
 */
const MAX_LINK_HREFS_PER_PAGE = 40;
const MAX_LINK_HREF_CHARS = 1000;

/** Platform asset prefixes the fingerprints key on: these URLs are listed before the rest. */
const PLATFORM_ASSET_PATH =
  /\/(?:wp-content\/(?:plugins|themes)|wp-includes|sites\/default\/files|static\/version|skin\/frontend|cdn\/shop|media\/system|bitrix\/templates)\//i;

/** Platform asset URLs first, then the rest, each in document order. */
export function prioritiseLinkHrefs(hrefs: string[]): string[] {
  const platform = hrefs.filter((href) => PLATFORM_ASSET_PATH.test(href));
  const rest = hrefs.filter((href) => !PLATFORM_ASSET_PATH.test(href));
  return [...platform, ...rest];
}

/**
 * Tech-detect input for each page, with the first-party script bodies the crawl
 * already fetched attached as `scripts[].content` (#1254). One shared builder for
 * the local scan and the cloud payload, so both see the same bytes and agree.
 *
 * - The home page (index 0) lists every fetched script plus its own `<script src>`
 *   and stylesheet or preload `<link href>` values (#1263), so script-url detectors
 *   see every origin and every asset path; another page lists its own
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
        bytes: byteLength(script.content as string),
        head: "",
        headBytes: 0,
        extras: "",
        extrasBytes: 0,
      }));
    // Every body fits whole under all three caps (the local scan's defaults hold a
    // page of bundles): no floor, no sampling, no second scan of the text.
    const allWhole =
      plan.every((item) => item.bytes <= limits.bundleBytes) &&
      plan.reduce((sum, item) => sum + item.bytes, 0) <= room();
    if (allWhole) {
      for (const item of plan) {
        item.head = item.content;
        item.headBytes = item.bytes;
        charge(item.bytes);
      }
    }
    const floor = Math.min(TECH_BUNDLE_FLOOR_BYTES, limits.bundleBytes);
    for (const item of allWhole ? [] : plan) {
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
    // A body read in part or left out: the report says so (#1387). A bundle that
    // reached `bundleBytes` was cut by that cap; one that stopped short of it ran
    // into the page or audit budget.
    const reasons = new Set<TechTruncationReason>();
    let cut = 0;
    for (const item of plan) {
      if (item.head.length >= item.content.length) continue;
      cut++;
      reasons.add(
        item.headBytes + item.extrasBytes >= limits.bundleBytes - 4
          ? "bundle-bytes"
          : limits.pageBytes - pageBytes <= 0
            ? "page-bytes"
            : "audit-bytes",
      );
    }
    const truncation = cut > 0 ? { reasons: [...reasons], scripts: cut } : undefined;
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
    const linkHrefs = extractLinkAssetHrefs(page.html);
    const base: LocalTechInput = {
      url: page.url,
      headers: page.headers,
      html: page.html,
      ...(page.meta ? { meta: page.meta } : {}),
      ...(truncation ? { truncation } : {}),
    };
    if (index > 0 && withBody.length === 0) return base;

    const urls = new Set<string>(withBody.map((script) => script.url));
    for (const src of srcs) urls.add(src);
    if (index === 0) for (const script of scripts) urls.add(script.url);
    const bodies = new Map(withBody.map((script) => [script.url, script.content]));
    // Stylesheet and preload URLs come last under a cap of their own (#1263): a page with
    // dozens of them cannot push a real script out of the per-page script limit.
    const listed = [...urls].slice(0, SERVICE_LIMITS.techDetectMaxScriptsPerPage);
    const seen = new Set(listed);
    let linksAdded = 0;
    for (const href of prioritiseLinkHrefs(linkHrefs)) {
      if (linksAdded >= MAX_LINK_HREFS_PER_PAGE) break;
      if (href.length > MAX_LINK_HREF_CHARS || seen.has(href)) continue;
      seen.add(href);
      listed.push(href);
      linksAdded++;
    }
    return {
      ...base,
      scripts: listed.map((url) => ({ url, content: bodies.get(url) })),
    };
  });
}
