/**
 * Drop every trailing `charCode` from `value`, in one linear pass.
 *
 * Replaces `value.replace(/x+$/, "")` on strings an attacker controls (a link host, a URL path, a srcset
 * candidate): that pattern retries from every `x` of a long run and is quadratic (CodeQL js/polynomial-redos).
 */
export function trimTrailing(value: string, charCode: number): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === charCode) end--;
  return end === value.length ? value : value.slice(0, end);
}
