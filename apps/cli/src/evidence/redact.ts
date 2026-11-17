// Redaction for the shareable evidence export (repo#2301).
//
// The raw bundle holds what the site sent: cookies, tokens in URLs, account data
// in page bodies. The shareable bundle is what you can hand to someone else, so
// every byte of it leaves through `ShareableRedactor` (the bundle writer's one
// exit): every JSON string and key, and every artifact body. This is pattern
// based and deliberately conservative: it cannot prove a body holds no secret,
// so the manifest records which patterns ran and how often they matched, and the
// raw bundle stays the restricted copy.

export const REDACTED = "[redacted]";

/** Headers whose values carry credentials, sessions or account identity. */
export const SENSITIVE_HEADER_NAMES: readonly string[] = [
  "set-cookie",
  "set-cookie2",
  "cookie",
  "authorization",
  "proxy-authorization",
  "proxy-authenticate",
  "www-authenticate",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-amz-security-token",
  "x-forwarded-user",
  "x-user",
  "x-user-id",
  "x-user-email",
  "x-account",
  "x-account-id",
  // Well-known credential headers without an x-/cf-/private- prefix.
  "api-key",
  "apikey",
  "ocp-apim-subscription-key",
  "auth-token",
  "access-token",
  "id-token",
  "refresh-token",
  "session-id",
  "session-token",
  "secret-key",
  "client-secret",
  "authentication",
];

const SENSITIVE_HEADER = new RegExp(
  `^(?:${SENSITIVE_HEADER_NAMES.join("|")})$`,
  "i"
);

/**
 * A credential header outside the exact list (`x-goog-api-key`,
 * `private-token`, `cf-access-client-secret`, `x-session-id`, `x-jwt`): the
 * name, normalised (trimmed, lower case, `_` read as `-`), contains one of
 * these words. Applied to header-map keys, where every key is a header name.
 */
const CREDENTIAL_WORD =
  /token|secret|session|auth|key|cookie|jwt|signature|credential|password/;

function normaliseHeaderName(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, "-");
}

/**
 * Header names that contain a credential word but carry no secret, so the
 * word rule must not blank them. Checked after the exact list and before the
 * word rule, normalised the same way. Each entry says why it is safe to keep.
 */
export const HEADER_KEEP_NAMES: ReadonlyMap<string, string> = new Map([
  [
    "access-control-allow-credentials",
    "CORS flag whose only valid value is `true`; CORS checks read it",
  ],
  [
    "public-key-pins",
    "HPKP pins are hashes of public keys, published to every visitor",
  ],
  [
    "public-key-pins-report-only",
    "the report-only form of public-key-pins: public pins",
  ],
  [":authority", "HTTP/2 pseudo-header holding the host, not an auth value"],
]);

/**
 * Header names as they appear in a header line quoted as plain text: any case,
 * `_` for `-` (`x_api_key`, `set_cookie`), and an optional CGI `HTTP_` prefix
 * (`HTTP_COOKIE`). Longest first so `set-cookie2` is not cut at `set-cookie`.
 * Besides the exact list, any `x-`, `cf-` or `private-` name containing a
 * credential word counts, bounded so a long hyphenated word cannot backtrack.
 */
const HEADER_LINE_NAME = `(?:http_)?(?:${[...SENSITIVE_HEADER_NAMES]
  .sort((a, b) => b.length - a.length)
  .map((n) => n.replace(/-/g, "[-_]"))
  .join(
    "|"
  )}|(?:x|cf|private)[-_][\\w-]{0,40}?(?:${CREDENTIAL_WORD.source})[\\w-]{0,40})`;

/**
 * Quote characters a header name or value can be wrapped in: plain quotes and
 * backticks, a backslash-escaped quote (JSON inside a JSON string) and the HTML
 * entities (`data-*` attributes).
 */
const QUOTE = `\\\\?["'\`]|&quot;|&#34;|&#39;`;

/** An unquoted value, or one continuation line, is cut at 16 KB (minified code). */
const MAX_RUN = 16384;

/**
 * The header-line pattern:
 *   name     optional quote (repeated after the name), optional `]` (print_r)
 *   sep      `:`, `=`, `=>` or `->`, with spaces or tabs around it
 *   value    a quoted value, when its closing quote is followed by the end of
 *            the line or `,` `}` `]`; escapes (`\"`) do not close it, and a
 *            quote followed by a folded continuation line does not close it
 *            (the unquoted branch takes the folded lines). Else
 *            the rest of the line (capped), plus any folded continuation lines
 *            that start with a space or tab. When the first line is empty
 *            (`Cookie:\nsid=...`), the whole next line is the value, whatever
 *            it starts with, plus its folded continuations.
 */
