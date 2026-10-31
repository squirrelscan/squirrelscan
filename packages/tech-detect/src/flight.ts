// What a Next.js App Router flight payload says it loads (#1437).
//
// `self.__next_f.push([1,"..."])` carries everything the page renders into its React tree, as RSC rows,
// and a production build splits it over many `<script>` elements, cutting rows mid-row. Reading it as text
// finds the layout's `next/script` loader, and also a vendor URL that only appears as content (a JSON-LD
// `sameAs`, a meta description, a CSP `<meta>`, a link, prose). So the chunks of ALL the page's flight
// scripts are decoded and joined in order, the rows are parsed, and only what a script carries is kept:
// the `src`, the inline `__html` and the string `children` of a `script` element, or of a component whose
// props have the shape of `next/script` (a production build names it `$L2` with a numeric module id, so the
// shape, not the module path, identifies it). Data scripts (JSON-LD and the other data types) and every
// other element's props are not read.

/** Longest decoded flight text read, in characters. */
const MAX_DECODED_CHARS = 8 * 1024 * 1024;
/** Deepest and largest value tree walked; a hostile payload is cut there. */
const MAX_DEPTH = 64;
const MAX_NODES = 400_000;
const PUSH = "push([1,";
const SCRIPT_MODULE = /next\/(?:dist\/client\/)?script/;
const ROW_ID = /^([0-9a-f]{1,16}):/;
const COMPONENT_REF = /^\$L([0-9a-f]{1,16})$/;

/** Whether a script body has a `push([1,"..."])` chunk, the form that carries RSC rows. */
export function hasFlightChunk(body: string): boolean {
  const at = body.indexOf(PUSH);
  return at !== -1 && body[at + PUSH.length] === '"';
}

/** The decoded text of every `push([1,"..."])` chunk of a flight script, into `parts`; false past the cap. */
function decodeChunks(body: string, parts: string[], used: { total: number }): boolean {
  let from = 0;
  for (;;) {
    const at = body.indexOf(PUSH, from);
    if (at === -1) break;
    const open = at + PUSH.length;
    from = open;
    if (body[open] !== '"') continue;
    let i = open + 1;
    while (i < body.length && body[i] !== '"') i += body[i] === "\\" ? 2 : 1;
    if (i >= body.length) break;
    from = i + 1;
    try {
      const text: unknown = JSON.parse(body.slice(open, i + 1));
      if (typeof text === "string") {
        used.total += text.length;
        if (used.total > MAX_DECODED_CHARS) return false;
        parts.push(text);
      }
    } catch {
      // A chunk that is not a JSON string is not read.
    }
  }
  return true;
}

type Json = unknown;

const hasText = (v: Json): v is string => typeof v === "string" && v.length > 0;

/**
 * Whether a `$L<id>` component is `next/script` by its props: a `strategy`, an `id` with inline code (`__html`,
 * or `children` that is code, not prose: it has a call and a statement end or a block), or a `src` URL. A dev
 * build also names the module (`next/dist/client/script`), which counts too.
 */
function isScriptComponent(ref: string, props: Record<string, Json>, modules: Set<string>): boolean {
  if (modules.has(ref)) return true;
  if (typeof props.strategy === "string") return true;
  if (hasText(props.src)) return true;
  if (!hasText(props.id)) return false;
  const inner = props.dangerouslySetInnerHTML;
  if (isObject(inner) && hasText(inner.__html)) return true;
  const code = props.children;
  return hasText(code) && code.includes("(") && (code.includes(";") || code.includes("{"));
}
const isObject = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The strings the script elements of a page's flight payload carry (loader URLs and inline loader code),
 * one per line. `bodies` are the page's flight scripts in document order. `isData` says whether a script
 * `type` holds data rather than code.
 */
export function flightLoaderText(bodies: readonly string[], isData: (type: string) => boolean): string {
  const parts: string[] = [];
  const used = { total: 0 };
  for (const body of bodies) if (!decodeChunks(body, parts, used)) break;
  const rows = parts.join("").split("\n");
  const scriptModules = new Set<string>();
  for (const row of rows) {
    const id = ROW_ID.exec(row)?.[1];
    if (id && row.startsWith("I[", id.length + 1) && SCRIPT_MODULE.test(row.slice(0, 512))) scriptModules.add(id);
  }
  const out: string[] = [];
  let nodes = 0;
  const collect = (v: Json): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const s of v) if (typeof s === "string") out.push(s);
  };
  for (const row of rows) {
    const id = ROW_ID.exec(row);
    if (!id) continue;
    const payload = row.slice(id[0].length);
    if (payload[0] !== "[" && payload[0] !== "{") continue;
    let root: Json;
    try {
      root = JSON.parse(payload);
    } catch {
      continue;
    }
    const stack: Array<{ node: Json; depth: number }> = [{ node: root, depth: 0 }];
    while (stack.length > 0) {
      const { node, depth } = stack.pop()!;
      if (++nodes > MAX_NODES) return out.join("\n");
      if (depth > MAX_DEPTH || typeof node !== "object" || node === null) continue;
      if (Array.isArray(node)) {
        const [marker, type, , props] = node;
        if (marker === "$" && typeof type === "string" && isObject(props)) {
          const ref = COMPONENT_REF.exec(type)?.[1];
          if (type === "script" || (ref !== undefined && isScriptComponent(ref, props, scriptModules))) {
            const kind = props.type;
            if (!(typeof kind === "string" && isData(kind.slice(0, 256)))) {
              if (typeof props.src === "string") out.push(props.src);
              const inner = props.dangerouslySetInnerHTML;
              if (isObject(inner) && typeof inner.__html === "string") out.push(inner.__html);
              collect(props.children);
            }
          }
          // Elements nest (`head` and `body` hold scripts): look inside every prop that is a value tree.
          for (const value of Object.values(props)) {
            if (typeof value === "object" && value !== null) stack.push({ node: value, depth: depth + 1 });
          }
          continue;
        }
        for (const item of node) if (typeof item === "object" && item !== null) stack.push({ node: item, depth: depth + 1 });
      } else {
        for (const value of Object.values(node)) {
          if (typeof value === "object" && value !== null) stack.push({ node: value, depth: depth + 1 });
        }
      }
    }
  }
  return out.join("\n");
}
