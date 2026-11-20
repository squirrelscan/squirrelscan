// One JSON field, named the same way by two rules (squirrelscan#2083).
//
// security/auth-endpoint-disclosure reports a field as `user.encrypted_password`
// or `users[0].password`, masking any key that is not a plain name to `*`.
// security/json-sensitive-fields reports it as `$.user.encrypted_password` or
// `$.users[].password`, quoting a key that is not an identifier. The runner's
// endpoint dedupe (endpoint-dedupe.ts) turns both into one field key so it can
// tell when the two rules point at the same field of the same answer: `$`, then
// `.name` per key (masked to `*` exactly as the auth rule masks it) and `[]` per
// array, every index folded. A path that cannot be read back (cut at its length
// cap, or not in either form) has no key and matches nothing, so its finding is
// kept. Keys are built from paths already in the report: they hold nothing the
// report does not.

/** The auth rule's mask: only a plain field name is kept (auth-endpoint-disclosure `childPath`). */
function maskKey(key: string): string {
  return /^[A-Za-z_-]{1,32}$/.test(key) ? key : "*";
}

/** The field key of an auth-endpoint-disclosure item's `meta.field`, or undefined. */
export function authFieldKey(path: string): string | undefined {
  if (path === "" || path === "(root)") return undefined;
  const folded = path.replace(/\[\d+\]/g, "[]");
  return folded.startsWith("[") ? `$${folded}` : `$.${folded}`;
}

/** The field key of a json-sensitive-fields item's `meta.path`, or undefined. */
export function jsonFieldKey(path: string): string | undefined {
  if (!path.startsWith("$")) return undefined;
  let out = "$";
  let i = 1;
  while (i < path.length) {
    if (path.startsWith("[]", i)) {
      out += "[]";
      i += 2;
      continue;
    }
    if (path[i] === ".") {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(path.slice(i + 1));
      if (!m) return undefined;
      out += `.${maskKey(m[0])}`;
      i += 1 + m[0].length;
      continue;
    }
    if (path.startsWith('["', i)) {
      // A JSON string literal, then `]`. JSON.stringify escaped every quote and
      // backslash in it, so the first unescaped quote ends it.
      const m = /^"(?:[^"\\]|\\.)*"/.exec(path.slice(i + 1));
      if (!m || path[i + 1 + m[0].length] !== "]") return undefined;
      let key: string;
      try {
        key = JSON.parse(m[0]) as string;
      } catch {
        return undefined;
      }
      out += `.${maskKey(key)}`;
      i += 2 + m[0].length;
      continue;
    }
    // A path cut at its length cap (ends in "…"), or something else: no key.
    return undefined;
  }
  return out;
}

/**
 * True when `key` is one of `reported`, or a field inside one of them: the
 * auth rule reports a secret field whole (a recovery code list, an OTP object),
 * so a credential json-sensitive-fields finds within it is that same leak.
 */
export function fieldIsCovered(key: string, reported: ReadonlySet<string>): boolean {
  if (reported.has(key)) return true;
  for (const r of reported) {
    if (key.startsWith(`${r}.`) || key.startsWith(`${r}[`)) return true;
  }
  return false;
}
