// The regions of a page's HTML that a browser does not run or show (#1550), taken out in ONE structural pass.
//
// A detector that reads the page's HTML as text also matches a vendor URL or tag that sits only in content nothing loads: the
// raw text of a JSON, JSON-LD or import-map `<script>`, the inert content of a `<template>`, and an HTML comment that holds
// commented-out code. This pass builds the views the detectors read:
//   - `markup`: the page with `<template>` content taken out, and nothing else. The tag readers (`script-url`, `tag-attr`)
//     read it; they skip comments and data scripts themselves, and an import map's body stays for them.
//   - `clean`: `markup` with the body of every data script taken out and every comment removed: what an `html` detector reads.
//   - `commented`: `clean` with the comments kept, for the fingerprints whose evidence is a marker comment (see
//     {@link COMMENT_MARKER_FINGERPRINTS}).
// Only positive proof takes anything out. A comment that never closes, a `<template>` that never closes, a template that is a
// declarative shadow root (its content is rendered) and a script whose type is not plainly data all stay. `<style>` text is
// CSS evidence and always stays, and the text of `<script>`, `<style>`, `<textarea>` and `<title>` is read as raw text, so
// `<!--` and `<template` inside them are not markup. Linear: every index is visited once and `indexOf` only moves forward.

/** Script types that hold data, not code the browser runs (see `DATA_SCRIPT_TYPE` in detect.ts, the same list). */
const DATA_TYPE =
  /json|importmap|speculationrules|template|x-(?:tmpl|mustache|handlebars|jquery-tmpl|jsrender|underscore|ejs)|shader|octet-stream|^text\/(?:html|css|markdown|csv|xml)\b|^application\/(?:xml|xhtml)/i;

/** Longest tag read quote-aware; past it the first `>` ends the tag. */
const MAX_TAG_CHARS = 64 * 1024;
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);

export interface PageViews {
  markup: string;
  clean: string;
  commented: string;
}

/**
 * The fingerprints whose evidence is a comment the page carries on purpose (a plugin's banner, a template's marker): they read
 * the `commented` view. Explicit, because a comment is otherwise not evidence. A test checks that every fingerprint with a
 * pattern that opens at `<!--` is listed and that every id here exists.
 */
export const COMMENT_MARKER_FINGERPRINTS: ReadonlySet<string> = new Set([
  "wp-rocket",
  "litespeed-cache",
  "w3-total-cache",
  "wp-super-cache",
  "wp-fastest-cache",
  "yoast-seo",
  "rank-math",
  "all-in-one-seo",
  "jekyll",
  "mailchimp",
  // Shopify writes `<!-- BEGIN app block: shopify://apps/klaviyo-email-marketing-sms/... -->` around an app block that is enabled.
  "klaviyo",
  // Font Awesome's banner (`<!--!Font Awesome Free ... by @fontawesome-->`) sits inside the inline SVGs of real use.
  "font-awesome",
]);

function tagEnd(html: string, open: number): number {
  const limit = Math.min(html.length, open + MAX_TAG_CHARS);
  let i = open + 1;
  while (i < limit) {
    const ch = html.charCodeAt(i);
    if (ch === 62) return i;
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

const TAG_NAME = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/;
const TYPE_ATTR = /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const SHADOW_ATTR = /\sshadowroot(?:mode)?\s*=/i;
const TEMPLATE_TAG = /<(\/?)template(?![\w:.-])/gi;
const RAW_TEXT_CLOSERS: Readonly<Record<string, RegExp>> = {
  script: /<\/script/gi,
  style: /<\/style/gi,
  textarea: /<\/textarea/gi,
  title: /<\/title/gi,
};

/**
 * Where each `<template>` of `html` ends: the index just past its `</template>`, found for all of them in ONE pass with a
 * stack (so a page of a million nested or unclosed templates costs one scan, not one per template). A template that never
 * closes has no entry. A `</template>` with no open template is ignored.
 */
function templateEnds(html: string): Map<number, number> {
  const ends = new Map<number, number>();
  const open: number[] = [];
  TEMPLATE_TAG.lastIndex = 0;
  for (let m = TEMPLATE_TAG.exec(html); m; m = TEMPLATE_TAG.exec(html)) {
    if (m[1] !== "/") {
      open.push(m.index);
    } else if (open.length > 0) {
      const gt = html.indexOf(">", m.index);
      if (gt === -1) break;
      ends.set(open.pop()!, gt + 1);
    }
  }
  return ends;
}

/** The views of `html` (see the file comment). The strings are `html` itself when nothing was taken out of them. */
export function pageViews(html: string): PageViews {
  // Nothing here can matter on a page with none of these: the common case costs three searches.
  const hasComment = html.includes("<!--");
  const hasTemplate = /<template(?![\w:.-])/i.test(html);
  const hasScript = /<script\b/i.test(html);
  if (!hasComment && !hasTemplate && !hasScript) return { markup: html, clean: html, commented: html };

  const markup: string[] = [];
  const clean: string[] = [];
  const commented: string[] = [];
  let changedMarkup = false;
  let changedClean = false;
  let changedCommented = false;
  let copied = 0; // everything before this index is already in the arrays
  let pos = 0;
  let ends: Map<number, number> | undefined;

  /** Text `[copied, to)` goes to every view. */
  const flush = (to: number): void => {
    if (to > copied) {
      const text = html.slice(copied, to);
      markup.push(text);
      clean.push(text);
      commented.push(text);
    }
    copied = to;
  };

  for (;;) {
    const open = html.indexOf("<", pos);
    if (open === -1) break;
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      if (close === -1) break; // never closes: it stays
      flush(open);
      const end = close + 3;
      markup.push(html.slice(open, end));
      commented.push(html.slice(open, end));
      changedClean = true;
      copied = end;
      pos = end;
      continue;
    }
    const close = tagEnd(html, open);
    if (close === -1) break;
    const tag = html.slice(open, close + 1);
    const name = TAG_NAME.exec(tag);
    pos = close + 1;
    if (!name || name[1] === "/") continue;
    const tagName = name[2]!.toLowerCase();
    if (tagName === "template" && !SHADOW_ATTR.test(tag.length > MAX_TAG_CHARS ? tag.slice(0, MAX_TAG_CHARS) : tag)) {
      ends ??= templateEnds(html);
      const end = ends.get(open) ?? -1;
      if (end !== -1) {
        // the whole element, tags and content, is inert
        flush(open);
        copied = end;
        pos = end;
        changedMarkup = changedClean = changedCommented = true;
        continue;
      }
    }
    if (RAW_TEXT_TAGS.has(tagName) && !tag.endsWith("/>")) {
      const closer = RAW_TEXT_CLOSERS[tagName]!;
      closer.lastIndex = pos;
      const found = closer.exec(html);
      const end = found ? found.index : html.length;
      if (tagName === "script" && end > pos) {
        const type = TYPE_ATTR.exec(tag.length > MAX_TAG_CHARS ? tag.slice(0, MAX_TAG_CHARS) : tag);
        const value = (type?.[1] ?? type?.[2] ?? type?.[3] ?? "").trim().slice(0, 256);
        if (type && DATA_TYPE.test(value)) {
          // the body of a data script: kept for the tag readers, taken out of the views an `html` detector reads
          flush(pos);
          markup.push(html.slice(pos, end));
          copied = end;
          changedClean = changedCommented = true;
        }
      }
      pos = end;
    }
  }
  flush(html.length);
  return {
    markup: changedMarkup ? markup.join("") : html,
    clean: changedClean ? clean.join("") : html,
    commented: changedCommented ? commented.join("") : html,
  };
}
