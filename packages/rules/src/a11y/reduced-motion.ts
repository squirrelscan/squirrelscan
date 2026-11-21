// a11y/reduced-motion - motion with no prefers-reduced-motion handling (#711)
//
// Declares WCAG 2.3.3 Animation from Interactions (AAA) only: technique C39 uses
// `prefers-reduced-motion`, which is exactly what run() looks for. 2.2.2 Pause,
// Stop, Hide (A) is not declared: run() never looks for a pause control (one may
// exist), so the rule reports missing reduced-motion handling, not a WCAG failure.

import type { Document } from "linkedom";

import { wcag } from "@squirrelscan/core-contracts/wcag";

import type {
  CheckResult,
  Rule,
  RuleContext,
  RuleResult,
  StylesheetMotionData,
} from "../types";

import { parseDeclarations, parseRules } from "../content/hidden-text";

/** Rules read per stylesheet or style block; a 100,000-rule sheet stops here. */
const MAX_CSS_RULES = 5000;
/** Bytes of CSS read per file or per page's inline styles; past it the text is cut, never parsed whole. */
const MAX_CSS_BYTES = 512 * 1024;
/** Bytes of one inline script scanned. */
const MAX_SCRIPT_BYTES = 512 * 1024;

const REDUCED_MOTION = /prefers-reduced-motion/i;
/** Selectors kept per stylesheet, and the longest one kept. */
const MAX_MOTION_SELECTORS = 100;
const MAX_SELECTOR_CHARS = 200;
/** `querySelector` calls per page when matching stylesheet selectors. */
const MAX_SELECTOR_QUERIES = 200;
/** Inline `style` attributes read per page. */
const MAX_STYLE_ATTRS = 500;
const MAX_STYLE_ATTR_CHARS = 4096;

export interface CssMotionSummary {
  /** A real `@media` rule whose condition contains `prefers-reduced-motion` (comments and strings do not count). */
  mentionsReducedMotion: boolean;
  hasInfiniteAnimation: boolean;
  hasSmoothScroll: boolean;
  /** Selectors of the rules that carry an infinite animation: at most 100, each at most 200 characters. */
  infiniteAnimationSelectors: string[];
  /** Selectors of the rules that set `scroll-behavior: smooth`, capped like the animation selectors. */
  smoothScrollSelectors: string[];
  /**
   * Selectors of the rules inside a `prefers-reduced-motion: reduce` block that set animation,
   * transition or scroll-behavior: the motion that block actually covers (capped like the others).
   */
  reducedMotionSelectors: string[];
  reducedMotionMatchers: string[];
  /** A `reduce` block resets motion globally (`*`, `html`, `body`, `:root`). */
  reducedMotionGlobal: boolean;
}

/** Declarations that switch motion off or down inside a reduced-motion block. */
const MOTION_PROPERTY =
  /^(-webkit-)?(animation|transition)(-[a-z-]+)?$|^scroll-behavior$/;

/** A selector with case and whitespace normalized, so a reduced-motion rule and a motion rule compare equal. */
function normalizeSelector(sel: string): string {
  return sel.trim().replace(/\s+/g, " ").toLowerCase();
}

/** A selector with whitespace collapsed and case kept. */
function collapseSelector(sel: string): string {
  return sel.trim().replace(/\s+/g, " ");
}

/** The selector list of a rule, split into normalized parts. */
function selectorParts(list: string): string[] {
  return splitSelectorList(list).map(normalizeSelector).filter(Boolean);
}

/**
 * Third-party stylesheet hosts that serve only `@font-face` rules, so an unread sheet from
 * one cannot hold motion or reduced-motion handling and does not make the check partial.
 * use.fontawesome.com is deliberately absent: its CSS ships `fa-spin` and `fa-pulse` animations.
 */
export const FONT_ONLY_STYLESHEET_HOSTS: readonly string[] = [
  // Google Fonts CSS API: @font-face rules only.
  "fonts.googleapis.com",
  // Bunny Fonts, a Google Fonts compatible API: @font-face rules only.
  "fonts.bunny.net",
  // Adobe Fonts (Typekit) kit CSS: @font-face rules only.
  "use.typekit.net",
  // Adobe Fonts (Typekit) tracking and font CSS imported by kits: @font-face rules only.
  "p.typekit.net",
  // Fontshare CSS API: @font-face rules only.
  "api.fontshare.com",
];

