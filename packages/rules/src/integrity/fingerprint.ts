// integrity/fingerprint — per-page template fingerprint + site-baseline clustering
// for the template-discontinuity rule. A compromised standalone page (the kit)
// has NONE of the site theme's markup; we fingerprint each page on stable theme
// markers and flag pages that diverge hard from the dominant cluster.
//
// Site-scope only; reads ctx.site.pages[].parsed.document. No external calls.

import type { ParsedPage } from "../types";

export interface PageFingerprint {
  /** Distinct external asset hosts referenced by <link>/<script>/<img>. */
  assetHosts: Set<string>;
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

const CSS_VAR_RE = /--[a-z0-9-]+\s*:/gi;

/** Build a template fingerprint for one parsed page. */
export function fingerprintPage(
  parsed: ParsedPage,
  pageUrl: string
): PageFingerprint | null {
  const doc = parsed.document;
  if (!doc) return null;

  const assetHosts = new Set<string>();
  const stylesheetHrefs = new Set<string>();
  const addHost = (raw: string | null) => {
    if (!raw) return;
    try {
      assetHosts.add(new URL(raw, pageUrl).hostname.toLowerCase());
    } catch {
      /* ignore */
    }
  };

  for (const link of doc.querySelectorAll("link[href]")) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase();
    const href = link.getAttribute("href");
    addHost(href);
    if (rel.includes("stylesheet") && href) stylesheetHrefs.add(href);
  }
  for (const s of doc.querySelectorAll("script[src]")) {
    addHost(s.getAttribute("src"));
  }
  for (const img of doc.querySelectorAll("img[src]")) {
    addHost(img.getAttribute("src"));
  }

  const bodyClasses = new Set<string>();
  const body = doc.querySelector("body");
  if (body) {
    for (const cls of (body.getAttribute("class") ?? "").split(/\s+/)) {
      if (cls) bodyClasses.add(cls.toLowerCase());
    }
  }

  const cssVars = new Set<string>();
  for (const style of doc.querySelectorAll("style")) {
    const css = style.textContent ?? "";
    for (const m of css.matchAll(CSS_VAR_RE)) {
      cssVars.add(m[0].replace(/\s*:$/, "").toLowerCase());
    }
  }
  // Inline style on <html>/<body> sometimes carries theme tokens too.
  for (const el of [doc.documentElement, body]) {
    const inline = el?.getAttribute?.("style") ?? "";
    for (const m of inline.matchAll(CSS_VAR_RE)) {
      cssVars.add(m[0].replace(/\s*:$/, "").toLowerCase());
    }
  }

  return {
    assetHosts,
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
    bodyClasses: tally((fp) => fp.bodyClasses),
    cssVars: tally((fp) => fp.cssVars),
    stylesheetHrefs: tally((fp) => fp.stylesheetHrefs),
    hasNav: navCount >= majority,
    hasFooter: footerCount >= majority,
    pageCount: n,
  };
}
