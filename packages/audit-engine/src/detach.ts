// Detaching retained values from the page they came from (#1860).

/**
 * Copy a per-page value so it stops referencing the page it came from (#1860).
 *
 * Every string a rule pulls out of a parsed page — an href, an anchor's text, a
 * matched secret — is produced by slicing the page's HTML, and JSC keeps those
 * slices attached to the buffer they came from. Retaining ONE of them retains
 * the whole page as UTF-16. Measured on a real 959 KB page: the collected
 * signal is about 1 KB of actual data and holds 3.8 MB.
 *
 * That is invisible in every obvious measure. `JSON.stringify(signal).length`
 * says 1 KB, `process.memoryUsage().rss` says nothing at all because the arena
 * absorbs it, and it only appears in `heapUsed`/`external` — which is why a
 * production run at 149 pages held ~8 MB per page while a local census of the
 * same structures reported 96 KB.
 *
 * `structuredClone` is what detaches them: it serializes, so every string comes
 * out fresh, and unlike a JSON round-trip it preserves the `Set`s in
 * `PageFingerprint` rather than silently turning them into `{}`. Measured on the
 * same fixture, the collected signal goes from 3841 KB to 322 KB per page with
 * identical values and identical types.
 *
 * Applied only where a value OUTLIVES its batch. Inside a batch the page is
 * resident anyway and a copy would be pure cost.
 */
export function detachFromPage<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    // A value carrying something non-cloneable (a function, a DOM node) would
    // throw. Keeping the original is the safe answer: it costs the retention
    // this exists to avoid, but it cannot change what the audit reports.
    return value;
  }
}