function isFontOnlyHost(abs: string): boolean {
  try {
    return FONT_ONLY_STYLESHEET_HOSTS.includes(
      new URL(abs).hostname.toLowerCase()
    );
  } catch {
    return false;
  }
}

function pushSelector(list: string[], selector: string): void {
  if (
    list.length < MAX_MOTION_SELECTORS &&
    selector.length <= MAX_SELECTOR_CHARS &&
    !list.includes(selector)
  ) {
    list.push(selector);
  }
}

function isInfiniteAnimation(property: string, value: string): boolean {
  return (
    (property === "animation" ||
      property === "-webkit-animation" ||
      property === "animation-iteration-count" ||
      property === "-webkit-animation-iteration-count") &&
    /\binfinite\b/.test(value) &&
    !/^\s*none\b/.test(value)
  );
}

/**
 * What one stylesheet says about motion. Bounded by bytes and rules, so hostile CSS
 * costs a fixed amount. A rule inside any `prefers-reduced-motion` block (either
 * `reduce` or `no-preference`) or inside `@keyframes` is not a motion signal.
 */
export function stylesheetMotionOf(css: string): CssMotionSummary {
  const text = css.length > MAX_CSS_BYTES ? css.slice(0, MAX_CSS_BYTES) : css;
  const summary: CssMotionSummary = {
    mentionsReducedMotion: false,
    hasInfiniteAnimation: false,
    hasSmoothScroll: false,
    infiniteAnimationSelectors: [],
    smoothScrollSelectors: [],
    reducedMotionSelectors: [],
    reducedMotionMatchers: [],
    reducedMotionGlobal: false,
  };
  // Cheap pre-filter: nothing to parse when none of these words appear.
  if (!/infinite|smooth|prefers-reduced-motion/i.test(text)) return summary;
  for (const rule of parseRules(text, MAX_CSS_RULES)) {
    const reducedAt = rule.at?.find(
      (a) => /^\s*@media\b/i.test(a) && REDUCED_MOTION.test(a)
    );
    if (reducedAt) {
      summary.mentionsReducedMotion = true;
      // A reduce block covers only the selectors whose rules touch motion. Motion inside a
      // `no-preference` block is already gated (skipped below), so it covers nothing else.
      if (
        !/no-preference/i.test(reducedAt) &&
        [...parseDeclarations(rule.body).keys()].some((property) =>
          MOTION_PROPERTY.test(property)
        )
      ) {
        for (const part of selectorParts(rule.selector)) {
          if (ALWAYS_MATCHES.has(part)) summary.reducedMotionGlobal = true;
          else pushSelector(summary.reducedMotionSelectors, part);
        }
        // Case kept: class and attribute values are case-sensitive, and page elements are matched against these.
        for (const part of splitSelectorList(rule.selector)
          .map(collapseSelector)
          .filter(Boolean)) {
          if (!ALWAYS_MATCHES.has(part.toLowerCase()))
            pushSelector(summary.reducedMotionMatchers, part);
        }
      }
    }
    if (
      rule.at?.some(
        (a) =>
          REDUCED_MOTION.test(a) || /@keyframes|@-webkit-keyframes/i.test(a)
      )
    )
      continue;
    if (!/infinite|smooth/i.test(rule.body)) continue;
    for (const [property, raw] of parseDeclarations(rule.body)) {
      const value = raw.toLowerCase();
      if (property === "scroll-behavior" && /\bsmooth\b/.test(value)) {
        summary.hasSmoothScroll = true;
        pushSelector(summary.smoothScrollSelectors, rule.selector);
      }
      if (isInfiniteAnimation(property, value)) {
        summary.hasInfiniteAnimation = true;
        pushSelector(summary.infiniteAnimationSelectors, rule.selector);
      }
    }
  }
  return summary;
}

/** Split a selector list on commas outside parentheses, brackets and quotes. */
function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out;
}

/** Longer names go before their prefixes (`focus-within` before `focus`), and a name ends at `(?![\w-])`, so a hyphenated pseudo is never cut at its first `-`. */
export const DYNAMIC_PSEUDO =
  /::?(hover|focus-within|focus-visible|focus|active|visited|any-link|link|target|before|after|first-line|first-letter|selection|placeholder)(?![\w-])(\([^)]{0,100}\))?|::[a-z-]{1,40}(\([^)]{0,100}\))?/gi;

/** Selector with the pseudo-classes and pseudo-elements `querySelector` cannot match statically removed. */
export function staticSelector(sel: string): string {
  let out = sel.replace(DYNAMIC_PSEUDO, "").trim();
  if (out === "" || /[>+~]$/.test(out)) out += "*";
  return out;
}

