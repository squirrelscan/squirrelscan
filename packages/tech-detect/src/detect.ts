import type { DetectedTechnology, Detector, TechDetectInput, TechFingerprint } from "./types";
import { ALL_FINGERPRINTS } from "./fingerprints";
import { inString, scanJs, type ScannedJs } from "./js-scan";

/**
 * Default wall-clock budget for one detectTechnologies call (one page). A caller
 * that reads whole bundles (the local scan) passes a longer one; running out of
 * time is reported through `onBudgetExceeded`, never silent.
 */
export const TECH_DETECT_PAGE_BUDGET_MS = 5_000;

/**
 * Candidate matches an `inCode` detector inspects before giving up. A candidate is
 * a pattern match that starts inside a string or comment (a docs snippet, a
 * product named in prose): a big bundle holds many before the real one.
 */
const MAX_IN_CODE_CANDIDATES = 64;

/**
 * Longest slice of one script body a caller gets matched, in characters, unless it asks for more
 * (`DetectOptions.maxScriptChars`). The cloud services that run this package over bodies a client
 * sent, and over a hostile audited site's bundles, rely on it: only the local scan, which reads
 * what the user's own crawl fetched, passes a larger value.
 */
export const TECH_SCRIPT_CONTENT_LIMIT = 256 * 1024;

export interface DetectOptions {
  /** Stop evaluating fingerprints once this much time has passed. */
  budgetMs?: number;
  /** Match at most this many characters of each script body; default {@link TECH_SCRIPT_CONTENT_LIMIT}. */
  maxScriptChars?: number;
  /** Called once when the budget cut the scan short. */
  onBudgetExceeded?: () => void;
}

interface ScriptView {
  head: string;
  scanned?: ScannedJs;
}

function scriptView(views: Map<string, ScriptView>, content: string, maxChars: number): ScriptView {
  let view = views.get(content);
  if (!view) {
    view = { head: content.length > maxChars ? content.slice(0, maxChars) : content };
    views.set(content, view);
  }
  return view;
}

function matchesInCode(pattern: RegExp, view: ScriptView): boolean {
  view.scanned ??= scanJs(view.head);
  const { code, strings } = view.scanned;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  for (let seen = 0; seen < MAX_IN_CODE_CANDIDATES; seen++) {
    const m = re.exec(code);
    if (!m) return false;
    if (!inString(strings, m.index)) return true;
    if (m[0].length === 0) re.lastIndex++;
  }
  return false;
}

/** Remove `<!-- ... -->` comments in one pass; an unterminated one is kept as is. */
function stripHtmlComments(html: string): string {
  let out = "";
  let pos = 0;
  for (;;) {
    const open = html.indexOf("<!--", pos);
    if (open === -1) break;
    const close = html.indexOf("-->", open + 4);
    if (close === -1) break;
    out += html.slice(pos, open);
    pos = close + 3;
  }
  return out + html.slice(pos);
}

/**
 * What `pageMarkup` keeps of a page: the tags that can name a script or a tracking URL (`script`, `link`,
 * `img`, `iframe`, `embed`, `object`, `source`), as written, and the text of each JavaScript `<script>` that
 * is short enough to be a loader snippet. Not kept: text between tags, comments, `<a>` and `<meta>` (a vendor
 * linked or described is not a vendor loaded), data blocks (`application/json`, JSON-LD, `__NEXT_DATA__`) and
 * the body of a script past {@link INLINE_LOADER_MAX_CHARS} unless it is a Next.js flight payload (a whole inlined bundle names many URLs in strings
 * it never loads).
 */
const URL_TAGS = new Set(["script", "link", "img", "iframe", "embed", "object", "source"]);
const INLINE_LOADER_MAX_CHARS = 16 * 1024;
/**
 * Script types that hold data, not code the browser runs: JSON (JSON-LD, `__NEXT_DATA__`, `__nuxt_data__`), import
 * maps, speculation rules and templates. Every other type is read: a cache or CDN wraps a loader in its own type
 * to defer it (`litespeed/javascript`, Cloudflare Rocket Loader's `<hash>-text/javascript`, Partytown, a consent
 * tool's `text/plain`) and the browser runs it all the same.
 */
