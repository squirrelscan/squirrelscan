// Bound over-length check-item ids to the report's medium-string cap (#996).

import { CHECK_DETAILS_LIMITS, REPORT_LIMITS } from "./limits";

// Deterministic non-crypto 53-bit string hash (cyrb53-style; mixing order
// diverges slightly from the reference — reference parity doesn't matter here,
// only cross-runtime determinism does). Pure integer math so
// CLI (Bun), cloud container (Node) and the API schema (CF Worker) all produce
// the SAME digest for a given id — the clamp must be identical everywhere or a
// producer-clamped id and a server-clamped id would diverge and defeat dedup.
function hashString(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Truncate to at most `max` UTF-16 code units WITHOUT splitting a surrogate
 * pair. `String.prototype.slice` cuts by code unit, so slicing through an emoji
 * (2 units) leaves a lone high surrogate — a broken "�" that corrupts the
 * display and any hash/dedup keyed on the text. zod's `.max()` counts UTF-16
 * units too, so we must stay ≤ `max` units (a code-point count could overshoot
 * on astral chars and re-trip the reject we are avoiding); we only back off one
 * unit when the boundary would orphan a leading surrogate.
 */
function truncateUtf16(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  const code = value.charCodeAt(max - 1);
  // High surrogate at the cut point → its trailing half is being dropped; drop
  // the orphaned high surrogate too (result becomes max-1 units, still ≤ max).
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return value.slice(0, end);
}

/**
 * Clamp an over-length check-item `id` to `max` chars (#996). Rules emit raw
 * URLs / selectors as ids (a `data:` URL image src blows past 1000 chars), which
 * the publish schema used to REJECT — failing the whole audit. Truncating alone
 * would collide two distinct long ids into one, and fold/merge + the server
 * smart-audits union dedupe items BY id, so append a stable short hash of the
 * full id to keep clamped ids unique. Deterministic: same input → same output on
 * every runtime, so producer-side and server-side clamps agree.
 *
 * Uniqueness is PROBABILISTIC, not absolute: two distinct oversize ids collide
 * only when their retained prefixes AND 53-bit hashes both match (~n²/2^54 —
 * negligible per dedupe scope), and the cost is two report items displaying
 * merged; accepted over collision-detection machinery at the fold boundary.
 */
export function clampItemId(id: string, max: number = REPORT_LIMITS.maxMediumString): string {
  if (id.length <= max) return id;
  const suffix = `~${hashString(id).toString(36)}`;
  if (suffix.length >= max) return truncateUtf16(id, max);
  return truncateUtf16(id, max - suffix.length) + suffix;
}

/** Plain truncate for check-item strings that need no uniqueness (e.g. `label`). */
export function clampItemString(
  value: string,
  max: number = REPORT_LIMITS.maxMediumString,
): string {
  return truncateUtf16(value, max);
}

// ── Free-form `details` record clamp (#1288) ────────────────────

export interface DetailsClampLimits {
  maxDepth: number;
  maxKeysPerLevel: number;
  maxStringLength: number;
  maxNodes: number;
  maxBytes: number;
}

const DEFAULT_DETAILS_LIMITS: DetailsClampLimits = {
  maxDepth: CHECK_DETAILS_LIMITS.maxDepth,
  maxKeysPerLevel: CHECK_DETAILS_LIMITS.maxKeysPerLevel,
  maxStringLength: REPORT_LIMITS.maxMediumString,
  maxNodes: CHECK_DETAILS_LIMITS.maxNodes,
  maxBytes: CHECK_DETAILS_LIMITS.maxBytes,
};

// Mutable box threaded through the recursion so every level can report "did
// I actually change anything" without allocating a {value, changed} pair per
// call. Lets clampDetailsValue return the ORIGINAL reference (at every level,
// all the way up) when nothing needed clamping — same "same reference when
// under cap" contract as clampCheckStrings/clampCheckItemIds, so a report
// with well-formed `details` throughout never re-allocates or reorders.
//
// NOTE: `changed` is GLOBAL to the whole tree, not per-subtree — once any
// node anywhere needs clamping, every node processed afterward also
// rebuilds (a fresh but content-identical object), even ones with nothing
// of their own to change. Only the TOP-LEVEL "same reference when NOTHING
// in the whole record needed clamping" guarantee is load-bearing (and
// tested); nested reference stability on a record that DID need clamping
// somewhere is not part of the contract.
//
// `visited` is the maxNodes budget's running counter — see clampDetailsValue.
interface ClampState {
  changed: boolean;
  visited: number;
}

/**
 * Recursively bound one value inside a `details` tree. Only CONTAINERS
 * (object/array) are subject to the depth cutoff — a primitive at any depth
 * always survives (strings individually length-clamped) because a lone
 * string/number/boolean can't recurse further regardless of how deep it
 * sits; the actual unbounded-blowup risk is container nesting, so that's
 * what maxDepth bounds. `maxKeysPerLevel` doubles as both the object
 * key-count cap and the array-length cap (details records rarely need more
 * than a handful of entries at any one level).
 *
 * Off-by-one note: the `details` record itself is depth 0 (see
 * clampDetailsRecord's initial call below), and the cutoff is `depth >
 * maxDepth` (strictly greater, so depth === maxDepth still passes) — so
 * `maxDepth: 3` actually permits container nesting through depth 3 (4
 * levels: 0, 1, 2, 3) before pruning a container at depth 4. Read it as
 * "3 levels of nesting BELOW the record itself," not "3 containers total."
 *
 * maxDepth/maxKeysPerLevel bound per-axis worst case, but they MULTIPLY —
 * up to maxKeysPerLevel^4 leaf nodes (160,000 at the production defaults) —
 * so `state.visited` tracks TOTAL nodes seen across the whole call and this
 * short-circuits once `maxNodes` is exceeded, independent of how depth/width
 * combine. This is what actually bounds the structural pass's worst-case
 * work; maxDepth/maxKeysPerLevel alone do not (see CHECK_DETAILS_LIMITS'
 * doc for the full worst-case accounting).
 */
function clampDetailsValue(
  value: unknown,
  depth: number,
  limits: DetailsClampLimits,
  state: ClampState,
): unknown {
  state.visited++;
  if (state.visited > limits.maxNodes) {
    state.changed = true;
    return undefined;
  }
  if (value === null) return null;
  const t = typeof value;
  if (t === "string") {
    const clamped = clampItemString(value as string, limits.maxStringLength);
    if (clamped !== value) state.changed = true;
    return clamped;
  }
  if (t === "number" || t === "boolean") return value;
  if (t !== "object") {
    // function/symbol/bigint/undefined: not JSON-safe anyway (JSON.stringify
    // would already drop these) — strip explicitly so callers that inspect
    // the clamped object directly (not just its serialized form) see the
    // same shape a round-trip through JSON would produce. NOTE: dropping an
    // array ELEMENT (vs an object KEY) shifts subsequent indices rather than
    // leaving a `null` slot the way a JSON round-trip would — a cosmetic
    // divergence no audited rule-emitted shape relies on.
    state.changed = true;
    return undefined;
  }
  if (depth > limits.maxDepth) {
    state.changed = true;
    return undefined;
  }

  if (Array.isArray(value)) {
    const sliced = value.length > limits.maxKeysPerLevel;
    if (sliced) state.changed = true;
    const source = sliced ? value.slice(0, limits.maxKeysPerLevel) : value;
    const out: unknown[] = [];
    for (const el of source) {
      const clamped = clampDetailsValue(el, depth + 1, limits, state);
      if (clamped === undefined) {
        state.changed = true;
      } else {
        out.push(clamped);
      }
    }
    return state.changed ? out : value;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const sliced = entries.length > limits.maxKeysPerLevel;
  if (sliced) state.changed = true;
  // Scalar (number/boolean/null) entries go FIRST — UNCONDITIONALLY, not
  // only when this level's own key count trips `sliced`. Two attacks this
  // defeats, both against the bookkeeping numbers scoring/issue-sync read
  // (`additional`/`occurrences`/`pagesTruncated` — the one class of value
  // this clamp must never silently lose, see clampCheckItemsOverflow/
  // foldOverflowChecks in packages/rules/src/fold.ts):
  // 1. Key-count trim: a naive insertion-order slice(0, N) would drop a
  //    LATE-ordered bookkeeping key behind ≥maxKeysPerLevel other keys.
  // 2. Node-budget drain: `state.visited` is GLOBAL and traversal is
  //    depth-first in entry order, so an earlier-ordered sibling subtree
  //    that is within every per-axis cap (depth ≤ maxDepth, width ≤
  //    maxKeysPerLevel at each level still multiplies to thousands of
  //    nodes) can exhaust maxNodes before a later scalar sibling is ever
  //    visited — and the budget cutoff above runs before the scalar
  //    passthrough, so the scalar would be dropped like any other node.
  //    Key order is attacker-controlled at the publish boundary. Visiting
  //    scalars first means they are counted against the budget before any
  //    sibling subtree can drain it (each costs exactly 1 node, and a level
  //    holds at most maxKeysPerLevel of them — they always fit).
  // Cost: a REBUILT level emits scalars ahead of the original key order.
  // That's consistent with the sliced path's established behavior and with
  // clampToByteBudget below, and a rebuilt object only exists when
  // something needed clamping — the untouched case returns the original
  // reference with its order intact.
  const prioritized = prioritizeScalars(entries);
  const source = sliced ? prioritized.slice(0, limits.maxKeysPerLevel) : prioritized;
  // Object.create(null), NOT {}: `details` is attacker-controlled and comes
  // through JSON.parse, which happily creates a real OWN property literally
  // named "__proto__" (JSON.parse never invokes the exotic accessor). But
  // bracket-assigning `out["__proto__"] = v` onto a PLAIN `{}` (which has
  // Object.prototype in its chain) DOES invoke that accessor's setter —
  // silently dropping the key from Object.keys/JSON.stringify AND, if `v` is
  // an object, repointing `out`'s own prototype to it, so later reads like
  // `out.additional` can resolve to an attacker-supplied value via
  // inheritance without ever being an own property (exactly the class of
  // bug this clamp exists to prevent, via a vector its own tests didn't
  // cover). A null-prototype accumulator has no inherited accessor to
  // trigger, so bracket assignment is always a plain own-property write.
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, v] of source) {
    const clamped = clampDetailsValue(v, depth + 1, limits, state);
    if (clamped === undefined) {
      state.changed = true;
    } else {
      out[key] = clamped;
    }
  }
  return state.changed ? out : value;
}

