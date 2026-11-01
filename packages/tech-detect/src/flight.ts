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

/** A JavaScript token that prose does not have: inline loader code, not text with a bracket in it. */
const CODE_TOKEN = /\bfunction\b|=>|[\w\])]\s*=[^=]|\.createElement|\bwindow\.|\bdocument\./;

/**
 * Whether a `$L<id>` component is `next/script` by its props: a `strategy`, an `id` with inline code (`__html`,
 * or string `children` that has a JavaScript token), or a `src` URL beside a `strategy` or an `id`. A bare `src`
 * is any embed or image component. A dev build also names the module (`next/dist/client/script`), which counts.
 */
function isScriptComponent(ref: string, props: Record<string, Json>, modules: Set<string>): boolean {
  if (modules.has(ref)) return true;
  if (typeof props.strategy === "string") return true;
  if (!hasText(props.id)) return false;
  if (hasText(props.src)) return true;
  const inner = props.dangerouslySetInnerHTML;
  if (isObject(inner) && hasText(inner.__html)) return true;
  const children = Array.isArray(props.children) ? props.children.find((c): c is string => typeof c === "string" && c.length > 0) : props.children;
  if (!hasText(children)) return false;
  const code = children.slice(0, 64 * 1024);
  // Prose has a bracket and a semicolon too, so a call and a statement end or block are required AND a token
  // that is code (the word `function`, `window.` or a `?query=` in prose is not).
  return code.includes("(") && (code.includes(";") || code.includes("{")) && CODE_TOKEN.test(code);
}

interface FlightRow {
  id: string;
  payload: string;
}

/** UTF-8 bytes of the code unit at `i` of `text` (a surrogate pair counts 4 bytes over its two units). */
function utf8Units(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  if (c >= 0xd800 && c <= 0xdbff) return 2; // high surrogate: 4 bytes for the pair, counted on the first unit
  if (c >= 0xdc00 && c <= 0xdfff) return 2; // low surrogate: the other 2 bytes
  return 3;
}

const TEXT_ROW_HEAD = /^([0-9a-f]{1,16}):T([0-9a-f]{1,10}),/;

/**
 * The rows of the joined flight text. A row is `id:payload` up to a newline, except a text row, which React
 * emits for a string of 1 KB or more: `id:T<hex byte length>,<text>`, the text running for exactly that many
 * UTF-8 bytes, newlines included. Text rows are returned by id; the rest are the line rows to parse.
 */
function parseRows(text: string): { rows: FlightRow[]; texts: Map<string, string> } {
  const rows: FlightRow[] = [];
  const texts = new Map<string, string>();
  let pos = 0;
  while (pos < text.length) {
    const head = TEXT_ROW_HEAD.exec(text.slice(pos, pos + 40));
    if (head) {
      const bytes = Number.parseInt(head[2]!, 16);
      const start = pos + head[0].length;
      let end = start;
      let used = 0;
      while (end < text.length && used < bytes) used += utf8Units(text, end++);
      texts.set(head[1]!, text.slice(start, end));
      pos = end;
      if (text[pos] === "\n") pos++;
      continue;
    }
    let nl = text.indexOf("\n", pos);
    if (nl === -1) nl = text.length;
    const line = text.slice(pos, nl);
    const colon = line.indexOf(":");
    if (colon > 0 && colon <= 16 && /^[0-9a-f]+$/.test(line.slice(0, colon))) rows.push({ id: line.slice(0, colon), payload: line.slice(colon + 1) });
    pos = nl + 1;
  }
  return { rows, texts };
}

/** Whether a prop that matters to a script (`src`, `children`, `dangerouslySetInnerHTML`) may point at a text row. */
function hasTextRef(props: Record<string, Json>): boolean {
  const inner = props.dangerouslySetInnerHTML;
  return (
    typeof props.children === "string" ||
    Array.isArray(props.children) ||
    typeof props.src === "string" ||
    (isObject(inner) && typeof inner.__html === "string")
  );
}

/** The props with a text-row reference in `src`, `children` or `__html` replaced by the text. */
function resolvedProps(props: Record<string, Json>, resolve: (v: Json) => Json): Record<string, Json> {
  const inner = props.dangerouslySetInnerHTML;
  return {
    ...props,
    ...(typeof props.src === "string" ? { src: resolve(props.src) } : {}),
    ...(typeof props.children === "string" ? { children: resolve(props.children) } : {}),
    ...(Array.isArray(props.children) ? { children: props.children.map((c) => (typeof c === "string" ? resolve(c) : c)) } : {}),
    ...(isObject(inner) && typeof inner.__html === "string" ? { dangerouslySetInnerHTML: { ...inner, __html: resolve(inner.__html) } } : {}),
  };
}

const TEXT_REF = /^\$([0-9a-f]{1,16})$/;
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
  const { rows, texts } = parseRows(parts.join(""));
  const scriptModules = new Set<string>();
  for (const row of rows) {
    if (row.payload.startsWith("I[") && SCRIPT_MODULE.test(row.payload.slice(0, 512))) scriptModules.add(row.id);
  }
  /** A string, or the text row it points at (`"$2a"`): a long inline snippet is a text row, not a string of the element. */
  const resolve = (v: Json): Json => {
    if (typeof v !== "string") return v;
    const ref = TEXT_REF.exec(v)?.[1];
    return ref !== undefined && texts.has(ref) ? texts.get(ref)! : v;
  };
  const out: string[] = [];
  let nodes = 0;
  const collect = (v: Json): void => {
    const value = resolve(v);
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const item of value) if (typeof resolve(item) === "string") out.push(resolve(item) as string);
  };
  for (const row of rows) {
    const payload = row.payload;
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
          const seen = hasTextRef(props) ? resolvedProps(props, resolve) : props;
          if (type === "script" || (ref !== undefined && isScriptComponent(ref, seen, scriptModules))) {
            const kind = seen.type;
            if (!(typeof kind === "string" && isData(kind.slice(0, 256)))) {
              if (typeof seen.src === "string") out.push(seen.src);
              const inner = seen.dangerouslySetInnerHTML;
              if (isObject(inner) && typeof inner.__html === "string") out.push(inner.__html);
              collect(seen.children);
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
