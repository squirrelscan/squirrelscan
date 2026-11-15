// Redaction for the shareable evidence export (repo#2301).
//
// The raw bundle holds what the site sent: cookies, tokens in URLs, account data
// in page bodies. The shareable bundle is what you can hand to someone else, so
// it passes every header, URL and artifact body through here. This is pattern
// based and deliberately conservative: it cannot prove a body holds no secret,
// so the manifest records which patterns ran and how often they matched, and the
// raw bundle stays the restricted copy.

export const REDACTED = "[redacted]";

/** Headers whose values carry credentials, sessions or account identity. */
const SENSITIVE_HEADER =
  /^(set-cookie2?|cookie|authorization|proxy-authorization|proxy-authenticate|www-authenticate|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token|x-forwarded-user|x-user(-id|-email)?|x-account(-id)?)$/i;

/** Query parameter names that carry credentials, sessions or identity. */
const SENSITIVE_PARAM =
  /^(token|access[_-]?token|id[_-]?token|refresh[_-]?token|auth|authorization|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|pass|session|sessionid|sid|jsessionid|phpsessid|sig|signature|code|otp|email|e-?mail|user|username|uid|account|acct|ticket|csrf|nonce|bearer|credential|x-amz-signature|x-amz-credential|x-amz-security-token)$/i;

export interface RedactionCounts {
  headers: number;
  urlParams: number;
  patterns: Record<string, number>;
}

export function newRedactionCounts(): RedactionCounts {
  return { headers: 0, urlParams: 0, patterns: {} };
}

export function redactHeaders<T extends Record<string, unknown>>(
  headers: T,
  counts: RedactionCounts
): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER.test(name) && value !== null && value !== undefined) {
      out[name] = REDACTED;
      counts.headers++;
    } else {
      out[name] = value;
    }
  }
  return out as T;
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
    name: "bearer-token",
    re: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: (_m, scheme) => `${scheme} ${REDACTED}`,
  },
  {
    name: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
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
      counts.patterns[name] = (counts.patterns[name] ?? 0) + 1;
      return typeof replace === "string"
        ? replace
        : replace(...(args as [string, ...string[]]));
    });
  }
  return out;
}