function isScalarValue(v: unknown): boolean {
  return v === null || typeof v === "number" || typeof v === "boolean";
}

/** Stable partition: every scalar entry first (original relative order preserved), then the rest. */
function prioritizeScalars(entries: [string, unknown][]): [string, unknown][] {
  const scalars: [string, unknown][] = [];
  const rest: [string, unknown][] = [];
  for (const entry of entries) (isScalarValue(entry[1]) ? scalars : rest).push(entry);
  return [...scalars, ...rest];
}

/**
 * Drop top-level entries until the serialized record fits `maxBytes` — the
 * backstop for when depth/key-count alone still multiply out to something
 * too large (see CHECK_DETAILS_LIMITS' doc). Scalar (number/boolean/null)
 * entries are kept unconditionally: they're the bookkeeping keys scoring
 * (`additional`) and issue-sync (`occurrences`/`pagesTruncated`) read, and a
 * handful of numbers can never be WHY the budget was blown (the structural
 * pass already caps the record to at most `maxKeysPerLevel` top-level keys).
 * Non-scalar entries are added back in original order, stopping at the first
 * one that would overflow — simple and predictable over an optimal packing.
 *
 * Coarser than every other clamp in this file: this DROPS an entire
 * over-budget key rather than partially truncating its content (there's no
 * per-key byte sub-budget to truncate INTO). In practice this branch is a
 * pathological-input backstop, not a real-world path — real rule-emitted
 * `details` (176 shapes audited for #1288) are all well under `maxBytes` on
 * their own, so the structural pass alone already returns unchanged for
 * every one of them and this function never has anything to trim. No
 * ClampState param: the caller only ever uses this call's RETURN value
 * (never reads `state` afterward), and this function has its own
 * independent same-reference guarantee via the early `return record` below.
 */