const DATA_SCRIPT_TYPE = /json|importmap|speculationrules|template|^text\/(?:html|css|markdown|csv|xml)\b|^application\/(?:xml|xhtml)/i;
/**
 * A Next.js App Router flight script (`self.__next_f.push(...)`) carries the layout's `next/script` snippets as
 * strings, so it is read well past {@link INLINE_LOADER_MAX_CHARS}; any other script over the cap is a bundle.
 */
const FLIGHT_SCRIPT_START = /^\s*\(?\s*self\.__next_(?:f|s)\b/;
const FLIGHT_SCRIPT_MAX_CHARS = 2 * 1024 * 1024;
/** Inline script text read per page, all scripts together. */
const INLINE_TEXT_BUDGET = 8 * 1024 * 1024;
/** Longest tag read quote-aware; past it the first `>` ends the tag. */
const MAX_TAG_CHARS = 64 * 1024;

/** The index of the `>` that ends the tag starting at `open`, skipping quoted attribute values. */
function tagEnd(html: string, open: number): number {
  const limit = Math.min(html.length, open + MAX_TAG_CHARS);
  let i = open + 1;
  while (i < limit) {
    const ch = html.charCodeAt(i);
    if (ch === 62) return i; // >
    if (ch === 34 || ch === 39) {
      const close = html.indexOf(ch === 34 ? '"' : "'", i + 1);
      if (close === -1 || close >= limit) break;
      i = close + 1;
      continue;
    }
    i++;
  }
  return html.indexOf(">", open + 1);
}

function attributeValue(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

let lastMarkup: { html: string; markup: string } | undefined;

export function pageMarkup(html: string): string {
  if (lastMarkup?.html === html) return lastMarkup.markup;
  const parts: string[] = [];
  const scriptEnd = /<\/script/gi;
  let inlineText = 0;
  let pos = 0;
  for (;;) {
    const open = html.indexOf("<", pos);
    if (open === -1) break;
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      if (close === -1) break;
      pos = close + 3;
      continue;
    }
    const close = tagEnd(html, open);
    if (close === -1) {
      const rest = html.slice(open);
      const lone = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest)?.[1]?.toLowerCase();
      if (lone && URL_TAGS.has(lone)) parts.push(rest);
      break;
    }
    const tag = html.slice(open, close + 1);
    pos = close + 1;
    const name = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag);
    if (!name || name[1] === "/") continue;
    const tagName = name[2]!.toLowerCase();
    if (tagName === "script" && !tag.endsWith("/>")) {
      scriptEnd.lastIndex = pos;
      const end = scriptEnd.exec(html)?.index ?? html.length;
      parts.push(tag);
      const type = attributeValue(tag, "type")?.trim() ?? "";
      const length = end - pos;
      if (length > 0 && !DATA_SCRIPT_TYPE.test(type) && inlineText + length <= INLINE_TEXT_BUDGET) {
        const body = html.slice(pos, end);
        if (length <= INLINE_LOADER_MAX_CHARS || (length <= FLIGHT_SCRIPT_MAX_CHARS && FLIGHT_SCRIPT_START.test(body.slice(0, 64)))) {
          parts.push(body);
          inlineText += length;
        }
      }
      pos = end;
    } else if (URL_TAGS.has(tagName)) {
      parts.push(tag);
    }
  }
  const markup = parts.join("\n");
  lastMarkup = { html, markup };
  return markup;
}

