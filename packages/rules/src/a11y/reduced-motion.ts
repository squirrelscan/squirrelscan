// a11y/reduced-motion - motion with no prefers-reduced-motion handling (#711)
//
// WCAG 2.3.3 Animation from Interactions (AAA) and 2.2.2 Pause, Stop, Hide (A);
// technique C39 uses `prefers-reduced-motion`. A static check cannot prove 2.2.2
// (a pause button may exist), so the rule reports missing reduced-motion handling,
// not a WCAG failure.

import { parseDeclarations, parseRules } from "../content/hidden-text";
import type { CheckResult, Rule, RuleContext, RuleResult, StylesheetMotionData } from "../types";

/** Rules read per stylesheet or style block; a 100,000-rule sheet stops here. */
const MAX_CSS_RULES = 5000;
/** Bytes of CSS read per file or per page's inline styles; past it the text is cut, never parsed whole. */
const MAX_CSS_BYTES = 512 * 1024;
/** Bytes of one inline script scanned. */
const MAX_SCRIPT_BYTES = 512 * 1024;

const REDUCED_MOTION = /prefers-reduced-motion/i;

export interface CssMotionSummary {
  mentionsReducedMotion: boolean;
  hasInfiniteAnimation: boolean;
  hasSmoothScroll: boolean;
}

/**
 * What one stylesheet says about motion. Bounded by bytes and rules, so hostile CSS
 * costs a fixed amount. A rule inside any `prefers-reduced-motion` block (either
 * `reduce` or `no-preference`) or inside `@keyframes` is not a motion signal.
 */
export function stylesheetMotionOf(css: string): CssMotionSummary {
  const text = css.length > MAX_CSS_BYTES ? css.slice(0, MAX_CSS_BYTES) : css;
  const summary: CssMotionSummary = {
    mentionsReducedMotion: REDUCED_MOTION.test(css),
    hasInfiniteAnimation: false,
    hasSmoothScroll: false,
  };
  // Cheap pre-filter: no declaration to parse when neither word appears.
  if (!/infinite|smooth/i.test(text)) return summary;
  for (const rule of parseRules(text, MAX_CSS_RULES)) {
    if (rule.at?.some((a) => REDUCED_MOTION.test(a) || /@keyframes|@-webkit-keyframes/i.test(a))) continue;
    if (!/infinite|smooth/i.test(rule.body)) continue;
    for (const [property, raw] of parseDeclarations(rule.body)) {
      const value = raw.toLowerCase();
      if (property === "scroll-behavior" && /\bsmooth\b/.test(value)) summary.hasSmoothScroll = true;
      if (
        (property === "animation" || property === "animation-iteration-count") &&
        /\binfinite\b/.test(value) &&
        !/^\s*none\b/.test(value)
      ) {
        summary.hasInfiniteAnimation = true;
      }
    }
    if (summary.hasInfiniteAnimation && summary.hasSmoothScroll) break;
  }
  return summary;
}

interface Source {
  key: string;
  label: string;
  /** Triggered by script code or a motion library rather than by CSS. */
  viaScript: boolean;
  trigger: string;
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
    description: "Checks that motion can be turned off for visitors who ask their device to reduce it",
    solution:
      "Parallax, scroll-triggered fade-ins, auto-advancing carousels and looping animation can make people with vestibular disorders dizzy or nauseous. Every major OS has a reduce motion setting, which browsers expose as @media (prefers-reduced-motion: reduce). Wrap looping animation and smooth scrolling so they switch off under that query (@media (prefers-reduced-motion: reduce) { * { animation: none !important; scroll-behavior: auto !important } }), and in script check window.matchMedia('(prefers-reduced-motion: reduce)') before starting scroll animation or autoplay.",
    category: "a11y",
    scope: "page",
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
      {
        name: "reduced-motion",
        outcome: "clean",
        clears: ["reduced-motion-aos", "reduced-motion-gsap-scrolltrigger", "reduced-motion-lottie", "reduced-motion-animate-wow", "reduced-motion-parallax", "reduced-motion-smooth-scroll-lib", "reduced-motion-carousel-autoplay", "reduced-motion-marquee", "reduced-motion-autoplay-video", "reduced-motion-css-infinite-animation", "reduced-motion-css-smooth-scroll"],
      },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const html = ctx.page.html;
    const pageUrl = ctx.page.finalUrl ?? ctx.page.url;
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Inline CSS, capped as a whole.
    let inlineCss = "";
    for (const el of doc.querySelectorAll("style")) {
      if (inlineCss.length >= MAX_CSS_BYTES) break;
      inlineCss += `${el.textContent ?? ""}\n`;
    }
    inlineCss = inlineCss.slice(0, MAX_CSS_BYTES);
    const inlineScripts: string[] = [];
    let scriptBytes = 0;
    for (const el of doc.querySelectorAll("script:not([src])")) {
      if (scriptBytes >= MAX_SCRIPT_BYTES) break;
      const text = (el.textContent ?? "").slice(0, MAX_SCRIPT_BYTES - scriptBytes);
      scriptBytes += text.length;
      inlineScripts.push(text);
    }
    const scriptText = inlineScripts.join("\n");

    const scriptSrcs = Array.from(doc.querySelectorAll("script[src]"))
      .map((el) => el.getAttribute("src") ?? "")
      .filter(Boolean);
    const linkHrefs = Array.from(doc.querySelectorAll("link[href]"))
      .map((el) => el.getAttribute("href") ?? "")
      .filter(Boolean);
    const assetUrls = [...scriptSrcs, ...linkHrefs].join("\n");

    // Handling: the query anywhere in markup (a <style>, a matchMedia call, a <source media>).
    let handled = REDUCED_MOTION.test(html);