/**
 * Selectors a motion library's own reduced-motion block uses for the motion it starts. A `reduce`
 * rule on one of them (AOS's `[data-aos]`, animate.css 4's `.animate__animated`, 3's `.animated`)
 * handles that library, though not the rest of the page.
 */
const LIBRARY_REDUCED_MOTION_SELECTORS: Readonly<
  Record<string, readonly string[]>
> = {
  aos: ["[data-aos]"],
  "animate-wow": [".animate__animated", ".animated"],
};

/** Selectors that match every HTML page, checked without a `querySelector` call. */
const ALWAYS_MATCHES = new Set(["html", ":root", "body", "*"]);

/**
 * True when a selector in the lists matches an element that no reduced-motion selector also
 * matches. Elements are compared, not selector text, so `.animate-spin` on an element that also
 * carries `motion-reduce:animate-none` is handled, and `.spin` is not handled by `.Spin`.
 * Bounded by `budget`: every `querySelectorAll` and every `matches` call spends one.
 */
function anySelectorMatches(
  doc: Document,
  lists: readonly string[],
  budget: { left: number },
  reduceSelectors: readonly string[] = []
): boolean {
  const reduce = reduceSelectors.map(staticSelector).filter(Boolean);
  for (const list of lists) {
    for (const part of splitSelectorList(list)) {
      if (reduce.length === 0 && ALWAYS_MATCHES.has(part.trim().toLowerCase()))
        return true;
      if (budget.left <= 0) return false;
      const sel = staticSelector(part);
      if (!sel) continue;
      budget.left--;
      try {
        for (const el of doc.querySelectorAll(sel)) {
          let handledEl = false;
          for (const r of reduce) {
            if (budget.left <= 0) return false;
            budget.left--;
            try {
              if (el.matches(r)) {
                handledEl = true;
                break;
              }
            } catch {
              // An invalid reduce selector matches nothing.
            }
          }
          if (!handledEl) return true;
        }
      } catch {
        // An invalid or unsupported selector counts as no match.
      }
    }
  }
  return false;
}

interface Source {
  key: string;
  label: string;
  /** Triggered by script code or a motion library rather than by CSS. */
  viaScript: boolean;
  trigger: string;
}

/** A script that reads the media query: a `matchMedia` call and the `prefers-reduced-motion` string. */
function handlesReducedMotion(script: string): boolean {
  return /matchMedia/.test(script) && REDUCED_MOTION.test(script);
}

function attrHas(html: string, re: RegExp): boolean {
  return re.test(html);
}

