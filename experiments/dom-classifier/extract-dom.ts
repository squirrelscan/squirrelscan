#!/usr/bin/env bun
/**
 * Canonical production-DOM extraction for the private corpus builder.
 *
 * Reads JSONL from stdin and writes only structural facts plus bounded-by-caller text.
 * Raw HTML is never written to disk and the Python caller performs final redaction.
 */
import { getAttrCI, hasAttrCI } from "../../packages/utils/src/dom.ts";
import { getDomain } from "../../packages/crawler/node_modules/tldts";
import { parseHTML } from "../../packages/parser/src/dom.ts";
import { isInSiteChrome } from "../../packages/parser/src/extractors/chrome.ts";
import { getCleanTextContent, getMainContent } from "../../packages/parser/src/extractors/content.ts";
import { collectTextExcluding } from "../../packages/parser/src/extractors/dom-text.ts";
import type { Element } from "linkedom";

const skipTags = new Set(["script", "style", "template", "noscript", "svg", "canvas", "iframe", "object", "embed"]);
// Text-only exclusions. Kept separate from skipTags so candidate selection is
// unchanged: these tags carry markup that is never visible prose.
const textSkipTags = new Set([...skipTags, "head", "title", "link", "meta", "base", "math", "map", "area", "track", "source", "param"]);
const allowedRoles = new Set(["banner", "complementary", "contentinfo", "form", "main", "navigation", "region", "search", "dialog", "alertdialog", "article", "list", "listitem", "tablist", "menu", "menubar", "toolbar", "feed"]);
const containerTags = new Set(["article", "aside", "dialog", "footer", "form", "header", "main", "nav", "section", "figure", "table", "ul", "ol", "div", "details", "fieldset"]);
// Elements that legitimately carry no text, so their meaning lives in attributes.
const mediaTags = new Set(["img", "iframe", "video", "audio", "svg", "input", "embed", "object", "canvas", "picture", "source"]);
// Attributes that describe an element a user cannot read as text. `src` is
// deliberately absent: only a non-identifying category is emitted, by srcCategory.
const semanticAttributeNames = ["title", "aria-label", "role", "alt", "type", "name", "placeholder"] as const;

type Input = { kind?: "page"; pageId: string; siteId: string; pageProvenance: unknown; url: string; html: string } | { kind: "domain"; host: string };

function tag(element: Element): string { return element.tagName.toLowerCase(); }

function hidden(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = (getAttrCI(current, "style") ?? "").replaceAll(" ", "").toLowerCase();
    if (hasAttrCI(current, "hidden") || getAttrCI(current, "aria-hidden")?.toLowerCase() === "true" || style.includes("display:none") || style.includes("visibility:hidden")) return true;
  }
  return false;
}

// Schemes that may be followed. Anything else with a scheme is unsafe, so a
// new dangerous scheme cannot be missed the way a denylist missed vbscript:.
const navigableSchemes = new Set(["http", "https"]);
// Categorised separately: not navigable, but not a script sink either.
const contactSchemes = new Set(["mailto", "tel"]);

function hrefCategory(raw: string | null, pageUrl: string): string {
  if (!raw) return "none";
  // Browsers strip ASCII whitespace and control characters before reading the
  // scheme, so `java\tscript:alert(1)` navigates as javascript:. Strip them
  // here too, or the scheme test sees a different string than the browser.
  const value = raw.replace(/[\u0000- ]/g, "").toLowerCase();
  if (raw.trim().startsWith("#")) return "anchor";
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(value)?.[1];
  if (!scheme) return "relative";
  if (contactSchemes.has(scheme)) return scheme;
  if (!navigableSchemes.has(scheme)) return "unsafe";
  try {
    const target = new URL(raw, pageUrl);
    return target.hostname === new URL(pageUrl).hostname ? "same_site" : "external";
  } catch { return "other"; }
}

function ancestors(element: Element): Element[] {
  const result: Element[] = [];
  for (let current = element.parentElement; current; current = current.parentElement) result.push(current);
  return result;
}