    // Stylesheets this page references.
    const motionSheets = new Map<string, StylesheetMotionData>();
    for (const s of ctx.site?.stylesheetMotion ?? []) motionSheets.set(s.url, s);
    let unreadSheets = 0;
    let cssInfinite = stylesheetMotionOf(inlineCss).hasInfiniteAnimation;
    let cssSmooth = stylesheetMotionOf(inlineCss).hasSmoothScroll;
    let cssSource = cssInfinite || cssSmooth ? "inline <style>" : "";
    for (const el of doc.querySelectorAll("link[href]")) {
      const rel = (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
      if (!rel.includes("stylesheet")) continue;
      const media = el.getAttribute("media");
      if (media && /print/i.test(media) && !/screen|all/i.test(media)) continue;
      const abs = resolve(el.getAttribute("href") ?? "", pageUrl);
      if (!abs) continue;
      const sheet = motionSheets.get(abs);
      if (!sheet || !sheet.read) {
        unreadSheets++;
        continue;
      }
      if (sheet.mentionsReducedMotion) handled = true;
      if (sheet.hasInfiniteAnimation && !cssInfinite) {
        cssInfinite = true;
        cssSource ||= shownUrl(abs);
      }
      if (sheet.hasSmoothScroll && !cssSmooth) {
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
      if (s.sourcePages.includes(ctx.page.url) || s.sourcePages.includes(pageUrl)) {
        if (REDUCED_MOTION.test(s.content)) handled = true;
      }
    }

    // Motion signals.
    const sources: Source[] = [];
    const add = (key: string, label: string, viaScript: boolean, trigger: string) => {
      if (!sources.some((s) => s.key === key)) sources.push({ key, label, viaScript, trigger });
    };

    if (attrHas(html, /\bdata-aos\b/i) || /(^|[/.@-])aos(\.min)?\.(js|css)\b|\/aos@/i.test(assetUrls)) {
      add("aos", "AOS scroll animations", true, "data-aos");
    }
    if (/scrolltrigger/i.test(assetUrls) || /\bScrollTrigger\b/.test(scriptText)) {
      add("gsap-scrolltrigger", "GSAP ScrollTrigger animations", true, "ScrollTrigger");
    }
    if (doc.querySelector("lottie-player, dotlottie-player, dotlottie-wc") || /lottie/i.test(assetUrls)) {
      add("lottie", "Lottie animations", true, "lottie-player");
    }
    if (
      /animate\.(min\.)?css|wow(\.min)?\.js/i.test(assetUrls) ||
      (doc.querySelector(".wow") && doc.querySelector("[class*='animate__'], .animated"))
    ) {
      add("animate-wow", "animate.css / WOW.js animations", true, "animate.css");
    }
    if (
      attrHas(html, /\bdata-(parallax|jarallax|rellax)\b/i) ||
      /rellax|jarallax|parallax/i.test(assetUrls) ||
      doc.querySelector(".rellax, .jarallax")
    ) {
      add("parallax", "Parallax scrolling", true, "parallax");
    }
    if (/locomotive-scroll|lenis/i.test(assetUrls) || /new\s+(LocomotiveScroll|Lenis)\s*\(/.test(scriptText)) {
      add("smooth-scroll-lib", "Locomotive Scroll or Lenis smooth scrolling", true, "scroll library");
    }
    const autoplayAttr = Array.from(doc.querySelectorAll("[data-autoplay]")).some((el) => {
      const v = (el.getAttribute("data-autoplay") ?? "").trim().toLowerCase();
      return v !== "false" && v !== "0" && v !== "off";
    });
    const dataLib = /\bdata-(slick|splide|swiper|flickity|owl)[a-z-]*\s*=\s*(["'])[^"']*["']?autoplay["']?\s*:\s*(true|\{|\d)/i.test(
      html,
    );
    const scriptAutoplay =
      /(new\s+(Swiper|Splide|Flickity)\s*\(|\.slick\s*\(|\.owlCarousel\s*\()/.test(scriptText) &&
      /autoplay\s*:\s*(true|\{|\d)|autoPlay\s*:\s*(true|\d)/.test(scriptText);
    if (autoplayAttr || dataLib || scriptAutoplay) {
      add("carousel-autoplay", "Auto-advancing carousel", true, "autoplay");
    }
    if (doc.querySelector("marquee")) add("marquee", "<marquee> scrolling text", false, "<marquee>");
    for (const v of doc.querySelectorAll("video[autoplay]")) {
      if (v.hasAttribute("loop") || !v.hasAttribute("controls")) {
        add("autoplay-video", "Autoplaying video", false, "<video autoplay>");
        break;
      }
    }
    if (cssInfinite) add("css-infinite-animation", "Looping CSS animation", false, cssSource || "infinite animation");
    if (cssSmooth) add("css-smooth-scroll", "Smooth scrolling (scroll-behavior: smooth)", false, cssSource || "scroll-behavior");

    if (sources.length === 0 || handled) {
      return {
        checks: [
          {
            name: "reduced-motion",
            status: "pass",
            message: sources.length === 0 ? "No motion that needs reduced-motion handling" : "Reduced-motion handling found",
          },
        ],
      };
    }

    const checks: CheckResult[] = [];
    for (const source of sources) {
      const partial = unreadSheets > 0 || (source.viaScript && unreadScripts > 0);
      const reasons: string[] = [];
      if (unreadSheets > 0) reasons.push(`${unreadSheets} referenced stylesheet${unreadSheets === 1 ? "" : "s"} not read`);
      if (source.viaScript && unreadScripts > 0) {
        reasons.push(`${unreadScripts} same-site script${unreadScripts === 1 ? "" : "s"} not read`);
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
