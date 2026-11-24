// The bodies a site serves that a repository scanner never sees (#362): the
// original sources inside a same-origin source map, and a same-origin config
// endpoint a bundle fetches at boot by literal URL. The engine asks this module
// which URLs to request (at most SECRET_SOURCE_FETCH_LIMITS.MAX_FETCHES per
// audit), fetches them on the asset phase's budget, and hands the bodies to
// security/leaked-secrets as `site.secretSources`. Nothing here touches the
// network.

import { SECRET_SOURCE_FETCH_LIMITS } from "@squirrelscan/utils/constants";

import type { SecretSourceKind } from "../../types";

import { sharedRegex } from "../../shared-regex";

/** The part of a fetched script the planner reads. */
export interface SecretSourceScript {
  url: string;
  content: string | null;
  sourcePages: readonly string[];
  /** The `SourceMap` (or `X-SourceMap`) response header, when the script carried one. */
  sourceMapHeader?: string;
}

/** One body to request: what it is, where, and which script pointed at it. */
export interface SecretSourceTarget {
  kind: SecretSourceKind;
  url: string;
  /** The first script that referenced it. */
  referencedBy: string;
  /** Pages that load a script referencing it. */
  sourcePages: string[];
}

/** How far from the end of a script its `sourceMappingURL` comment is looked for. */
const MAP_COMMENT_TAIL = 4096;
const MAP_COMMENT_RE = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/;

/**
 * A config endpoint, by the literal a bundle fetches it with: a quoted
 * root-relative or absolute http(s) URL whose path is a config, env or settings
 * file (`/config.json`, `/env.js`, `/assets/app-config.json`), an
 * `/api/config`-style route, or anything under `/.well-known/`. Template
 * literals with a substitution are not URLs yet and do not match (`$` and `{`
 * are outside every class here).
 */