function locator(element: Element): string {
  const parts: string[] = [];
  for (let current: Element | null = element; current; current = current.parentElement) {
    const siblings = current.parentElement ? Array.from(current.parentElement.children).filter((item) => tag(item as Element) === tag(current)) : [current];
    parts.push(`${tag(current)}[${Math.max(0, siblings.indexOf(current))}]`);
  }
  return parts.reverse().join("/");
}

function curatedTokens(element: Element, attribute: "class" | "id"): string[] {
  const value = getAttrCI(element, attribute) ?? "";
  return value.toLowerCase().split(/[^a-z0-9_-]+/).filter((token) => /^[a-z][a-z0-9_-]{1,40}$/.test(token) && !/(token|secret|password|passwd|auth|key)/.test(token)).slice(0, 12);
}

function context(element: Element, role: string | null): string {
  const nodes = [element, ...ancestors(element)];
  const tags = new Set(nodes.map(tag));
  const roles = new Set(nodes.map((item) => getAttrCI(item, "role")?.toLowerCase()));
  if (tags.has("article") || roles.has("article")) return "article";
  if (tags.has("main") || roles.has("main")) return "main";
  if (tags.has("header") || roles.has("banner")) return "header";
  if (tags.has("footer") || roles.has("contentinfo")) return "footer";
  if (tags.has("body") || tags.has("html")) return "site";
  return role === "main" ? "main" : "unknown";
}

const BLOCK_MARK = "\u0000css\u0000";
// Element names a CSS type selector may use. A bare word that is not one of
// these is prose, which is what stops the selector scan from eating a sentence.
const selectorTypeTags = new Set([
  "a", "abbr", "address", "article", "aside", "audio", "b", "blockquote", "body", "button", "canvas",
  "caption", "cite", "code", "col", "dd", "details", "dialog", "div", "dl", "dt", "em", "embed",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hr", "html", "i", "iframe", "img", "input", "label", "legend", "li", "main", "mark", "menu", "nav",
  "object", "ol", "optgroup", "option", "output", "p", "picture", "pre", "progress", "q", "s",
  "section", "select", "small", "span", "strong", "sub", "summary", "sup", "svg", "table", "tbody",
  "td", "textarea", "tfoot", "th", "thead", "time", "tr", "u", "ul", "video",
]);

/**
 * A CSS declaration list, or the blank residue of an already-emptied at-rule.
 *
 * A quoted key means JSON, not CSS. Docs and blog pages legitimately show JSON
 * objects as visible prose, and dropping those would delete real content: CSS
 * property names are never quoted, so that is the discriminator.
 */
