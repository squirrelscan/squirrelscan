// Merging the MESSAGES of check instances that belong in one group.
//
// A check runs per page, so one finding arrives as many near-identical
// sentences that differ only in their per-page counts. Showing them as one row
// needs two things: whether two sentences may be merged at all, and what the
// merged sentence says.
//
// This lives in its own module because the cloud API groups the same findings
// from its own store and has to reach the same answer. It had its own copy of
// the old placeholder rule, which is how the two surfaces ended up printing
// different text for one finding (#2231). One implementation, two callers.

/**
 * One COUNT in a check message, merged across the pages that produced it.
 * `text` is the digits exactly as the first page wrote them, kept so a count
 * every page agrees on renders byte-identically to its original.
 */
export interface MergedCount {
  min: number;
  max: number;
  text: string;
}

/** What a message looks like once its counts are pulled out. */
export interface MessageShape {
  /** The literal text between the counts: n+1 parts. */
  parts: string[];
  counts: MergedCount[];
  /** parts joined by `#`: two messages merge only if these match exactly. */
  key: string;
}

const DIGIT_RUN_RE = /\d+/g;

// A character that makes the digits beside it part of something else: a word
// (`H1`, `4KB`), a decimal or version (`4.3`), a date or a negative (`2024-01`,
// `-5`), a time (`05:30`), a ratio (`10/10`), a grouped number (`1,024`).
const GLUED_RE = /[A-Za-z0-9._:/,-]/;

// Beyond this many digits a value does not survive a round trip through
// `Number`, so it is never treated as a count.
const SAFE_DIGITS = 15;

/**
 * Is this digit run a COUNT, and therefore something two pages may legitimately
 * disagree about without changing what the sentence says?
 *
 * Only a count may widen into a range. Everything else — a date, a decimal, a
 * digit inside a word, an identifier, a negative, a zero-padded code — is part
 * of a statement, and widening it invents a fact. `The URL says 2019 but the
 * schema dates are from 2018` would become `The URL says 2019 to 2024 …`,
 * which reads as true and is not; the old `N` placeholder at least announced
 * its own failure. So a token that is not a count never widens, and two pages
 * that disagree about one do not merge at all: each keeps its own true message
 * (#2231).
 *
 * A count is a standalone integer that either counts the noun after it
 * (`3 image(s)`) or stands alone in parentheses (`Multiple H1 tags found (3)`).
 */
export function isCountToken(message: string, start: number, end: number): boolean {
  const text = message.slice(start, end);
  if (text.length > SAFE_DIGITS) return false;
  // `007` is a code, not a count: widening it would drop the padding too.
  if (text.length > 1 && text.startsWith("0")) return false;
  // A four-digit year is indistinguishable from a count of that many things,
  // and getting it wrong writes a false date, so it is never widened.
  if (text.length === 4 && Number(text) >= 1000 && Number(text) <= 2999) return false;
  // Only the character BEFORE needs testing against the glue set: the two
  // positive tests below already demand a space or a `)` after the run, so a
  // `.`, `-`, `:`, `/`, `,` or letter on the right can never reach them. The
  // left is where `H1`, `-5`, `4.3` and `2024-01` are caught.
  if (GLUED_RE.test(message[start - 1] ?? "")) return false;
  // Alone in parentheses.
  if (message[start - 1] === "(" && message[end] === ")") return true;
  // In front of the thing it counts.
  return message[end] === " " && /[A-Za-z]/.test(message[end + 1] ?? "");
}

/** Split a message into its literal parts and its counts. */
export function shapeOf(message: string): MessageShape {
  const parts: string[] = [];
  const counts: MergedCount[] = [];
  let cut = 0;
  DIGIT_RUN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DIGIT_RUN_RE.exec(message)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (!isCountToken(message, start, end)) continue;
    parts.push(message.slice(cut, start));
    const value = Number(match[0]);
    counts.push({ min: value, max: value, text: match[0] });
    cut = end;
  }
  parts.push(message.slice(cut));
  return { parts, counts, key: parts.join("#") };
}

/**
 * The merged message: every count the pages agree on printed as it was
 * written, every count they disagree on printed as the range it covers.
 *
 * A range rather than a total. These counts are per page, and a site-level
 * total would be a different number from any of them; the page count the
 * renderers show beside the message is what says how many pages contributed.
 */
export function renderMergedMessage(shape: MessageShape): string {
  let out = shape.parts[0] ?? "";
  for (const [index, count] of shape.counts.entries()) {
    out += count.min === count.max ? count.text : `${count.min} to ${count.max}`;
    out += shape.parts[index + 1] ?? "";
  }
  return out;
}

/**
 * The grouping key for a message: its literal text with every COUNT removed.
 *
 * Two messages may be merged only if their keys are equal. The key is not a
 * display string and its shape is not part of the contract; compare keys,
 * never parse them.
 */
export function messageMergeKey(message: string): string {
  return shapeOf(message).key;
}

/**
 * Merge the messages of one group into the single sentence that is true of all
 * of them, or `null` when there is no such sentence.
 *
 * Counts every message agrees on print exactly as they were written. Counts
 * they disagree on print as the range they cover. Anything else that differs
 * (wording, a date, a decimal, a digit inside a word) means the messages make
 * different claims and must not be merged at all: `null`, and the caller shows
 * them separately or shows nothing.
 *
 * Pass EVERY message in the group. The range is computed across the values it
 * is given, so a caller that passes a sample gets a range that covers the
 * sample and silently understates the rest.
 */
export function mergeCheckMessages(messages: string[]): string | null {
  const first = messages[0];
  if (first === undefined) return null;
  const merged = shapeOf(first);
  for (let i = 1; i < messages.length; i++) {
    const next = shapeOf(messages[i]!);
    if (next.key !== merged.key) return null;
    for (const [index, incoming] of next.counts.entries()) {
      const slot = merged.counts[index];
      if (!slot) continue;
      slot.min = Math.min(slot.min, incoming.min);
      slot.max = Math.max(slot.max, incoming.max);
    }
  }
  return renderMergedMessage(merged);
}