const CONFIG_LITERAL_RE = sharedRegex(
  /["'`]((?:https?:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?)?\/(?:[\w.~-]{1,128}\/){0,8}(?:(?:(?:app|runtime|client|public|site)[-_.]?)?(?:config|env|environment|settings)(?:\.[\w-]{1,32}){0,3}\.(?:json|js)|api\/(?:v\d{1,3}\/)?(?:config|env|settings)|\.well-known\/[\w.~-]{1,128}(?:\/[\w.~-]{1,128}){0,4}))(?:\?[\w.~%=&-]{0,256})?["'`]/g
);

/** Config literals read per script: a bundle that names hundreds is not naming its boot config. */
const CONFIG_LITERALS_PER_SCRIPT = 32;

function parseUrl(raw: string, base?: string): URL | null {
  try {
    return base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return null;
  }
}

function originOf(raw: string): string | null {
  const url = parseUrl(raw);
  return url && (url.protocol === "http:" || url.protocol === "https:")
    ? url.origin
    : null;
}

/**
 * The origins a body referenced by `script` may be fetched from: the script's
 * own and the origin of each page that loads it. Anything else is cross-origin
 * and is never requested.
 */
function sameOrigins(script: SecretSourceScript): Set<string> {
  const origins = new Set<string>();
  const own = originOf(script.url);
  if (own) origins.add(own);
  for (const page of script.sourcePages) {
    const origin = originOf(page);
    if (origin) origins.add(origin);
  }
  return origins;
}

/**
 * `raw` resolved against `base`, without its query or fragment, when it is an
 * http(s) URL on one of `origins` that carries no credentials. The query is
 * dropped because a signed or tokened URL (`a.js.map?token=<secret>`) would
 * otherwise be requested and land, unmasked, in the finding's label.
 */
function sameOriginUrl(
  raw: string,
  base: string,
  origins: ReadonlySet<string>
): string | null {
  const url = parseUrl(raw, base);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:"))
    return null;
  if (!origins.has(url.origin)) return null;
  // Credentials in the URL would land unmasked in the finding's label.
  if (url.username || url.password) return null;
  url.search = "";
  url.hash = "";
  return url.href;
}

/**
 * The script's source map URL, when it names a same-origin one: the response
 * header first (it wins over the comment, as in a browser), else the last
 * `sourceMappingURL` comment in the script's tail. Relative URLs resolve
 * against the script. A `data:` map is inline, already scanned with the script,
 * and never requested.
 */
export function sourceMapUrlOf(script: SecretSourceScript): string | null {
  const origins = sameOrigins(script);
  const header = script.sourceMapHeader?.trim();
  if (header) return sameOriginUrl(header, script.url, origins);
  const content = script.content;
  if (!content) return null;
  const tail = content.slice(Math.max(0, content.length - MAP_COMMENT_TAIL));
  const raw = MAP_COMMENT_RE.exec(tail)?.[1];
  if (!raw || raw.startsWith("data:")) return null;
  return sameOriginUrl(raw, script.url, origins);
}

/**
 * The same-origin config endpoints a script names by literal URL, in the order
 * it names them. A root-relative path resolves against the page that loads the
 * script (where a browser's `fetch` resolves it), else against the script.
 */
export function configEndpointUrlsOf(script: SecretSourceScript): string[] {
  const content = script.content;
  if (!content) return [];
  const origins = sameOrigins(script);
  const base = script.sourcePages[0] ?? script.url;
  const out: string[] = [];
  const seen = new Set<string>();
  CONFIG_LITERAL_RE.lastIndex = 0;
  let literals = 0;
  for (
    let m = CONFIG_LITERAL_RE.exec(content);
    m !== null && literals < CONFIG_LITERALS_PER_SCRIPT;
    m = CONFIG_LITERAL_RE.exec(content)
  ) {
    literals++;
    // The query is dropped: a literal like `/config.json?key=<secret>` would
    // otherwise put that key, unmasked, into the finding's label and meta.
    const url = sameOriginUrl(m[1], base, origins);
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  CONFIG_LITERAL_RE.lastIndex = 0;
  return out;
}

/**
 * The bodies to request for `scripts`, at most `cap` (never more than
 * SECRET_SOURCE_FETCH_LIMITS.MAX_FETCHES), source maps and config endpoints
 * taken in turn so neither kind can crowd out the other, each in script order.
 * A URL two scripts reference is one target; its pages are both scripts'.
 * `total` counts every distinct target found, so the caller can tell how many
 * the cap left out.
 */
export function planSecretSources(
  scripts: readonly SecretSourceScript[],
  cap: number = SECRET_SOURCE_FETCH_LIMITS.MAX_FETCHES
): { targets: SecretSourceTarget[]; total: number } {
  const limit = Math.max(
    0,
    Math.min(cap, SECRET_SOURCE_FETCH_LIMITS.MAX_FETCHES)
  );
  const byUrl = new Map<string, SecretSourceTarget>();
  const maps: SecretSourceTarget[] = [];
  const configs: SecretSourceTarget[] = [];
  const note = (
    kind: SecretSourceKind,
    url: string,
    script: SecretSourceScript
  ): void => {
    const known = byUrl.get(url);
    if (known) {
      for (const page of script.sourcePages)
        if (!known.sourcePages.includes(page)) known.sourcePages.push(page);
      return;
    }
    const target: SecretSourceTarget = {
      kind,
      url,
      referencedBy: script.url,
      sourcePages: [...script.sourcePages],
    };
    byUrl.set(url, target);
    (kind === "source-map" ? maps : configs).push(target);
  };
  for (const script of scripts) {
    const map = sourceMapUrlOf(script);
    if (map) note("source-map", map, script);
    for (const url of configEndpointUrlsOf(script))
      note("config-endpoint", url, script);
  }
  const targets: SecretSourceTarget[] = [];
  for (let i = 0; targets.length < limit; i++) {
    const map = maps[i];
    const config = configs[i];
    if (!map && !config) break;
    if (map) targets.push(map);
    if (config && targets.length < limit) targets.push(config);
  }
  return { targets, total: byUrl.size };
}

/** A source path from a dependency: its code is the bundle's vendored code, never the site's own config. */
const VENDORED_SOURCE_RE = /(?:^|[/\\])node_modules[/\\]/;

/**
 * The original sources a source map body carries (`sourcesContent`, and each
 * section's for an indexed map), skipping the ones under `node_modules`: a
 * key a build inlined sits in the site's own modules. Null when the body is
 * not a source map.
 */
export function sourceMapSources(body: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.replace(/^\)\]\}'[^\n]*\n/, ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const out: string[] = [];
  const read = (map: unknown, depth: number): boolean => {
    if (!map || typeof map !== "object") return false;
    const record = map as Record<string, unknown>;
    if (Array.isArray(record.sections) && depth === 0) {
      let any = false;
      for (const section of record.sections)
        if (
          section &&
          typeof section === "object" &&
          read((section as Record<string, unknown>).map, depth + 1)
        )
          any = true;
      return any;
    }
    if (!Array.isArray(record.sources)) return false;
    const names = record.sources as unknown[];
    const contents = Array.isArray(record.sourcesContent)
      ? (record.sourcesContent as unknown[])
      : [];
    for (const [i, text] of contents.entries()) {
      if (typeof text !== "string" || text.length === 0) continue;
      const name = names[i];
      if (typeof name === "string" && VENDORED_SOURCE_RE.test(name)) continue;
      out.push(text);
    }
    return true;
  };
  return read(parsed, 0) ? out : null;
}

/** A body that is an HTML page: a single-page app answering every path with its shell, not a config. */
export function isHtmlBody(
  contentType: string | null | undefined,
  body: string
): boolean {
  if (contentType && /\bhtml\b/i.test(contentType)) return true;
  return /^\s*</.test(body.slice(0, 256));
}