function isDeclarationBody(body: string): boolean {
  if (body.includes(BLOCK_MARK)) {
    // An at-rule whose inner rules an earlier pass already marked. What remains
    // beside the marks is the inner selector, never prose.
    const rest = body.replaceAll(BLOCK_MARK, " ").trim();
    return rest === "" || rest.split(/\s+/).every(isSelectorToken);
  }
  if (body.trim() === "") return true;
  if (/["'][^"']{0,80}["']\s*:/.test(body)) return false;
  return /(?:^|[;{\s])[-a-zA-Z][-a-zA-Z0-9]*\s*:\s*[^;{}]/.test(body);
}

/** Remove the trailing selector tokens of `prelude`, stopping at the first prose word. */
function dropSelectorSuffix(prelude: string): string {
  const atRule = prelude.search(/@[a-z-]+/i);
  if (atRule >= 0 && !/[.;]\s/.test(prelude.slice(atRule))) return prelude.slice(0, atRule);
  const tokens = prelude.split(/(\s+)/);
  while (tokens.length > 0) {
    const last = tokens[tokens.length - 1] ?? "";
    if (last.trim() === "") { tokens.pop(); continue; }
    if (!isSelectorToken(last.trim())) break;
    tokens.pop();
  }
  return tokens.join("");
}

/** A single whitespace-delimited piece of a selector, never a prose word. */
function isSelectorToken(token: string): boolean {
  if (/^[>+~,*]$/.test(token)) return true;
  if (/^[.#:[*]/.test(token)) return true;
  const type = token.split(/[.#:[]/)[0]?.toLowerCase() ?? "";
  return type !== token.toLowerCase() && selectorTypeTags.has(type);
}

/**
 * Remove stylesheet residue that reached a text node.
 *
 * Skipping <script>/<style> is not enough on its own: CMS and consent vendors
 * write rule text into ordinary elements, and that residue then reads to the
 * model as prose. Removal is anchored on a brace block that actually holds
 * declarations, and the selector in front of it is stripped token by token,
 * stopping at the first word that is not selector-shaped. So ".NET", "#1
 * seller" and "the {braces} guide" all survive untouched, while
 * "#wrap .promo{margin:0}" does not. Passes run innermost-first because
 * at-rules nest one level.
 */
function stripStyleResidue(value: string): string {
  let result = value;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = result.replace(/\{([^{}]{0,4000})\}/g, (match, body: string) => (isDeclarationBody(body) ? BLOCK_MARK : match));
    if (next === result) break;
    result = next;
  }
  if (result.includes(BLOCK_MARK)) {
    // Drop each marked block along with the selector or at-rule prelude in
    // front of it, then collapse what is left.
    result = result.replaceAll(
      new RegExp(`([^\\n]{0,300}?)(?:${BLOCK_MARK}\\s*)+`, "g"),
      (_match, prelude: string) => `${dropSelectorSuffix(prelude)} `,
    );
  }
  // A capture truncated mid-rule leaves a block that never closes, which the
  // balanced passes above cannot see. Callers bound text length, so this is the
  // normal shape of residue near the cut, not an edge case.
  const unterminated = result.indexOf("{");
  if (unterminated >= 0 && !result.includes("}", unterminated)) {
    const tail = result.slice(unterminated + 1);
    if (tail.trim() !== "" && isDeclarationBody(tail)) result = dropSelectorSuffix(result.slice(0, unterminated));
  }
  // The at-rules that carry no block of their own, so nothing above sees them.
  return result.replace(/@(?:import|charset|namespace)\b[^;{}\n]{0,200};?/gi, " ");
}

function text(element: Element): string {
  const raw = collectTextExcluding(element, (item) => textSkipTags.has(tag(item)) || hidden(item), " ");
  return stripStyleResidue(raw).replace(/\s+/g, " ").trim();
}

// Known embed providers, matched on the registrable domain of a src. Knowing
// that a frame is a YouTube player or a reCAPTCHA widget is the whole signal;
// the host itself is never emitted.
const embedProviders = new Map<string, string>(Object.entries({
  "youtube.com": "youtube", "youtu.be": "youtube", "youtube-nocookie.com": "youtube",
  "ytimg.com": "youtube", "vimeo.com": "vimeo", "vimeocdn.com": "vimeo",
  "wistia.com": "wistia", "wistia.net": "wistia", "loom.com": "loom",
  "dailymotion.com": "dailymotion", "brightcove.net": "brightcove", "jwplayer.com": "jwplayer",
  "spotify.com": "spotify", "scdn.co": "spotify", "soundcloud.com": "soundcloud",
  "sndcdn.com": "soundcloud", "twitter.com": "twitter", "x.com": "twitter",
  "twimg.com": "twitter", "facebook.com": "facebook", "fbcdn.net": "facebook",
  "instagram.com": "instagram", "cdninstagram.com": "instagram", "tiktok.com": "tiktok",
  "linkedin.com": "linkedin", "licdn.com": "linkedin", "pinterest.com": "pinterest",
  "reddit.com": "reddit", "redditmedia.com": "reddit",
  "google.com": "google", "gstatic.com": "google", "googleapis.com": "google",
  "googleusercontent.com": "google", "ggpht.com": "google",
  "google-analytics.com": "google-analytics", "googletagmanager.com": "google-tag-manager",
  "doubleclick.net": "google-ads", "googlesyndication.com": "google-ads",
  "stripe.com": "stripe", "stripecdn.com": "stripe", "paypal.com": "paypal",
  "paypalobjects.com": "paypal", "recaptcha.net": "recaptcha", "hcaptcha.com": "hcaptcha",
  "cloudflare.com": "cloudflare", "cloudflareinsights.com": "cloudflare",
  "typeform.com": "typeform", "calendly.com": "calendly", "hubspot.com": "hubspot",
  "hs-scripts.com": "hubspot", "hsforms.net": "hubspot", "hubspotusercontent.com": "hubspot",
  "intercom.io": "intercom", "intercomcdn.com": "intercom", "disqus.com": "disqus",
  "zendesk.com": "zendesk", "zdassets.com": "zendesk", "drift.com": "drift",
  "mailchimp.com": "mailchimp", "list-manage.com": "mailchimp", "klaviyo.com": "klaviyo",
  "shopify.com": "shopify", "shopifycdn.com": "shopify", "squarespace.com": "squarespace",
  "wix.com": "wix", "wixstatic.com": "wix", "wp.com": "wordpress", "gravatar.com": "gravatar",
  "github.com": "github", "githubusercontent.com": "github", "codepen.io": "codepen",
  "jsfiddle.net": "jsfiddle", "codesandbox.io": "codesandbox", "figma.com": "figma",
  "canva.com": "canva", "airtable.com": "airtable", "notion.so": "notion",
  "cloudinary.com": "cloudinary", "imgix.net": "imgix", "unsplash.com": "unsplash",
  "giphy.com": "giphy", "imgur.com": "imgur", "amazonaws.com": "aws",
  "openstreetmap.org": "openstreetmap", "mapbox.com": "mapbox", "trustpilot.com": "trustpilot",
  "algolia.net": "algolia", "onetrust.com": "onetrust", "cookielaw.org": "onetrust",
  "cookiebot.com": "cookiebot", "usercentrics.eu": "usercentrics", "vidyard.com": "vidyard",
}));
/** Every value srcCategory can take, besides a provider slug. */
const SAME_SITE = "same-site";
const OTHER_THIRD_PARTY = "other-third-party";

/**
 * Where an element's `src` points, as a category.
 *
 * A first-party host identifies the site, which packets deliberately hide, so
 * no hostname is ever emitted. A Google Maps frame and a first-party image are
 * still distinguishable, which is what the label needs.
 */
function srcCategory(element: Element, pageUrl: string): string | null {
  const raw = getAttrCI(element, "src") ?? getAttrCI(element, "data-src");
  if (!raw || raw.trim().startsWith("data:")) return null;
  let host: string;
  try {
    host = new URL(raw, pageUrl).hostname;
  } catch {
    return null;
  }
  if (!host) return null;
  const site = getDomain(host);
  let pageSite: string | null = null;
  try {
    pageSite = getDomain(new URL(pageUrl).hostname);
  } catch {
    pageSite = null;
  }
  if (site && pageSite && site === pageSite) return SAME_SITE;
  // google.com covers Maps, Docs and Forms embeds; the path says which, and the
  // path is not something this step is willing to carry.
  return (site && embedProviders.get(site)) ?? OTHER_THIRD_PARTY;
}

/** The readable attributes of an element whose meaning is not in its text. */
function semanticAttributes(element: Element): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of semanticAttributeNames) {
    const value = getAttrCI(element, name)?.replace(/\s+/g, " ").trim();
    if (value) result[name] = value.slice(0, 200);
  }
  return result;
}

/**
 * A compact "what is inside this" string, e.g. `div*4>a*3,img`. An empty
 * container is otherwise indistinguishable from any other empty container.
 */
function structureSummary(counts: Record<string, number>, ownTag: string): string {
  return Object.entries(counts)
    .filter(([name]) => name !== ownTag)
    .sort(([leftName, leftCount], [rightName, rightCount]) => rightCount - leftCount || leftName.localeCompare(rightName))
    .slice(0, 8)
    .map(([name, count]) => (count > 1 ? `${name}*${count}` : name))
    .join(",");
}

function shape(element: Element, pageUrl: string): Record<string, unknown> {
  const all = [element, ...Array.from(element.querySelectorAll("*")) as Element[]];
  const subtreeTagCounts: Record<string, number> = {};
  for (const item of all) subtreeTagCounts[tag(item)] = (subtreeTagCounts[tag(item)] ?? 0) + 1;
  const parent = element.parentElement;
  const siblings = parent ? Array.from(parent.children) as Element[] : [];
  const children = Array.from(element.children) as Element[];
  const previous = siblings[siblings.indexOf(element) - 1];
  const next = siblings[siblings.indexOf(element) + 1];
  const siblingPattern = JSON.stringify({ tag: tag(element), children: children.slice(0, 6).map(tag) });
  // Hoisted: collectTextExcluding walks the whole subtree, and this value is
  // read four times below.
  const ownText = text(element);
  const linkCategories: Record<string, number> = {};
  for (const child of children.filter((item) => tag(item) === "a")) {
    const category = hrefCategory(getAttrCI(child, "href"), pageUrl);
    linkCategories[category] = (linkCategories[category] ?? 0) + 1;
  }
  return {
    tag: tag(element),
    roles: [getAttrCI(element, "role")?.toLowerCase(), ...ancestors(element).slice(0, 3).map((item) => getAttrCI(item, "role")?.toLowerCase())].filter((value): value is string => !!value && allowedRoles.has(value)),
    context: context(element, getAttrCI(element, "role")?.toLowerCase() ?? null),
    ancestorTags: ancestors(element).slice(0, 4).reverse().map(tag),
    siblingPosition: Math.max(0, siblings.indexOf(element)),
    siblingCount: siblings.length,
    childCount: children.length,
    childTags: children.slice(0, 12).map(tag),
    subtreeTagCounts,
    linkCategories,
    text: ownText,
    contextText: [previous, next].filter((item): item is Element => !!item).map(text).join(" "),
    locator: locator(element),
    semanticAncestorChain: [element, ...ancestors(element)].slice(0, 6).map((item) => ({ tag: tag(item), role: getAttrCI(item, "role")?.toLowerCase() ?? null })),
    classTokens: curatedTokens(element, "class"),
    idTokens: curatedTokens(element, "id"),
    textWordCount: ownText.split(/\s+/).filter(Boolean).length,
    // Additive fields: an element with no readable text still has to say
    // something, or it reaches the model as a bare tag plus ancestors.
    emptyText: ownText.length === 0,
    semanticAttributes: semanticAttributes(element),
    srcCategory: srcCategory(element, pageUrl),
    structureSummary: structureSummary(subtreeTagCounts, tag(element)),
    mediaDescendants: all
      .filter((item) => item !== element && mediaTags.has(tag(item)))
      .slice(0, 6)
      .map((item) => ({ tag: tag(item), attributes: semanticAttributes(item), srcCategory: srcCategory(item, pageUrl) })),
    linkCount: all.filter((item) => tag(item) === "a").length,
    repeatedSiblingPatternCount: siblings.filter((item) => JSON.stringify({ tag: tag(item), children: Array.from(item.children).slice(0, 6).map((child) => tag(child as Element)) }) === siblingPattern).length,
    weakSignals: { inSiteChrome: isInSiteChrome(element), semanticLandmark: ["header", "footer", "nav", "main", "aside", "form"].includes(tag(element)) },
  };
}

export function extractPage(html: string, pageUrl: string): { candidates: Record<string, unknown>[]; pageSignals: Record<string, number> } {
  const { document } = parseHTML(html);
  const all = Array.from(document.querySelectorAll("*")) as Element[];
  const candidates = all.filter((element) => {
    const elementTag = tag(element);
    if (skipTags.has(elementTag) || hidden(element)) return false;
    const nodeText = text(element);
    const role = getAttrCI(element, "role")?.toLowerCase();
    return containerTags.has(elementTag) || allowedRoles.has(role ?? "") || (nodeText.length >= 40 && element.children.length >= 2);
  }).map((element) => shape(element, pageUrl));
  return { candidates, pageSignals: { cleanTextLength: getCleanTextContent(document).length, mainTextLength: getMainContent(document).length } };
}

export { stripStyleResidue, semanticAttributes, srcCategory, structureSummary, text };

// Guarded so the pure helpers above can be imported by tests without this
// module consuming stdin at import time.
if (import.meta.main) {
  const inputText = await Bun.stdin.text();
  for (const line of inputText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const input = JSON.parse(line) as Input;
    if (input.kind === "domain") {
      const domain = getDomain(input.host);
      if (!domain) throw new Error(`tldts could not resolve registrable domain for ${input.host}`);
      process.stdout.write(JSON.stringify({ host: input.host, domain }) + "\n");
      continue;
    }
    const { candidates, pageSignals } = extractPage(input.html, input.url);
    process.stdout.write(JSON.stringify({ pageId: input.pageId, candidates, pageSignals }) + "\n");
  }
}