function clampToByteBudget(
  record: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  const byteSize = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;
  if (byteSize(record) <= maxBytes) return record;

  const scalarEntries: [string, unknown][] = [];
  const otherEntries: [string, unknown][] = [];
  for (const entry of Object.entries(record)) {
    (isScalarValue(entry[1]) ? scalarEntries : otherEntries).push(entry);
  }

  // Object.create(null) — same prototype-pollution rationale as
  // clampDetailsValue's object branch above: bracket-assigning a
  // "__proto__" key onto a normal `{}` would trigger Object.prototype's
  // exotic setter instead of creating an own property.
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of scalarEntries) out[key] = value;
  for (const [key, value] of otherEntries) {
    // Object-literal spread (unlike bracket assignment) always creates OWN
    // properties via CreateDataProperty, so this candidate check is safe
    // regardless of `key` — only the `out[key] = value` write below needed
    // the null-prototype accumulator.
    const candidate = { ...out, [key]: value };
    if (byteSize(candidate) > maxBytes) break;
    out[key] = value;
  }
  return out;
}

/**
 * Bound a free-form check `details` record (#1288) — the remaining unclamped
 * hole after #1216/#1263: every OTHER display field on a check is a clamped
 * string or a truncated array, but `details` is `z.record(z.unknown())` with
 * no fixed shape to clamp a single string against. Structural
 * clamp-transform, never a reject (same posture as every other #1216/#1263
 * clamp): depth-limit prunes over-deep container nesting, a key-count cap
 * bounds width at every level, a total node-visit budget bounds the WORK the
 * structural pass does (depth × width alone multiply past what either bounds
 * individually — see CHECK_DETAILS_LIMITS' doc), string leaves are
 * individually clamped, and a final byte-budget pass backstops a record
 * that's within maxNodes but still serializes large. See
 * {@link clampDetailsValue} and {@link clampToByteBudget} for the exact
 * per-pass behavior.
 *
 * Returns the SAME reference when nothing needed clamping (mirrors
 * clampCheckStrings/clampCheckItemIds — avoids reorder/content-hash churn on
 * the common case, which every real rule-emitted `details` hits).
 *
 * Non-object input (`details` isn't actually a record — a caller sent a raw
 * string/array/etc) is returned UNCHANGED: this function only bounds a
 * valid-shaped-but-oversized record, it does not do type validation. The
 * schema `z.record(z.unknown())` this feeds into still rejects a wrong type
 * exactly as before.
 */
export function clampDetailsRecord(
  details: unknown,
  limits: DetailsClampLimits = DEFAULT_DETAILS_LIMITS,
): unknown {
  if (!details || typeof details !== "object" || Array.isArray(details)) return details;
  const state: ClampState = { changed: false, visited: 0 };
  const structural = clampDetailsValue(details, 0, limits, state) as Record<string, unknown>;
  return clampToByteBudget(structural, limits.maxBytes);
}
