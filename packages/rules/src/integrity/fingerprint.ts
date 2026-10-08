// integrity/fingerprint — per-page template fingerprint + site-baseline clustering
// for the template-discontinuity rule. A compromised standalone page (the kit)
// has NONE of the site theme's markup; we fingerprint each page on stable theme
// markers and flag pages that diverge hard from the dominant cluster.
//
// Site-scope only; reads ctx.site.pages[].parsed.document. No external calls.

import type { ParsedPage } from "../types";

import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

export interface PageFingerprint {
  /** Distinct external asset hosts referenced by <link>/<script>/<img>. */
  assetHosts: Set<string>;
  /**
   * Hosts that actually SERVED something: a stylesheet, a script or an image.
   *
   * `assetHosts` is every `<link href>` host, so it also carries canonical,
   * icon, preconnect, dns-prefetch and alternate, none of which is the site
   * handing the page a resource. Those are fine for clustering, where any
   * shared head markup is signal, and wrong for template-discontinuity's
   * "does this page load the site's own assets" veto, which a page could
   * otherwise satisfy with a single `<link rel=canonical>` (#2233).
   */
  resourceHosts: Set<string>;
  /**
   * The subset of {@link resourceHosts} reached by a stylesheet or a script.
   *
   * An image alone is the weakest of the three: a standalone page can hotlink
   * one logo. Loading the site's CSS or JS is the part that says the page is
   * being rendered by the site.
   */
  codeHosts: Set<string>;
  /** Class tokens on <body> (theme/framework signature). */
  bodyClasses: Set<string>;
  /** CSS custom-property names declared inline / in <style> (theme tokens). */
  cssVars: Set<string>;
  /** Whether the page has a <nav> and a <footer> (chrome present). */
  hasNav: boolean;
  hasFooter: boolean;
  /** Stylesheet hrefs (theme CSS is shared across a themed site). */
  stylesheetHrefs: Set<string>;
}

// A custom property declaration is a run of name characters that starts with
// `--` somewhere inside it and ends at a `:`. The run is found by anchoring on a
// non-name character before it, so each run is scanned once (an earlier version
// let every `--` inside `--0--0--0…` start its own scan, which was quadratic),
// and the `--` is then located with indexOf. Linear in the input.
const CSS_NAME_RUN_RE = /(?<![a-z0-9-])[a-z0-9-]+\s*:/gi;

/** The custom property names (`--brand-color`, lowercased) declared in a CSS string. */
export function cssVarNames(css: string): string[] {
  const names: string[] = [];
  for (const m of css.matchAll(CSS_NAME_RUN_RE)) {
    const run = m[0].replace(/\s*:$/, "");
    const at = run.indexOf("--");
    if (at >= 0 && run.length - at >= 3) names.push(run.slice(at).toLowerCase());
  }
  return names;
}

/**
 * DOM walks performed by `fingerprintPage` in this process.
 *
 * A test seam, mirroring `detachCounts` in audit-engine, and it exists because
 * nothing about the OUTPUT can prove the walk was paid once. Walking the same
 * document twice returns an equal fingerprint and an identical cluster key, so
 * every value assertion still passes when a caller quietly stops sharing the one
 * the streamed loop built (#1949) and puts a second five-`querySelectorAll` pass
 * per page back into the pipeline #1913 exists to keep flat. Only the count
 * distinguishes them.
 *
 * Counted after the no-document early return, so it is walks, not calls.
 */
let fingerprintWalks = 0;

/** Walks since the last reset. See {@link fingerprintPage}. */
export function fingerprintWalkCount(): number {
  return fingerprintWalks;
}

/** Test seam: the count is process-wide, so a test asserting on it starts here. */
export function resetFingerprintWalkCount(): void {
  fingerprintWalks = 0;
}

