// Capture one real WAF block response and sanitise it into a fixture (#1328).
//
// Netlify and Fastly Next-Gen WAF block pages were only ever built from docs and
// reports (see tests/fixtures/waf-blocks.ts, `how`). A real one is worth far more,
// but a raw capture carries the site's host, our IP, cookies and request ids, none
// of which may land in git. This tool does the capture and the scrubbing in one
// step so the committed file is already safe, and keeps the markup and wording
// intact because that is what detection will be tested against.
//
//   bun run packages/waf-detect/scripts/capture-block-sample.ts --url <URL> --out <FILE> [--name <slug>] [--force]
//
// Read the output before committing: redaction is pattern based, not a proof.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const MAX_BODY_BYTES = 256 * 1024;
export const FETCH_TIMEOUT_MS = 15_000;
export const USER_AGENT =
  "squirrelscan-capture/1.0 (block-sample capture; sanitised before commit)";

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface Redactions {
  cookies: number;
  ips: number;
  requestIds: number;
  hosts: number;
  tokens: number;
}

export interface CapturedSample {
  name: string;
  how: "live";
  source: string;
  capturedAt: string;
  status: number;
  headers: Record<string, string>;
  html: string | null;
  truncated: boolean;
  redactions: Redactions;
}

const IP_HEADERS = new Set([
  "x-forwarded-for",
  "x-real-ip",
  "x-client-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "forwarded",
  "x-cluster-client-ip",
]);

// The NAME of these stays: its presence is the evidence. Only the value is per-request.
const REQUEST_ID_HEADERS = new Set([
  "x-nf-request-id",
  "x-request-id",
  "x-sigsci-requestid",
  "x-amzn-requestid",
  "cf-ray",
  "x-fastly-request-id",
  "x-timer",
]);

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_RUN_20 = /\b[0-9a-f]{20,}\b/gi;
const HEX_RUN_16 = /\b[0-9a-f]{16,}\b/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Needs "::" or a full eight groups, and no word or colon neighbour, so times
// (12:30:45) and CSS (a::before) are left alone.
const IPV6 =
  /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?)(?![\w:])/gi;

const TOKEN_WORDS = "(?:token|csrf|session|nonce|key)";
// query-style and attribute pairs: token=abc, nonce="abc", data-csrf='abc'
const TOKEN_PAIR = new RegExp(
  `(\\b[\\w-]*${TOKEN_WORDS}[\\w-]*\\s*=\\s*)(["']?)([^"'&\\s<>;]+)\\2`,
  "gi",
);
// <meta name="csrf-token" content="abc"> and <input name="csrf" value="abc">
const TOKEN_NAMED_FIELD = new RegExp(
  `(name=["'][^"']*${TOKEN_WORDS}[^"']*["'][^>]*?\\b(?:content|value)=["'])([^"']+)`,
  "gi",
);
// "csrfToken":"abc" in inline JSON
const TOKEN_JSON = new RegExp(`("[\\w-]*${TOKEN_WORDS}[\\w-]*"\\s*:\\s*")([^"]+)`, "gi");

const emptyRedactions = (): Redactions => ({
  cookies: 0,
  ips: 0,
  requestIds: 0,
  hosts: 0,
  tokens: 0,
});

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Reject anything that is not plain http(s) or that carries credentials. */
export function parseCaptureUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported protocol ${url.protocol}, only http and https are allowed`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("URL must not contain embedded credentials");
  }
  return url;
}

/** Same path and query shape on example.com, query values dropped. */
export function sanitiseSource(url: URL): string {
  const out = new URL(`${url.protocol}//example.com${url.pathname}`);
  for (const key of url.searchParams.keys()) out.searchParams.append(key, "REDACTED");
  return out.toString();
}

interface Ctx {
  hostRe: RegExp | null;
  counts: Redactions;
}

function sub(text: string, re: RegExp, repl: string, onHit: () => void): string {
  return text.replace(re, () => {
    onHit();
    return repl;
  });
}

/** Host, IP and id scrubbing shared by header values and the body. */
function scrubCommon(text: string, ctx: Ctx): string {
  let out = text;
  if (ctx.hostRe) out = sub(out, ctx.hostRe, "example.com", () => ctx.counts.hosts++);
  out = sub(out, UUID, "REDACTED-ID", () => ctx.counts.requestIds++);
  out = sub(out, HEX_RUN_20, "REDACTED-ID", () => ctx.counts.requestIds++);
  out = sub(out, IPV4, "REDACTED-IP", () => ctx.counts.ips++);
  out = sub(out, IPV6, "REDACTED-IP", () => ctx.counts.ips++);
  return out;
}

function scrubTokens(text: string, ctx: Ctx): string {
  const bump = () => ctx.counts.tokens++;
  const keep = (v: string) => v.startsWith("REDACTED");
  let out = text.replace(TOKEN_NAMED_FIELD, (m, head: string, v: string) => {
    if (keep(v)) return m;
    bump();
    return `${head}REDACTED-TOKEN`;
  });
  out = out.replace(TOKEN_JSON, (m, head: string, v: string) => {
    if (keep(v)) return m;
    bump();
    return `${head}REDACTED-TOKEN`;
  });
  return out.replace(TOKEN_PAIR, (m, head: string, q: string, v: string) => {
    if (keep(v)) return m;
    bump();
    return `${head}${q}REDACTED-TOKEN${q}`;
  });
}

