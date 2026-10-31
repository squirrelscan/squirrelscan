// Search literals for detectors that declare no `hint` (#1420).
//
// Past the head of a big bundle, the sampler sends windows around the literals detectors need, so a
// detector with no `hint` could only match in whatever tail was left over. 184 of the 194
// `script-content` detectors had none (Sentry.init, the React devtools hook, posthog.init, Stripe(,
// GA4 config...). Almost all of them are a regular expression that begins or contains a plain
// literal, and every match must contain it: that literal is a hint the author did not have to write.
//
// Conservative by construction: only text that every match of the alternative MUST contain is used.
// A group, a class, an optional or repeated character, an escape class (`\s`, `\d`, `\b`) or `.`
// ends a literal run, and a character followed by `?`, `*` or `{` is dropped from it, so the hint is
// never a literal a match can lack. When nothing of at least MIN_DERIVED_HINT_CHARS remains, the
// alternative gets no hint and stays tail-only, as before.

/** Shorter than this and the literal hits constantly and means little. */
export const MIN_DERIVED_HINT_CHARS = 4;

/** Characters that, escaped, stand for themselves. */
const LITERAL_ESCAPES = new Set([..."\\.^$*+?()[]{}|/-'\"`:,;=<>!@#%&~ "]);

/** Index just past the `)` that closes the group opened at `open`, or the end. */
function skipGroup(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
    } else if (c === "[") {
      i = skipClass(source, i) - 1;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

/** Index just past the `]` that closes the class opened at `open`, or the end. */
function skipClass(source: string, open: number): number {
  for (let i = open + 1; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") i++;
    else if (c === "]") return i + 1;
  }
  return source.length;
}

/** The top-level alternatives of a pattern source (split at a `|` outside groups and classes). */
function alternatives(source: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") i++;
    else if (c === "[") i = skipClass(source, i) - 1;
    else if (c === "(") i = skipGroup(source, i) - 1;
    else if (c === "|") {
      out.push(source.slice(start, i));
      start = i + 1;
    }
  }
  out.push(source.slice(start));
  return out;
}

/** The literal runs that every match of one alternative contains. */
function literalRuns(alternative: string): string[] {
  const runs: string[] = [];
  let run = "";
  const end = (): void => {
    if (run) runs.push(run);
    run = "";
  };
  for (let i = 0; i < alternative.length; i++) {
    const c = alternative[i]!;
    if (c === "\\") {
      const next = alternative[i + 1];
      i++;
      if (next !== undefined && LITERAL_ESCAPES.has(next)) run += next;
      else end();
      continue;
    }
    if (c === "[") {
      end();
      i = skipClass(alternative, i) - 1;
      continue;
    }
    if (c === "(") {
      end();
      i = skipGroup(alternative, i) - 1;
      continue;
    }
    if (c === "*" || c === "?" || c === "{") {
      // The character before is optional or repeated zero times: not required.
      run = run.slice(0, -1);
      end();
      if (c === "{") {
        const close = alternative.indexOf("}", i);
        i = close === -1 ? alternative.length : close;
      }
      continue;
    }
    if (c === "+") {
      // At least one of the character before: it stays, and the run ends there.
      end();
      continue;
    }
    if (c === "." || c === "^" || c === "$" || c === ")" || c === "]" || c === "}") {
      end();
      continue;
    }
    run += c;
  }
  end();
  return runs;
}

/**
 * The literals worth searching a bundle for to find where `pattern` can match: for each top-level
 * alternative, its longest required literal of at least {@link MIN_DERIVED_HINT_CHARS}. For a
 * case-insensitive pattern they are lower-cased, and the caller searches a lower-cased copy.
 */
export function deriveHints(pattern: RegExp): { hints: string[]; caseInsensitive: boolean } {
  const caseInsensitive = pattern.flags.includes("i");
  const hints = new Set<string>();
  for (const alternative of alternatives(pattern.source)) {
    let best = "";
    for (const run of literalRuns(alternative)) {
      if (run.length > best.length) best = run;
    }
    if (best.length >= MIN_DERIVED_HINT_CHARS) hints.add(caseInsensitive ? best.toLowerCase() : best);
  }
  return { hints: [...hints], caseInsensitive };
}