/** Build a template fingerprint for one parsed page. */
export function fingerprintPage(
  parsed: ParsedPage,
  pageUrl: string
): PageFingerprint | null {
  const doc = parsed.document;
  if (!doc) return null;
  fingerprintWalks++;

  const assetHosts = new Set<string>();
  const resourceHosts = new Set<string>();
  const codeHosts = new Set<string>();
  const stylesheetHrefs = new Set<string>();
  /** `kind` says which of the three sets the host also belongs in. */
  const addHost = (raw: string | null, kind: "link" | "resource" | "code") => {
    if (!raw) return;
    let host: string;
    try {
      host = new URL(raw, pageUrl).hostname.toLowerCase();
    } catch {
      return;
    }
    assetHosts.add(host);
    if (kind === "link") return;
    resourceHosts.add(host);
    if (kind === "code") codeHosts.add(host);
  };

  // The asset graph is what the page loads, so <noscript> content is not in
  // it (#434). It also keeps this key sound for the template-scoped rules that
  // read the same elements, security/sri and security/third-party-cookies:
  // they skip <noscript> content now, so a key that still counted it could
  // cluster a page whose tracker only sits in a fallback with one that loads it.
  for (const link of querySelectorAllOutsideNoscript(doc, "link[href]")) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase();
    const href = link.getAttribute("href");
    const isStylesheet = rel.includes("stylesheet");
    addHost(href, isStylesheet ? "code" : "link");
    if (isStylesheet && href) stylesheetHrefs.add(href);
  }
  for (const s of querySelectorAllOutsideNoscript(doc, "script[src]")) {
    addHost(s.getAttribute("src"), "code");
  }
  for (const img of querySelectorAllOutsideNoscript(doc, "img[src]")) {
    addHost(img.getAttribute("src"), "resource");
  }

  const bodyClasses = new Set<string>();
  const body = doc.querySelector("body");
  if (body) {
    for (const cls of (body.getAttribute("class") ?? "").split(/\s+/)) {
      if (cls) bodyClasses.add(cls.toLowerCase());
    }
  }

  const cssVars = new Set<string>();
  for (const style of querySelectorAllOutsideNoscript(doc, "style")) {
    const css = style.textContent ?? "";
    for (const name of cssVarNames(css)) cssVars.add(name);
  }
  // Inline style on <html>/<body> sometimes carries theme tokens too.
  for (const el of [doc.documentElement, body]) {
    const inline = el?.getAttribute?.("style") ?? "";
    for (const name of cssVarNames(inline)) cssVars.add(name);
  }

  return {
    assetHosts,
    resourceHosts,
    codeHosts,
    bodyClasses,
    cssVars,
    hasNav: doc.querySelector("nav, [role='navigation']") !== null,
    hasFooter: doc.querySelector("footer, [role='contentinfo']") !== null,
    stylesheetHrefs,
  };
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Similarity of a page fingerprint to the site baseline (a union of the most
 * common theme markers). 0 = nothing in common with the theme, 1 = full theme.
 * Weighted toward the most stable markers (stylesheets, asset hosts, chrome).
 */
export function similarityToBaseline(
  fp: PageFingerprint,
  baseline: SiteBaseline
): number {
  const stylesheetSim = jaccard(fp.stylesheetHrefs, baseline.stylesheetHrefs);
  const hostSim = jaccard(fp.assetHosts, baseline.assetHosts);
  const classSim = jaccard(fp.bodyClasses, baseline.bodyClasses);
  const varSim = jaccard(fp.cssVars, baseline.cssVars);
  const chromeSim =
    ((fp.hasNav === baseline.hasNav ? 1 : 0) +
      (fp.hasFooter === baseline.hasFooter ? 1 : 0)) /
    2;

  // Weighted average; stylesheets + hosts are the strongest theme signal.
  return (
    0.35 * stylesheetSim +
    0.25 * hostSim +
    0.15 * classSim +
    0.1 * varSim +
    0.15 * chromeSim
  );
}

export interface SiteBaseline {
  assetHosts: Set<string>;
  /** Hosts a MAJORITY of pages load a stylesheet, script or image from. */
  resourceHosts: Set<string>;
  bodyClasses: Set<string>;
  cssVars: Set<string>;
  stylesheetHrefs: Set<string>;
  hasNav: boolean;
  hasFooter: boolean;
  /** Number of pages the baseline was built from. */
  pageCount: number;
}

/**
 * Build a site baseline from page fingerprints: markers shared by a majority of
 * pages (the dominant theme cluster). Robust to a few injected outliers because
 * those won't reach the majority threshold.
 */
export function buildBaseline(fingerprints: PageFingerprint[]): SiteBaseline {
  const n = fingerprints.length;
  const majority = Math.max(2, Math.ceil(n / 2));

  const tally = <T>(pick: (fp: PageFingerprint) => Set<T>): Set<T> => {
    const counts = new Map<T, number>();
    for (const fp of fingerprints) {
      for (const v of pick(fp)) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const out = new Set<T>();
    for (const [v, c] of counts) if (c >= majority) out.add(v);
    return out;
  };

  const navCount = fingerprints.filter((fp) => fp.hasNav).length;
  const footerCount = fingerprints.filter((fp) => fp.hasFooter).length;

  return {
    assetHosts: tally((fp) => fp.assetHosts),
    resourceHosts: tally((fp) => fp.resourceHosts),
    bodyClasses: tally((fp) => fp.bodyClasses),
    cssVars: tally((fp) => fp.cssVars),
    stylesheetHrefs: tally((fp) => fp.stylesheetHrefs),
    hasNav: navCount >= majority,
    hasFooter: footerCount >= majority,
    pageCount: n,
  };
}