function makeCtx(host: string): Ctx {
  const bare = host.toLowerCase().replace(/^www\./, "");
  // Already the placeholder host: nothing to hide, and counting it would be noise.
  const hostRe =
    bare === "example.com" ? null : new RegExp(`(?<![\\w-])(?:www\\.)?${escapeRegExp(bare)}`, "gi");
  return { hostRe, counts: emptyRedactions() };
}

export function sanitiseHeaders(headers: Headers, ctx: Ctx): Record<string, string> {
  const out: Record<string, string> = {};
  const setCookies = headers.getSetCookie();
  ctx.counts.cookies += setCookies.length;
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    // Cookies are counted once, above, from getSetCookie(); the value is never kept.
    if (name === "set-cookie") continue;
    if (IP_HEADERS.has(name)) {
      out[name] = "REDACTED-IP";
      ctx.counts.ips++;
      continue;
    }
    if (REQUEST_ID_HEADERS.has(name)) {
      out[name] = "REDACTED-REQUEST-ID";
      ctx.counts.requestIds++;
      continue;
    }
    let v = value;
    if (name.startsWith("x-sigsci-")) {
      // Provider evidence: keep the value, hide only the id-shaped part.
      v = sub(v, UUID, "REDACTED-ID", () => ctx.counts.requestIds++);
      v = sub(v, HEX_RUN_16, "REDACTED-ID", () => ctx.counts.requestIds++);
    }
    out[name] = scrubCommon(v, ctx);
  }
  return out;
}

export function sanitiseBody(body: string, ctx: Ctx): string {
  // Tokens first so a token value is counted as a token, not as a hex id.
  return scrubCommon(scrubTokens(body, ctx), ctx);
}

export interface SanitiseInput {
  url: URL;
  name: string;
  capturedAt: string;
  status: number;
  headers: Headers;
  body: string;
  truncated: boolean;
}

export function sanitiseSample(input: SanitiseInput): CapturedSample {
  const ctx = makeCtx(input.url.hostname);
  if (input.name.toLowerCase().includes(input.url.hostname.toLowerCase())) {
    throw new Error("name must not contain the captured host");
  }
  const headers = sanitiseHeaders(input.headers, ctx);
  const html = input.body === "" ? null : sanitiseBody(input.body, ctx);
  return {
    name: input.name,
    how: "live",
    source: sanitiseSource(input.url),
    capturedAt: input.capturedAt,
    status: input.status,
    headers,
    html,
    truncated: input.truncated,
    redactions: ctx.counts,
  };
}

/** Read at most `cap` bytes; a bigger body is cut and the rest never downloaded. */
export async function readCappedBody(
  res: Response,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > cap) {
      chunks.push(value.subarray(0, cap - total));
      total = cap;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { text: new TextDecoder().decode(buf), truncated };
}

export interface CaptureOptions {
  url: string;
  name?: string;
  fetchImpl?: FetchImpl;
  now?: () => Date;
  maxBytes?: number;
}

export async function captureBlockSample(opts: CaptureOptions): Promise<CapturedSample> {
  // Validate before any network call.
  const url = parseCaptureUrl(opts.url);
  const name = opts.name ?? "";
  if (name !== "" && !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error("name must be a lower-case slug (a-z, 0-9, hyphen)");
  }
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((i, init) => globalThis.fetch(i, init));
  const now = opts.now ?? (() => new Date());

  const res = await fetchImpl(url.toString(), {
    method: "GET",
    // Capture the block page itself, not wherever it points.
    redirect: "manual",
    credentials: "omit",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
  });
  const { text, truncated } = await readCappedBody(res, opts.maxBytes ?? MAX_BODY_BYTES);
  const capturedAt = now().toISOString().slice(0, 10);
  return sanitiseSample({
    url,
    name: name || `live-${res.status}-${capturedAt}`,
    capturedAt,
    status: res.status,
    headers: res.headers,
    body: text,
    truncated,
  });
}

/** Pretty JSON with a trailing newline. Refuses to clobber unless `force`. */
export async function writeSample(
  path: string,
  sample: CapturedSample,
  force: boolean,
): Promise<void> {
  if (!force && existsSync(path)) {
    throw new Error(`${path} already exists, pass --force to overwrite`);
  }
  await mkdir(dirname(path), { recursive: true });
  // "wx" also closes the race between the check above and the write.
  await writeFile(path, `${JSON.stringify(sample, null, 2)}\n`, { flag: force ? "w" : "wx" });
}

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

async function main(): Promise<void> {
  const url = arg("url", "");
  const out = arg("out", "");
  if (!url || !out) {
    console.error(
      "usage: capture-block-sample.ts --url <URL> --out <FILE> [--name <slug>] [--force]",
    );
    process.exit(2);
  }
  try {
    const sample = await captureBlockSample({ url, name: arg("name", "") || undefined });
    await writeSample(out, sample, process.argv.includes("--force"));
    console.log(`wrote ${out} (status ${sample.status}, truncated ${sample.truncated})`);
    console.log(`redactions: ${JSON.stringify(sample.redactions)}`);
    console.log("review the file by hand before committing it");
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

if (import.meta.main) await main();