const HEADER_LINE = new RegExp(
  [
    `(?<![\\w-])`,
    `((${QUOTE})?(?:${HEADER_LINE_NAME})\\2\\]?[^\\S\\r\\n]*(?:=>|->|[:=])[^\\S\\r\\n]*)`,
    `(?:`,
    `(${QUOTE})(?:\\\\[^\\r\\n]|(?!\\3)[^\\\\\\r\\n]){0,${MAX_RUN}}\\3(?=[^\\S\\r\\n]*(?:[,}\\]]|\\r?\\n(?![ \\t])|\\r(?!\\n)|$))`,
    `|`,
    `(?:\\r?\\n[^\\r\\n]{0,${MAX_RUN}}|[^\\r\\n]{1,${MAX_RUN}})(?:\\r?\\n[ \\t][^\\r\\n]{0,${MAX_RUN}}){0,16}`,
    `)`,
  ].join(""),
  "gi"
);

/** Query parameter names that carry credentials, sessions or identity. */
const SENSITIVE_PARAM =
  /^(token|access[_-]?token|id[_-]?token|refresh[_-]?token|auth|authorization|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|pass|session|sessionid|sid|jsessionid|phpsessid|sig|signature|code|otp|email|e-?mail|user|username|uid|account|acct|ticket|csrf|nonce|bearer|credential|x-amz-signature|x-amz-credential|x-amz-security-token)$/i;

export interface RedactionCounts {
  /** Values under a credential-bearing header name (Cookie, Authorization, ...). */
  headers: number;
  /** Values under any other credential-bearing key name (token, password, ...). */
  keys: number;
  urlParams: number;
  patterns: Record<string, number>;
}

export function newRedactionCounts(): RedactionCounts {
  return { headers: 0, keys: 0, urlParams: 0, patterns: {} };
}

/** Redact sensitive query parameters and URL userinfo; leaves unparseable strings alone. */
export function redactUrl(url: string, counts: RedactionCounts): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let changed = false;
  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
    counts.urlParams++;
    changed = true;
  }
  for (const key of parsed.searchParams.keys()) {
    if (SENSITIVE_PARAM.test(key)) {
      parsed.searchParams.set(key, REDACTED);
      counts.urlParams++;
      changed = true;
    }
  }
  if (parsed.hash && /(token|access_token|id_token|code)=/i.test(parsed.hash)) {
    parsed.hash = "#" + REDACTED;
    counts.urlParams++;
    changed = true;
  }
  if (!changed) return url;
  return parsed.toString().replace(/%5Bredacted%5D/gi, REDACTED);
}

