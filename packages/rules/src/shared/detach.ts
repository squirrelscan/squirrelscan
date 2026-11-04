/**
 * A copy of `text` that shares no storage with the string it was cut from. A slice keeps its whole parent alive in the engines'
 * string representations (an attribute value or a finding's `value` can be a slice of the page's serialized HTML, megabytes), so a
 * record kept until the site rule runs would hold its whole page. Built from the characters, which also keeps a lone surrogate
 * that a cut through a pair leaves (a UTF-8 round trip would replace it).
 */
export function detached(text: string): string {
  return text.length === 0 ? text : text.split("").join("");
}

/** A copy of a string array with every string detached (see {@link detached}). */
export function detachedList(list: readonly string[]): string[] {
  return list.map(detached);
}

/** A copy of a string set with every member detached, in the same iteration order. */
export function detachedSet(set: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const value of set) out.add(detached(value));
  return out;
}
