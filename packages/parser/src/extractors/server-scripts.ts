// Server-sent scripts a client-side render dropped (#1769).
//
// Some frameworks remove server-rendered head scripts once hydration finishes, so
// whether a rendered snapshot still holds them depends on when it was taken. A
// script the server sends is public either way, so the audit reads the union of
// the server HTML's scripts and the rendered DOM's: a script only the server HTML
// holds is appended to the rendered document, marked with
// `data-sq-server-only="1"`, in the same part (head or body) it came from.
//
// The merge is a pure function of the two documents, so the same page gives the
// same script set for a fast and a slow render.

import { createHash } from "node:crypto";

import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

import { parseHTML } from "../dom";

/** Marks a script the server sent and the rendered DOM no longer holds. */
export const SERVER_ONLY_SCRIPT_ATTR = "data-sq-server-only";
/** Set on `<html>` when scripts were left out of the merge for the caps below. */
export const SERVER_SCRIPTS_OMITTED_ATTR = "data-sq-server-scripts-omitted";

/** Most server-only scripts (external and inline together) added to one page. */
export const MAX_SERVER_ONLY_SCRIPTS = 50;
/** An inline body over this is left out (and counted), never truncated. */
export const MAX_SERVER_ONLY_INLINE_BYTES = 256 * 1024;
/** Total inline bytes added to one page. */
export const MAX_SERVER_ONLY_INLINE_TOTAL_BYTES = 1024 * 1024;

const JS_TYPES = new Set(["", "module", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"]);

function isExecutableScript(type: string | null): boolean {
  return JS_TYPES.has((type ?? "").trim().toLowerCase());
}

function normalizeSrc(src: string, baseUrl: string): string | null {
  try {
    const url = new URL(src.trim(), baseUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function bodyKey(text: string): string {
  return createHash("sha1").update(text.trim()).digest("hex");
}

export interface ServerScriptMerge {
  html: string;
  /** Server-only scripts added to the document. */
  added: number;
  /** Server-only scripts left out for the caps. */
  omitted: number;
}

/**
 * Append the scripts `serverHtml` holds and `renderedHtml` does not (deduped by
 * normalized `src` and by inline-body hash) to the rendered document. Returns the
 * rendered HTML untouched when there is nothing to add.
 */
export function mergeServerOnlyScripts(
  renderedHtml: string,
  serverHtml: string | undefined | null,
  baseUrl: string
): ServerScriptMerge {
  const unchanged: ServerScriptMerge = { html: renderedHtml, added: 0, omitted: 0 };
  if (!serverHtml || !/<script/i.test(serverHtml)) return unchanged;

  const server = parseHTML(serverHtml).document;
  const serverScripts = querySelectorAllOutsideNoscript(server, "script").filter((el) =>
    isExecutableScript(el.getAttribute("type"))
  );
  if (serverScripts.length === 0) return unchanged;

  const rendered = parseHTML(renderedHtml).document;
  const seenSrc = new Set<string>();
  const seenBody = new Set<string>();
  for (const el of querySelectorAllOutsideNoscript(rendered, "script")) {
    const src = el.getAttribute("src");
    if (src) {
      const key = normalizeSrc(src, baseUrl);
      if (key) seenSrc.add(key);
    } else {
      const text = el.textContent || "";
      if (text.trim()) seenBody.add(bodyKey(text));
    }
  }

  let added = 0;
  let omitted = 0;
  let inlineBytes = 0;
  for (const el of serverScripts) {
    const src = el.getAttribute("src");
    let key: string;
    let isInline = false;
    let text = "";
    if (src) {
      if (src.trim().startsWith("data:")) continue;
      const normalized = normalizeSrc(src, baseUrl);
      if (!normalized || seenSrc.has(normalized)) continue;
      key = normalized;
    } else {
      text = el.textContent || "";
      if (!text.trim()) continue;
      key = bodyKey(text);
      if (seenBody.has(key)) continue;
      isInline = true;
    }
    // Seen now, so a server page repeating the script adds it once.
    (isInline ? seenBody : seenSrc).add(key);

    const size = Buffer.byteLength(text);
    if (
      added >= MAX_SERVER_ONLY_SCRIPTS ||
      (isInline && (size > MAX_SERVER_ONLY_INLINE_BYTES || inlineBytes + size > MAX_SERVER_ONLY_INLINE_TOTAL_BYTES))
    ) {
      omitted++;
      continue;
    }

    const copy = rendered.createElement("script");
    for (const attr of Array.from(el.attributes)) copy.setAttribute(attr.name, attr.value);
    copy.setAttribute(SERVER_ONLY_SCRIPT_ATTR, "1");
    if (isInline) {
      copy.textContent = text;
      inlineBytes += size;
    }
    const inHead = !!el.closest("head");
    const parent = (inHead ? rendered.head : rendered.body) ?? rendered.documentElement;
    parent.appendChild(copy);
    added++;
  }

  if (added === 0 && omitted === 0) return unchanged;
  if (omitted > 0) rendered.documentElement?.setAttribute(SERVER_SCRIPTS_OMITTED_ATTR, String(omitted));
  return { html: rendered.toString(), added, omitted };
}