function matchDetector(
  detector: Detector,
  input: TechDetectInput,
  html: string,
  views: Map<string, ScriptView>,
  maxChars: number,
): boolean {
  switch (detector.type) {
    case "header": {
      const value = input.headers[detector.name] ?? input.headers[detector.name.toLowerCase()];
      return value != null && detector.pattern.test(value);
    }
    case "meta": {
      const value = input.meta?.[detector.name] ?? input.meta?.[detector.name.toLowerCase()];
      return value != null && detector.pattern.test(value);
    }
    case "script-url":
      // The listed URLs, and the page's own markup: an inline loader builds its URL inside a `<script>` and
      // has no `src` to list. The same page gives the same answer with or without script bodies attached.
      if (input.scripts?.some((s) => s.url && detector.pattern.test(s.url))) return true;
      return detector.pattern.test(pageMarkup(html));
    case "script-content":
      if (detector.inCode) {
        return (
          input.scripts?.some(
            (s) =>
              s.content &&
              matchesInCode(detector.pattern, scriptView(views, s.content, maxChars)) &&
              (!detector.also || detector.also.pattern.test(scriptView(views, s.content, maxChars).head)),
          ) ?? false
        );
      }
      if (
        input.scripts?.some(
          (s) => s.content && detector.pattern.test(scriptView(views, s.content, maxChars).head),
        )
      ) {
        return true;
      }
      // Inline scripts live in the HTML, not the fetched `scripts` array — scan
      // it too so inline init snippets (window._taboola=…, obApi(…)) match.
      // Patterns are JS-specific (global assignments / vendor calls), so the
      // false-positive risk from scanning full HTML is negligible.
      return detector.pattern.test(html);
    case "html":
      if (detector.requires && !html.includes(detector.requires)) return false;
      return detector.pattern.test(html);
    case "dom":
      // DOM selectors need a document — skip in headerless detection
      return false;
    case "url-path":
      // Match the page URL first, then fall back to the HTML. The HTML fallback
      // is intentional: url-path patterns are specific path SEGMENTS (e.g.
      // /wp-json/, /sites/default/files/, /media/jui/) that real fingerprints
      // rely on finding in asset/link URLs embedded in the markup — the page URL
      // itself rarely carries them. Patterns are deliberately narrow segments,
      // not bare words, to keep the HTML scan low-false-positive.
      return detector.pattern.test(input.url) || detector.pattern.test(html);
  }
}

function detectorLabel(detector: Detector): string {
  switch (detector.type) {
    case "header":
      return `header:${detector.name}`;
    case "meta":
      return `meta:${detector.name}`;
    case "script-url":
      return `script-url:${detector.pattern.source.slice(0, 30)}`;
    case "script-content":
      return `script-content:${detector.pattern.source.slice(0, 30)}`;
    case "html":
      return `html:${detector.pattern.source.slice(0, 30)}`;
    case "dom":
      return `dom:${detector.selector}`;
    case "url-path":
      return `url-path:${detector.pattern.source.slice(0, 30)}`;
  }
}

// Patterns like `[\d.]+` happily capture a bare "." from prose ("built with
// Next.js."). A version must contain at least one digit.
function validVersion(match: RegExpMatchArray | null): string | null {
  return match?.[1] && /\d/.test(match[1]) ? match[1] : null;
}

function extractVersion(fingerprint: TechFingerprint, input: TechDetectInput): string | null {
  if (!fingerprint.versionPattern) return null;

  // Check headers
  for (const value of Object.values(input.headers)) {
    const version = validVersion(value.match(fingerprint.versionPattern));
    if (version) return version;
  }

  // Check meta tags
  if (input.meta) {
    for (const value of Object.values(input.meta)) {
      const version = validVersion(value.match(fingerprint.versionPattern));
      if (version) return version;
    }
  }

  // Check HTML — sampled to the first 50KB. Version strings (generator meta,
  // header comments, bundle banners) live near the top of the document; the cap
  // bounds the regex work without missing them in practice.
  const htmlSample = input.html.slice(0, 51200);
  const htmlVersion = validVersion(htmlSample.match(fingerprint.versionPattern));
  if (htmlVersion) return htmlVersion;

  // Check script URLs and content
  if (input.scripts) {
    for (const script of input.scripts) {
      if (script.url) {
        const version = validVersion(script.url.match(fingerprint.versionPattern));
        if (version) return version;
      }
      if (script.content) {
        const version = validVersion(
          script.content.slice(0, 10240).match(fingerprint.versionPattern),
        );
        if (version) return version;
      }
    }
  }

  return null;
}

