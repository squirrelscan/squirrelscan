// Object keys that must never be written through bracket notation onto a plain
// `{}` when they came from an audited page, a response header, or a config file.
//
// The crawler turns untrusted documents into objects constantly: JSON-LD blocks,
// `.well-known/*.json`, sitemap XML, response headers, `<meta name=…>` maps. All
// of those key spaces are chosen by whoever owns the site being audited.
//
// Two distinct hazards, and only the first is a "pollution" in the usual sense:
//
//  1. `target[key] = value` where `target` is a plain `{}` invokes the inherited
//     `__proto__` setter instead of creating an own property. With an object
//     value that repoints `target`'s prototype; with a string value it is a
//     silent no-op and the key vanishes from `Object.keys`/`JSON.stringify`.
//  2. Walking INTO `target[key]` — a dotted-path setter or a recursive merge —
//     resolves `__proto__`/`constructor.prototype` through the chain and hands
//     back `Object.prototype` itself. A write there is a real global pollution.
//
// The fix depends on which shape a call site has:
//
//  - Accumulating untrusted keys into a fresh map → `Object.create(null)`. A
//    null-prototype object has no inherited accessor to trigger, so bracket
//    assignment is always a plain own-property write and nothing is dropped.
//  - Walking into or merging onto an object you did not create → skip these
//    keys explicitly, because the traversal target is a caller-supplied object
//    that still has `Object.prototype` in its chain.
//
// Note `JSON.parse` itself is safe: it builds properties with CreateDataProperty,
// so `{"__proto__": {…}}` becomes a real own property and the parsed object's
// prototype is untouched. The danger is only in what we copy that key ONTO.
// Object-literal spread and `Object.fromEntries` are safe for the same reason.

/**
 * Keys that resolve to `Object.prototype` (or repoint a prototype) when used
 * with bracket notation on an object that inherits from `Object.prototype`.
 */
export const UNSAFE_OBJECT_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

const UNSAFE_OBJECT_KEY_SET: ReadonlySet<string> = new Set(UNSAFE_OBJECT_KEYS);

/**
 * True when `key` must not be used to index or assign into an object that
 * inherits from `Object.prototype`.
 *
 * Only for the "walk into / merge onto a caller's object" shape. Call sites that
 * build a fresh accumulator should use `Object.create(null)` instead and keep
 * every key, including these three.
 */
export function isUnsafeObjectKey(key: string): boolean {
  return UNSAFE_OBJECT_KEY_SET.has(key);
}