function resolve(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

/** A stylesheet URL safe to show in a finding: credentials, query string and fragment are dropped. */
function shownUrl(abs: string): string {
  const u = new URL(abs);
  u.username = "";
  u.password = "";
  u.search = "";
  u.hash = "";
  return u.href;
}

function sameSite(a: string, b: string): boolean {
  try {
    const x = new URL(a).hostname.replace(/^www\./, "");
    const y = new URL(b).hostname.replace(/^www\./, "");
    return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
  } catch {
    return false;
  }
}

export const reducedMotionRule: Rule = {
  meta: {
    id: "a11y/reduced-motion",
    name: "Reduced Motion",
    description:
      "Checks that motion can be turned off for visitors who ask their device to reduce it",
    solution:
      "Parallax, scroll-triggered fade-ins, auto-advancing carousels and looping animation can make people with vestibular disorders dizzy or nauseous. Every major OS has a reduce motion setting, which browsers expose as @media (prefers-reduced-motion: reduce). Wrap looping animation and smooth scrolling so they switch off under that query (@media (prefers-reduced-motion: reduce) { * { animation: none !important; scroll-behavior: auto !important } }), and in script check window.matchMedia('(prefers-reduced-motion: reduce)') before starting scroll animation or autoplay.",
    category: "a11y",
    wcag: [wcag("2.3.3")],
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 3,
    checks: [
      { name: "reduced-motion-aos", outcome: "problem" },
      { name: "reduced-motion-gsap-scrolltrigger", outcome: "problem" },
      { name: "reduced-motion-lottie", outcome: "problem" },
      { name: "reduced-motion-animate-wow", outcome: "problem" },
      { name: "reduced-motion-parallax", outcome: "problem" },
      { name: "reduced-motion-smooth-scroll-lib", outcome: "problem" },
      { name: "reduced-motion-carousel-autoplay", outcome: "problem" },
      { name: "reduced-motion-marquee", outcome: "problem" },
      { name: "reduced-motion-autoplay-video", outcome: "problem" },
      { name: "reduced-motion-css-infinite-animation", outcome: "problem" },
      { name: "reduced-motion-css-smooth-scroll", outcome: "problem" },
      { name: "reduced-motion-unverified", outcome: "skipped" },
      {
        name: "reduced-motion",
        outcome: "clean",
        clears: [
          "reduced-motion-aos",
          "reduced-motion-gsap-scrolltrigger",
          "reduced-motion-lottie",
          "reduced-motion-animate-wow",
          "reduced-motion-parallax",
          "reduced-motion-smooth-scroll-lib",
          "reduced-motion-carousel-autoplay",
          "reduced-motion-marquee",
          "reduced-motion-autoplay-video",
          "reduced-motion-css-infinite-animation",
          "reduced-motion-css-smooth-scroll",
        ],
      },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const html = ctx.page.html;
    const pageUrl = ctx.page.finalUrl ?? ctx.page.url;
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Handling: only a real reduced-motion @media rule, a matchMedia script, or a media-gated sheet.
    let handled = false;
    const gated = (el: Element) =>
      REDUCED_MOTION.test(el.getAttribute("media") ?? "");

    // Inline CSS, capped as a whole. A <style media="...prefers-reduced-motion..."> is handling and its motion is gated.
    let inlineCss = "";
    for (const el of doc.querySelectorAll("style")) {
      if (inlineCss.length >= MAX_CSS_BYTES) break;
      if (gated(el)) {
        handled = true;
        continue;
      }
      inlineCss += `${el.textContent ?? ""}\n`;
    }
    inlineCss = inlineCss.slice(0, MAX_CSS_BYTES);
    const inlineScripts: string[] = [];
    let scriptBytes = 0;
    for (const el of doc.querySelectorAll("script:not([src])")) {
      if (scriptBytes >= MAX_SCRIPT_BYTES) break;
      const text = (el.textContent ?? "").slice(
        0,
        MAX_SCRIPT_BYTES - scriptBytes
      );
      scriptBytes += text.length;
      inlineScripts.push(text);
    }
    const scriptText = inlineScripts.join("\n");
    if (inlineScripts.some(handlesReducedMotion)) handled = true;

    const scriptSrcs = Array.from(doc.querySelectorAll("script[src]"))
      .map((el) => el.getAttribute("src") ?? "")
      .filter(Boolean);
    // Library names are matched against URL pathnames of scripts and stylesheet/preload links only.
    const assetPaths: string[] = [];
    for (const src of scriptSrcs) {
      const abs = resolve(src, pageUrl);
      if (abs) assetPaths.push(new URL(abs).pathname);
    }
    for (const el of doc.querySelectorAll("link[href]")) {
      const rel = (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
      if (
        !rel.some(
          (r) => r === "stylesheet" || r === "preload" || r === "modulepreload"
        )
      )
        continue;
      const abs = resolve(el.getAttribute("href") ?? "", pageUrl);
      if (abs) assetPaths.push(new URL(abs).pathname);
    }
    const assetUrls = assetPaths.join("\n");

    // Stylesheets this page references.
    const motionSheets = new Map<string, StylesheetMotionData>();
    for (const s of ctx.site?.stylesheetMotion ?? [])
      motionSheets.set(s.url, s);
    const budget = { left: MAX_SELECTOR_QUERIES };
    let unreadSheets = 0;
    const inline = stylesheetMotionOf(inlineCss);
    // A reduced-motion block handles the whole page only as a global reset; otherwise only the selectors it names.
    const covered = new Set<string>(inline.reducedMotionSelectors);
    const matchers = new Set<string>(inline.reducedMotionMatchers);
    if (inline.reducedMotionGlobal) handled = true;
    // Inline style attributes always count: they apply to their own element.
    let attrInfinite = false;
    let attrCount = 0;
    for (const el of doc.querySelectorAll("[style]")) {
      if (++attrCount > MAX_STYLE_ATTRS) break;
      const value = (el.getAttribute("style") ?? "").slice(
        0,
        MAX_STYLE_ATTR_CHARS
      );
      if (!/infinite/i.test(value)) continue;
      for (const [property, raw] of parseDeclarations(value)) {
        if (isInfiniteAnimation(property, raw.toLowerCase()))
          attrInfinite = true;
      }
      if (attrInfinite) break;
    }
    const readSheets: { sheet: StylesheetMotionData; abs: string }[] = [];
    for (const el of doc.querySelectorAll("link[href]")) {
      const rel = (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
      if (!rel.includes("stylesheet")) continue;
      if (gated(el)) {
        handled = true;
        continue;
      }
      const media = el.getAttribute("media");
      if (media && /print/i.test(media) && !/screen|all/i.test(media)) continue;
      const abs = resolve(el.getAttribute("href") ?? "", pageUrl);
      if (!abs) continue;
      const sheet = motionSheets.get(abs);
      if (!sheet || !sheet.read) {
        if (!isFontOnlyHost(abs)) unreadSheets++;
        continue;
      }
      if (sheet.reducedMotionGlobal) handled = true;
      for (const sel of sheet.reducedMotionSelectors ?? []) covered.add(sel);
      // Sheet data cached before the case-kept list existed falls back to the lowercased selectors.
      for (const sel of sheet.reducedMotionMatchers ??
        sheet.reducedMotionSelectors ??
        [])
        matchers.add(sel);
      readSheets.push({ sheet, abs });
    }

    // Motion is judged once every sheet's reduced-motion rules are known.
    let cssInfinite =
      attrInfinite ||
      (inline.hasInfiniteAnimation &&
        anySelectorMatches(doc, inline.infiniteAnimationSelectors, budget, [
          ...matchers,
        ]));
    let cssSmooth =
      inline.hasSmoothScroll &&
      anySelectorMatches(doc, inline.smoothScrollSelectors, budget, [
        ...matchers,
      ]);
    let cssSource = cssInfinite || cssSmooth ? "inline <style>" : "";
    for (const { sheet, abs } of readSheets) {
      if (
        sheet.hasInfiniteAnimation &&
        !cssInfinite &&
        anySelectorMatches(
          doc,
          sheet.infiniteAnimationSelectors ?? [],
          budget,
          [...matchers]
        )
      ) {
        cssInfinite = true;
        cssSource ||= shownUrl(abs);
      }
      if (
        sheet.hasSmoothScroll &&
        !cssSmooth &&
        anySelectorMatches(doc, sheet.smoothScrollSelectors ?? [], budget, [
          ...matchers,
        ])
      ) {
        cssSmooth = true;
        cssSource ||= shownUrl(abs);
      }
    }

    // Scripts: same-site files not read leave handling unverified; read ones can handle it.
    let unreadScripts = 0;
    const pageScripts = ctx.site?.scripts ?? [];
    for (const src of scriptSrcs) {
      const abs = resolve(src, pageUrl);
      if (!abs || !sameSite(abs, pageUrl)) continue;
      const hit = pageScripts.find((s) => s.url === abs || s.finalUrl === abs);
      if (!hit || hit.content === null) unreadScripts++;
    }
    for (const s of pageScripts) {
      if (s.content === null) continue;
      if (
        s.sourcePages.includes(ctx.page.url) ||
        s.sourcePages.includes(pageUrl)
      ) {
        if (handlesReducedMotion(s.content)) handled = true;
      }
    }

    // Motion signals.
    const sources: Source[] = [];
    const add = (
      key: string,
      label: string,
      viaScript: boolean,
      trigger: string
    ) => {
      if (!sources.some((s) => s.key === key))
        sources.push({ key, label, viaScript, trigger });
    };

    if (
      attrHas(html, /\bdata-aos\b/i) ||
      /(^|[/.@-])aos(\.min)?\.(js|css)\b|\/aos@/i.test(assetUrls)
    ) {
      add("aos", "AOS scroll animations", true, "data-aos");
    }
    if (
      /scrolltrigger/i.test(assetUrls) ||
      /\bScrollTrigger\b/.test(scriptText)
    ) {
      add(
        "gsap-scrolltrigger",
        "GSAP ScrollTrigger animations",
        true,
        "ScrollTrigger"
      );
    }
    if (
      doc.querySelector("lottie-player, dotlottie-player, dotlottie-wc") ||
      /lottie/i.test(assetUrls)
    ) {
      add("lottie", "Lottie animations", true, "lottie-player");
    }
    if (
      /animate\.(min\.)?css|wow(\.min)?\.js/i.test(assetUrls) ||
      (doc.querySelector(".wow") &&
        doc.querySelector("[class*='animate__'], .animated"))
    ) {
      add(
        "animate-wow",
        "animate.css / WOW.js animations",
        true,
        "animate.css"
      );
    }
    if (
      attrHas(html, /\bdata-(parallax|jarallax|rellax)\b/i) ||
      /rellax|jarallax|parallax/i.test(assetUrls) ||
      doc.querySelector(".rellax, .jarallax")
    ) {
      add("parallax", "Parallax scrolling", true, "parallax");
    }
    if (
      /locomotive-scroll|lenis/i.test(assetUrls) ||
      /new\s+(LocomotiveScroll|Lenis)\s*\(/.test(scriptText)
    ) {
      add(
        "smooth-scroll-lib",
        "Locomotive Scroll or Lenis smooth scrolling",
        true,
        "scroll library"
      );
    }
    const autoplayAttr = Array.from(
      doc.querySelectorAll("[data-autoplay]")
    ).some((el) => {
      const v = (el.getAttribute("data-autoplay") ?? "").trim().toLowerCase();
      return v !== "" && v !== "false" && v !== "0" && v !== "off";
    });
    const dataLib =
      /\bdata-(slick|splide|swiper|flickity|owl)[a-z-]*\s*=\s*(["'])[^"']*["']?autoplay["']?\s*:\s*(true|\{|\d)/i.test(
        html
      );
    const scriptAutoplay =
      /(new\s+(Swiper|Splide|Flickity)\s*\(|\.slick\s*\(|\.owlCarousel\s*\()/.test(
        scriptText
      ) &&
      /autoplay\s*:\s*(true|\{|\d)|autoPlay\s*:\s*(true|\d)/.test(scriptText);
    if (autoplayAttr || dataLib || scriptAutoplay) {
      add("carousel-autoplay", "Auto-advancing carousel", true, "autoplay");
    }
    if (doc.querySelector("marquee"))
      add("marquee", "<marquee> scrolling text", false, "<marquee>");
    if (doc.querySelector("video[autoplay][loop]")) {
      add(
        "autoplay-video",
        "Autoplaying video",
        false,
        "<video autoplay loop>"
      );
    }
    if (cssInfinite)
      add(
        "css-infinite-animation",
        "Looping CSS animation",
        false,
        cssSource || "infinite animation"
      );
    if (cssSmooth)
      add(
        "css-smooth-scroll",
        "Smooth scrolling (scroll-behavior: smooth)",
        false,
        cssSource || "scroll-behavior"
      );

    // A library whose own selector a reduced-motion block names is handled; the rest of the page is not.
    const coveredLower = new Set([...covered].map((c) => c.toLowerCase()));
    let libraryHandled = false;
    for (let i = sources.length - 1; i >= 0; i--) {
      const selectors = LIBRARY_REDUCED_MOTION_SELECTORS[sources[i]!.key];
      if (selectors?.some((sel) => coveredLower.has(sel))) {
        sources.splice(i, 1);
        libraryHandled = true;
      }
    }

    if (sources.length === 0 || handled) {
      if (unreadSheets > 0) {
        return {
          checks: [
            {
              name: "reduced-motion-unverified",
              status: "skipped",
              message: `${unreadSheets} linked stylesheet${unreadSheets === 1 ? "" : "s"} not read, so motion and reduced-motion handling could not be fully verified`,
              skipReason: "stylesheet-not-read",
              details: {
                unreadSheets,
                motionSources: sources.map((x) => x.key),
                handled,
              },
            },
          ],
        };
      }
      return {
        checks: [
          {
            name: "reduced-motion",
            status: "pass",
            message:
              sources.length === 0 && !libraryHandled
                ? "No motion that needs reduced-motion handling"
                : "Reduced-motion handling found",
          },
        ],
      };
    }

    const checks: CheckResult[] = [];
    for (const source of sources) {
      const partial =
        unreadSheets > 0 || (source.viaScript && unreadScripts > 0);
      const reasons: string[] = [];
      if (unreadSheets > 0)
        reasons.push(
          `${unreadSheets} referenced stylesheet${unreadSheets === 1 ? "" : "s"} not read`
        );
      if (source.viaScript && unreadScripts > 0) {
        reasons.push(
          `${unreadScripts} same-site script${unreadScripts === 1 ? "" : "s"} not read`
        );
      }
      checks.push({
        name: `reduced-motion-${source.key}`,
        status: partial ? "info" : "warn",
        message: partial
          ? `${source.label} found; no prefers-reduced-motion handling in the CSS and scripts read (partial check: ${reasons.join(", ")}, so handling may live there)`
          : `${source.label} found with no prefers-reduced-motion handling`,
        value: source.trigger,
        details: { source: source.key, trigger: source.trigger, partial },
      });
    }
    return { checks };
  },
};