/**
 * Parse `<meta name=… content=…>` tags from the head sample into a name→content
 * map. `meta`-type detectors (e.g. `generator` → WordPress/Wix/Shopify) read ONLY
 * this map, never the raw HTML — so callers that don't pre-parse meta (the CLI's
 * local scan, cloud-runner's fallback) would silently miss every CMS whose primary
 * signal is the generator tag. Auto-extracting here closes that gap (#407). Both
 * attribute orders are handled — some CMSes emit `content=… name=generator`.
 */
function extractMetaFromHtml(html: string): Record<string, string> {
  // Object.create(null): `name` is page-controlled, so on a plain object the
  // `key in out` guard below would be true for `constructor`/`__proto__` from
  // the prototype chain and drop those tags before they reach a detector.
  const out: Record<string, string> = Object.create(null);
  // Quoted attributes only — unquoted generator tags are vanishingly rare.
  const sample = html.slice(0, 51200);
  const tagRe = /<meta\b[^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(sample)) !== null) {
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1];
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag[0])?.[1];
    if (name && content !== undefined) {
      const key = name.toLowerCase();
      if (!(key in out)) out[key] = content;
    }
  }
  return out;
}

/** Detect technologies from page data. Returns all matches. */
export function detectTechnologies(
  rawInput: TechDetectInput,
  fingerprints: TechFingerprint[] = ALL_FINGERPRINTS,
  options: DetectOptions = {},
): DetectedTechnology[] {
  const results: DetectedTechnology[] = [];
  const views = new Map<string, ScriptView>();
  const maxChars = options.maxScriptChars ?? TECH_SCRIPT_CONTENT_LIMIT;
  const deadline = performance.now() + (options.budgetMs ?? TECH_DETECT_PAGE_BUDGET_MS);

  // Resolve the meta map: trust a non-empty caller-supplied one, otherwise parse
  // it from the HTML so meta-type detectors fire without a separate parse step.
  const input: TechDetectInput =
    rawInput.meta && Object.keys(rawInput.meta).length > 0
      ? rawInput
      : { ...rawInput, meta: extractMetaFromHtml(rawInput.html) };

  // Linear scan; computed once and only for fingerprints that ask for it.
  let markupHtml: string | null = null;

  for (const fp of fingerprints) {
    if (performance.now() > deadline) {
      options.onBudgetExceeded?.();
      break;
    }
    let matchedDetector: Detector | null = null;
    let html = input.html;
    if (fp.ignoreComments) {
      markupHtml ??= stripHtmlComments(input.html);
      html = markupHtml;
    }

    for (const detector of fp.detectors) {
      if (matchDetector(detector, input, html, views, maxChars)) {
        matchedDetector = detector;
        break; // ANY match = detected
      }
    }

    if (matchedDetector) {
      results.push({
        id: fp.id,
        name: fp.name,
        category: fp.category,
        version: extractVersion(fp, input),
        confidence: fp.confidence ?? "high",
        detectedBy: detectorLabel(matchedDetector),
        website: fp.website,
        icon: fp.icon,
      });
    }
  }

  // A fingerprint that another detection explains (a shared backend an AI app
  // builder loads for every app) is dropped, not reported as a second stack.
  const found = new Set(results.map((r) => r.id));
  const suppressed = new Set(
    fingerprints
      .filter((fp) => fp.unlessAny?.some((id) => found.has(id)))
      .map((fp) => fp.id),
  );
  return suppressed.size ? results.filter((r) => !suppressed.has(r.id)) : results;
}
