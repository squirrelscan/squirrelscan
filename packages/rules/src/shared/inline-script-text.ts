// The text of a page's inline scripts, read once (squirrelscan/repo#1864).
//
// On a script-heavy page most of the HTML is inline script: about 800 KB of a
// 1.1 MB storefront page. A rule that scans every inline script AND the whole
// page (as text or serialised) reads that 800 KB twice, and the second read
// finds nothing the first did not: the scripts are inside the HTML. The helpers
// here let such a rule take the script bodies it has already scanned out of the
// whole-page text before scanning it, so each script's text is read once.

/** The open tag that every serialised and raw `<script>` element starts with. */
const SCRIPT_OPEN = "<script";
const SCRIPT_CLOSE = "</script>";

/**
 * Where each of `texts` sits in `html` as the body of a `<script>` element, in
 * order: `[start, end)` per text that was found, skipped when it was not.
 *
 * `texts` are the bodies of script elements in document order (what a rule read
 * from `script.textContent`), and `html` is the page they came from, serialised
 * (`doc.toString()`) or raw. A script's text appears in either verbatim: script
 * content is raw text, never escaped. A text is only taken where it is exactly
 * the whole body of a `<script …>…</script>` element that starts after the
 * previous one ended, so a copy of the same text elsewhere (an attribute, a
 * comment, an earlier identical script) cannot be taken for it: a body that
 * cannot be placed is left in the HTML, which costs a second read of that one
 * script and nothing else.
 */
export function scriptBodySpans(html: string, texts: readonly string[]): Array<[start: number, end: number]> {
  const spans: Array<[number, number]> = [];
  let cursor = 0;
  for (const text of texts) {
    if (text.length === 0) continue;
    let from = cursor;
    for (;;) {
      const at = html.indexOf(text, from);
      if (at < 0) break;
      const end = at + text.length;
      const open = html.lastIndexOf(SCRIPT_OPEN, at);
      if (
        html.charCodeAt(at - 1) === 62 /* > */ &&
        open >= cursor &&
        html.indexOf(">", open) === at - 1 &&
        html.startsWith(SCRIPT_CLOSE, end)
      ) {
        spans.push([at, end]);
        cursor = end + SCRIPT_CLOSE.length;
        break;
      }
      from = at + 1;
    }
  }
  return spans;
}

/**
 * `html` with each span replaced by the same number of spaces, except that a
 * span longer than `keep` is blanked to exactly `keep` spaces and the rest of it
 * is cut. For any reader whose reach from a position is at most `keep` characters,
 * a run of `keep` spaces and a longer run of spaces read the same, so the result
 * scans exactly as the fully blanked text does, in a fraction of the length.
 * `cut` lists how many characters each shortened span lost, in order: hand it to
 * {@link blankedOffsets} to turn an offset into the shortened text back into an
 * offset into the fully blanked one.
 */
export function blankAndCutSpans(
  html: string,
  spans: ReadonlyArray<readonly [number, number]>,
  keep: number
): { text: string; cut: number[] } {
  if (spans.length === 0) return { text: html, cut: [] };
  const parts: string[] = [];
  const cut: number[] = [];
  const filler = " ".repeat(keep);
  let at = 0;
  for (const [start, end] of spans) {
    const length = end - start;
    parts.push(html.slice(at, start));
    if (length > keep) {
      parts.push(filler);
      cut.push(length - keep);
    } else {
      parts.push(" ".repeat(length));
    }
    at = end;
  }
  parts.push(html.slice(at));
  return { text: parts.join(""), cut };
}

/**
 * Maps an offset into `text` (a page whose long script bodies were blanked to
 * `keep` spaces, as {@link blankAndCutSpans} or a serialiser does, possibly
 * transformed afterwards by something that leaves runs of spaces and the
 * `>`/`</script>` around them alone) to the offset the same character has in the
 * fully blanked text. Each shortened span is found again as `>`, `keep` spaces
 * and `</script>`, in order. Null when they cannot all be found, which leaves
 * the offsets as they are.
 */
export function blankedOffsets(text: string, cut: readonly number[], keep: number): ((offset: number) => number) | null {
  if (cut.length === 0) return (offset) => offset;
  const needle = `>${" ".repeat(keep)}${SCRIPT_CLOSE}`;
  // After the i-th shortened span (at and past `ends[i]`), offsets move by `shift[i]`.
  const ends: number[] = [];
  const shift: number[] = [];
  let from = 0;
  let total = 0;
  for (const lost of cut) {
    const at = text.indexOf(needle, from);
    if (at < 0) return null;
    const end = at + 1 + keep;
    total += lost;
    ends.push(end);
    shift.push(total);
    from = end;
  }
  return (offset) => {
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid]! <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? offset : offset + shift[lo - 1]!;
  };
}