const PATTERNS: Array<{
  name: string;
  re: RegExp;
  replace: string | ((m: string, ...g: string[]) => string);
}> = [
  {
    name: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: REDACTED,
  },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
    replace: REDACTED,
  },
  {
    name: "aws-access-key",
    re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replace: REDACTED,
  },
  {
    name: "provider-key",
    re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: REDACTED,
  },
  {
    // `Cookie: sid=...`, `"Authorization": "Token ..."`, `HTTP_COOKIE=...`,
    // `[Cookie] => ...`: see HEADER_LINE.
    name: "header-line",
    re: HEADER_LINE,
    // A value on the next line keeps its line break: `Cookie:\n[redacted]`.
    replace: (m, pre, _nq, vq) =>
      `${pre}${vq ? `${vq}${REDACTED}${vq}` : `${/^\r?\n/.exec(m.slice(pre.length))?.[0] ?? ""}${REDACTED}`}`,
  },
  {
    name: "bearer-token",
    re: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: (_m, scheme) => `${scheme} ${REDACTED}`,
  },
  {
    // Starts only at the start of a run (not at every `\b` inside it), so a long
    // run of name characters with no `@` is scanned once, not quadratically.
    name: "email",
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    replace: REDACTED,
  },
  {
    name: "csrf-meta",
    re: /(<meta\b[^>]*\bname\s*=\s*["'](?:csrf-token|csrf|xsrf-token|_token)["'][^>]*\bcontent\s*=\s*["'])[^"']*(["'])/gi,
    replace: (_m, pre, post) => `${pre}${REDACTED}${post}`,
  },
  {
    name: "hidden-input-token",
    re: /(<input\b[^>]*\btype\s*=\s*["']hidden["'][^>]*\bname\s*=\s*["'][^"']*(?:token|csrf|nonce|session|auth|key|secret)[^"']*["'][^>]*\bvalue\s*=\s*["'])[^"']*(["'])/gi,
    replace: (_m, pre, post) => `${pre}${REDACTED}${post}`,
  },
  {
    name: "credential-assignment",
    re: /((?:["']?)(?:api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|access[_-]?token|auth[_-]?token|private[_-]?key)(?:["']?)\s*[:=]\s*["'])[^"'\s]{6,}(["'])/gi,
    replace: (_m, pre, post) => `${pre}${REDACTED}${post}`,
  },
  {
    name: "url-credential-param",
    re: /([?&;](?:token|access_token|api_key|apikey|key|secret|password|sessionid|sid|sig|signature|code|email)=)[^&\s"'<>#]+/gi,
    replace: (_m, pre) => `${pre}${REDACTED}`,
  },
];

/** Names of the body patterns, recorded in the manifest. */
export const REDACTION_PATTERN_NAMES: readonly string[] = PATTERNS.map(
  (p) => p.name
);

/** Redact secrets and account data out of a text body (HTML, script, header block). */
export function redactText(text: string, counts: RedactionCounts): string {
  let out = text;
  for (const { name, re, replace } of PATTERNS) {
    out = out.replace(re, (...args: unknown[]) => {
      const match = args[0] as string;
      const next =
        typeof replace === "string"
          ? replace
          : replace(...(args as [string, ...string[]]));
      // An already-redacted match is not a new hit.
      if (next !== match)
        counts.patterns[name] = (counts.patterns[name] ?? 0) + 1;
      return next;
    });
  }
  return out;
}

/** Absolute URLs inside free text, stopping at quotes, whitespace and angle brackets. */
const EMBEDDED_URL = /\bhttps?:\/\/[^\s"'<>]+/gi;
/** Query parameters in absolute or relative URLs (`/cb?session=x`, `?code=y`). */
const QUERY_PARAM = /([?&;])([^=&\s"'<>#?;]+)=([^&\s"'<>#;]*)/g;

/**
 * Redact one free-form string: URLs embedded anywhere in it (userinfo and
 * sensitive query params, absolute or relative), then the body patterns.
 */
export function redactString(value: string, counts: RedactionCounts): string {
  let out = value.replace(EMBEDDED_URL, (m) => redactUrl(m, counts));
  out = out.replace(QUERY_PARAM, (m, sep: string, key: string, v: string) => {
    if (v === REDACTED || v === "" || !SENSITIVE_PARAM.test(key)) return m;
    counts.urlParams++;
    return `${sep}${key}=${REDACTED}`;
  });
  return redactText(out, counts);
}

// ── The shareable bundle's one exit ──────────────────────────────────────────────
//
// Deny by default: every string value and every object key in every JSON file,
// and every artifact body, goes through `redactString`. A value under a key that
// names a credential (the SENSITIVE_HEADER and SENSITIVE_PARAM lists above,
// matched against JSON keys anywhere: header maps, rule observations, config)
// is replaced whole, because a cookie or API key value has no recognisable
// shape on its own. The only exemptions are the paths in SHAREABLE_ALLOWLIST.

/**
 * `<file>:<path>`, path dot-separated. `[]` is any array index, `*` any object
 * key (inline-scripts.json is a map keyed by page URL).
 */
type PathPattern = string;

interface AllowRule {
  paths: readonly PathPattern[];
  /** An exempt value must also have this shape; anything else is redacted after all. */
  shape: RegExp | "subtree";
  reason: string;
}

/**
 * The fields the shareable pass leaves alone. Each is produced by the exporter,
 * never copied from the site, and is read back exactly by verify, replay or the
 * retention gate. Keep this list short: a field not on it is redacted.
 */
export const SHAREABLE_ALLOWLIST: readonly AllowRule[] = [
  {
    paths: [
      "findings.json:[].evidence.[].contentSha256",
      "findings.json:[].evidence.[].locator.byteRange.snippetSha256",
      "pages.json:[].artifacts.[].sha256",
      "scripts.json:[].artifact.sha256",
      "scripts.json:[].referencedFrom.[].pageArtifactSha256",
      "inline-scripts.json:*.[].sha256",
      "inline-scripts.json:*.[].parentSha256",
      "manifest.json:files.[].sha256",
      "manifest.json:bundleSha256",
    ],
    shape: /^[0-9a-f]{64}$/,
    reason:
      "sha256 digests the exporter computed; verify and replay compare them byte for byte",
  },
  {
    paths: [
      "pages.json:[].artifacts.[].path",
      "scripts.json:[].artifact.path",
      "manifest.json:files.[].path",
    ],
    shape:
      /^(?:[a-z-]+\.(?:json|txt)|artifacts\/(?:response-body|rendered-dom|script)\/[0-9a-f]{64})$/,
    reason: "file names the writer generated; verify opens them",
  },
  {
    paths: [
      "findings.json:[].evidence.[].artifactType",
      "pages.json:[].artifacts.[].type",
      "scripts.json:[].artifact.type",
    ],
    shape: /^(?:response-body|rendered-dom|script)$/,
    reason: "artifact type enum; replay builds the artifact path from it",
  },
  {
    paths: [
      "findings.json:[].evidence.[].state",
      "pages.json:[].artifacts.[].state",
      "scripts.json:[].artifact.state",
    ],
    shape: /^(?:located|page-only|truncated|unavailable|stored)$/,
    reason:
      "evidence and artifact state enums; verify and replay branch on them",
  },
  {
    paths: [
      "manifest.json:format",
      "manifest.json:kind",
      "manifest.json:sensitivity",
    ],
    shape: /^(?:squirrelscan-evidence|raw|shareable|restricted)$/,
    reason:
      "format markers; verify rejects a bundle whose format it does not know",
  },
  {
    paths: ["manifest.json:crawlId"],
    shape: /^[A-Za-z0-9_-]{1,128}$/,
    reason: "the local crawl id; the retention gate compares it exactly",
  },
  {
    paths: ["manifest.json:redaction"],
    shape: "subtree",
    reason:
      "written by this redactor: its own pattern names and integer counts, nothing from the site",
  },
];

function matches(
  pattern: PathPattern,
  file: string,
  path: readonly string[]
): boolean {
  const colon = pattern.indexOf(":");
  if (pattern.slice(0, colon) !== file) return false;
  const want = pattern.slice(colon + 1).split(".");
  if (want.length !== path.length) return false;
  return want.every((seg, i) =>
    seg === "*" ? path[i] !== "[]" : seg === path[i]
  );
}

function allowRule(file: string, path: readonly string[]): AllowRule | null {
  for (const rule of SHAREABLE_ALLOWLIST)
    if (rule.paths.some((p) => matches(p, file, path))) return rule;
  return null;
}

function isCredentialKey(
  key: string,
  inHeaderMap: boolean
): "header" | "key" | null {
  const name = normaliseHeaderName(key);
  if (SENSITIVE_HEADER.test(name)) return "header";
  if (inHeaderMap && !HEADER_KEEP_NAMES.has(name) && CREDENTIAL_WORD.test(name))
    return "header";
  if (SENSITIVE_PARAM.test(key.trim())) return "key";
  return null;
}

/** A map of header names to values: `headers`, `requestHeaders`, `responseHeaders`. */
const HEADER_MAP_KEY = /headers$/i;

/** Replace every scalar under a credential key; keep the shape (and nulls). */
function blank(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(blank);
  if (typeof value === "object") {
    // Nested keys are blanked too: under a credential, nothing is kept.
    const out: Record<string, unknown> = {};
    for (const [i, v] of Object.values(value).entries())
      out[i === 0 ? REDACTED : `${REDACTED} (${i + 1})`] = blank(v);
    return out;
  }
  return REDACTED;
}

/**
 * The single redaction point for a `--shareable` bundle. The bundle writer
 * calls `json` for every JSON file and `text` for every artifact body; nothing
 * reaches disk any other way.
 */
export class ShareableRedactor {
  readonly counts: RedactionCounts = newRedactionCounts();

  /** Artifact bodies and any other free text. */
  text(value: string): string {
    return redactString(value, this.counts);
  }

  /** A JSON document about to be written as `file`. Returns a redacted copy. */
  json(file: string, value: unknown): unknown {
    return this.walk(file, value, []);
  }

  private walk(file: string, value: unknown, path: string[]): unknown {
    const rule = path.length > 0 ? allowRule(file, path) : null;
    if (rule?.shape === "subtree") return value;
    // Exempt only a string of the expected shape; anything else at an
    // allowlisted path (another shape, an object) goes through the pass.
    if (rule && typeof value === "string" && rule.shape.test(value))
      return value;
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value))
      return value.map((v) => this.walk(file, v, [...path, "[]"]));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      const inHeaderMap = HEADER_MAP_KEY.test(path.at(-1) ?? "");
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const base = this.text(k);
        let key = base;
        let n = 1;
        while (Object.hasOwn(out, key)) key = `${base} (${++n})`;
        const credential = isCredentialKey(k, inHeaderMap);
        if (credential && v !== null && v !== undefined) {
          if (credential === "header") this.counts.headers++;
          else this.counts.keys++;
          out[key] = blank(v);
        } else {
          out[key] = this.walk(file, v, [...path, k]);
        }
      }
      return out;
    }
    return value;
  }
}
