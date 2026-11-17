// Fail-closed check for `squirrel evidence export --shareable` (repo#2301).
//
// Every string the source model can hold is filled with distinct secret markers,
// generically: a walk over a fully populated template, not a list of fields. The
// whole shareable output (every file, every JSON key and string, and the raw
// text) must then hold no marker. A field added to the source model later must
// be added to TEMPLATE (`Full<>` makes it a type error until it is) and is then
// planted and checked with no further change here.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  type EvidenceSource,
  exportEvidenceBundle,
  verifyEvidenceBundle,
} from "@/evidence/bundle";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "evidence-fail-closed-"));
  roots.push(dir);
  return dir;
}

// ── Markers ──────────────────────────────────────────────────────────────────────

/** Any marker, planted or not: the output is searched for the shape, not a list. */
const ANY_MARKER = /MK\d{8}XQZW/g;
let markerCount = 0;
const planted: string[] = [];
function marker(): string {
  const m = `MK${String(++markerCount).padStart(8, "0")}XQZW`;
  planted.push(m);
  return m;
}

/**
 * Secret shapes the redactor recognises in free text: one per class, each with
 * its own marker. Every planted string carries ALL of them.
 */
const SHAPES: ReadonlyArray<(m: string) => string> = [
  (m) => `https://${m}:pw@user.test/p`, // URL userinfo: user
  (m) => `https://u:${m}@pass.test/p`, // URL userinfo: password
  (m) => `https://q.test/cb?token=${m}&x=1`,
  (m) => `https://q.test/?key=${m}`,
  (m) => `https://q.test/?api_key=${m}`,
  (m) => `https://q.test/s?sig=${m}`,
  (m) => `https://q.test/?X-Amz-Signature=${m}`,
  (m) => `/relative?session=${m}&next=/`,
  (m) => `https://q.test/#access_token=${m}`,
  (m) => `Bearer ${m}`,
  (m) => `sk_live_${m}AB`,
  (m) => `ghp_${m}${"a".repeat(20)}`,
  (m) => `xoxb-${m}`,
  (m) => `eyJhbGciOi${m}.eyJzdWIiOiIx${m}.sig${m}`,
  (m) => `AKIA${m}00`,
  (m) => `${m}@example.test`,
  (m) => `api_key="${m}"`,
  (m) => `{"X-API-Key": "${m}"}`,
  (m) => `-----BEGIN RSA PRIVATE KEY-----\n${m}\n-----END RSA PRIVATE KEY-----`,
  (m) => `<meta name="csrf-token" content="${m}">`,
  (m) => `<input type="hidden" name="authenticity_token" value="${m}">`,
  // Header lines quoted as plain text (dumps, logs, error messages).
  (m) => `Authorization: Basic ${m}`,
  (m) => `{"Authorization": "Token ${m}"}`,
  (m) => `Cookie: sid=${m}`,
  (m) => `Set-Cookie: session=${m}; Path=/`,
  (m) => `X-API-Key: ${m}`,
  (m) => `Proxy-Authorization: Basic ${m}`,
  (m) => `x_api_key=${m}`,
  (m) => `authorization: token ${m}`,
  // 1. Escaped quotes inside a quoted value.
  (m) => String.raw`{"cookie": "a=\"b\"; session=${m}"}`,
  (m) => String.raw`'authorization': 'Token it\'s-${m}'`,
  // 2. Unquoted name, value starting with a quote: the value is the line.
  (m) => `Cookie: "a"; session=${m}`,
  (m) => `Authorization: 'Basic' ${m}`,
  (m) => `X-API-Key: "k" ${m}`,
  // 3. Folded values and values on the next line.
  (m) => `Cookie: a=b\r\n\tsid=${m}`,
  (m) => `Cookie:\n  sid=${m}`,
  (m) => `Authorization:\n\tBasic ${m}`,
  (m) => `Set-Cookie: a=1\n sid=${m}; Path=/`,
  (m) => `"cookie":\n  "sid=${m}"`,
  // 4. CGI environment names and print_r / error-page dumps.
  (m) => `HTTP_COOKIE=sid=${m}`,
  (m) => `HTTP_AUTHORIZATION: Basic ${m}`,
  (m) => `[HTTP_COOKIE] => sid=${m}`,
  (m) => `[Cookie] => sid=${m}`,
  (m) => `HTTP_X_API_KEY=${m}`,
  (m) => `Cookie -> sid=${m}`,
  (m) => "`x-api-key`: `" + m + "`",
  // 5. Escaped and entity-encoded quotes around the name and the value.
  (m) => String.raw`"{\"Authorization\": \"Basic ${m}\"}"`,
  (m) => String.raw`\"cookie\": \"sid=${m}\"`,
  (m) => `{&quot;Authorization&quot;: &quot;Basic ${m}&quot;}`,
  (m) => `{&#34;Cookie&#34;: &#34;sid=${m}&#34;}`,
  (m) => `{&#39;Cookie&#39;: &#39;sid=${m}&#39;}`,
  // 6. Credential header names outside the exact list, as lines.
  (m) => `X-Goog-Api-Key: ${m}`,
  (m) => `Private-Token: ${m}`,
  (m) => `X-Access-Token: ${m}`,
  (m) => `X-Shopify-Access-Token: ${m}`,
  (m) => `CF-Access-Client-Secret: ${m}`,
  (m) => `X-Session-Id: ${m}`,
  (m) => `X-JWT: ${m}`,
  // 7. A value on the next line that is not indented.
  (m) => `Cookie:\nsid=${m}`,
  (m) => `Authorization:\r\nBasic ${m}`,
  (m) => `Set-Cookie:  \nsession=${m}; Path=/`,
  // 8. A quoted value closed by `)` and followed by more of the line.
  (m) => `cookie: "a") + "${m}"`,
  // 9. Well-known credential headers without an x-, cf- or private- prefix.
  (m) => `api-key: ${m}`,
  (m) => `apikey: ${m}`,
  (m) => `Ocp-Apim-Subscription-Key: ${m}`,
  (m) => `Auth-Token: ${m}`,
  (m) => `access-token: ${m}`,
  (m) => `ID-Token: ${m}`,
  (m) => `refresh_token: ${m}`,
  (m) => `session-id: ${m}`,
  (m) => `Session-Token: ${m}`,
  (m) => `secret-key: ${m}`,
  (m) => `Client-Secret: ${m}`,
  (m) => `Authentication: ${m}`,
  // 10. A quoted first value followed by a folded continuation line.
  (m) => `Cookie: "a"\n sid=${m}`,
  (m) => `Cookie: "a"\r\n\tsid=${m}`,
];

/**
 * One shape per line: a header-line value runs to the end of its line, so a
 * shape sharing a line with the next would hide whether the next is caught.
 */

function blob(): string {
  return SHAPES.map((shape) => shape(marker())).join("\n");
}

// ── Template: every field of the source model, filled ────────────────────────────

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
/** Every optional field required, every nullable non-null, iterables as arrays. */
type Full<T> = unknown extends T
  ? T
  : T extends Primitive
    ? T
    : T extends Iterable<infer U>
      ? Full<U>[]
      : { [K in keyof T]-?: Full<Exclude<T[K], null | undefined>> };

/** `S`: a string field, planted with `blob()`. */
const S = "__S__";
/** `PLAIN`: a bare marker with no secret shape; only a credential key can catch it. */
const PLAIN = "__PLAIN__";
/** A key starting with `KEY` is replaced by a secret-shaped key (free-form maps). */
const KEY = "__KEY__";

/** Free-form JSON: keys, nested objects, arrays and credential-named keys. */
const freeForm = (): Record<string, unknown> => ({
  [`${KEY}1`]: S,
  plain: S,
  list: [S, { [`${KEY}2`]: S, inner: S }],
  token: PLAIN,
  apiKey: PLAIN,
  password: { nested: PLAIN, list: [PLAIN] },
  count: 3,
});

const headers = (): Record<string, unknown> => ({
  Authorization: PLAIN,
  Cookie: PLAIN,
  "Set-Cookie": [PLAIN, PLAIN],
  "X-API-Key": PLAIN,
  // Credential headers outside the exact list: caught by the name rule.
  "x-access-token": PLAIN,
  "x-session-token": PLAIN,
  "x-refresh-token": PLAIN,
  "x-session-id": PLAIN,
  "x-shopify-access-token": PLAIN,
  "cf-access-client-secret": PLAIN,
  "private-token": PLAIN,
  "x-goog-api-key": PLAIN,
  "x-jwt": PLAIN,
  "Cookie ": PLAIN,
  X_Signature: PLAIN,
  location: S,
  link: S,
  server: S,
  [`${KEY}3`]: S,
});

const page = (): Full<
  EvidenceSource["pages"] extends Iterable<infer P> ? P : never
> => ({
  url: S,
  normalizedUrl: S,
  finalUrl: S,
  depth: 0,
  parentUrl: S,
  status: 200,
  contentType: S,
  sizeBytes: 1,
  loadTimeMs: 1,
  fetchedAt: Date.UTC(2026, 0, 1),
  headers: headers(),
  requestHeaders: headers() as Record<string, string>,
  fetcherId: S,
  fallbackReason: S,
  redirectChain: {
    sourceUrl: S,
    finalUrl: S,
    hops: [{ url: S, statusCode: 301, type: S }],
    chainLength: 1,
    isLoop: false,
    endsInError: false,
  },
  html: S,
});

type Item = NonNullable<
  (EvidenceSource["findings"] extends Iterable<infer F> ? F : never)["items"]
>[number];

const TEMPLATE = (): Full<EvidenceSource> => ({
  crawl: {
    id: S,
    baseUrl: S,
    seedUrl: S,
    originalUrl: S,
    startedAt: Date.UTC(2026, 0, 1),
    completedAt: Date.UTC(2026, 0, 1, 0, 5),
    status: S,
    reportStatus: S,
    retiredAt: Date.UTC(2026, 0, 2),
    config: { ...freeForm(), maxPages: 5, headers: headers() },
    stats: freeForm(),
    scanScope: freeForm(),
  },
  scanner: { name: S, version: S, rulesRevision: S },
  pages: [page(), page()],
  scripts: [0, 1].map(() => ({
    url: S,
    finalUrl: S,
    sizeBytes: 1,
    status: "stored" as const,
    skipReason: S,
    sourcePages: [S],
    evicted: false,
    body: S,
  })),
  scriptsSummary: { fetchLimit: 10, droppedByLimit: 0 },
  failures: [
    {
      url: S,
      status: S,
      reason: S,
      depth: 1,
      parentUrl: S,
      source: S,
      retryCount: 0,
    },
  ],
  findings: [0, 1, 2].map(() => ({
    ruleId: S,
    name: S,
    status: S,
    message: S,
    pageUrl: S,
    value: S,
    expected: S,
    skipReason: S,
    observation: freeForm(),
    items: [
      {
        id: S,
        label: S,
        snippet: S,
        selector: S,
        sourcePages: [S],
      } satisfies Full<Item>,
    ],
  })),
});

/** Generic: every string and every `KEY` key in the value gets fresh markers. */
function plant<T>(value: T): T {
  if (value === S) return blob() as T;
  if (value === PLAIN) return marker() as T;
  if (typeof value === "string") return blob() as T;
  if (Array.isArray(value)) return value.map(plant) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
      out[k.startsWith(KEY) ? blob() : k] = plant(v);
    return out as T;
  }
  return value;
}

/**
 * The planted source, with only the links the builder needs to reach every
 * branch (stored and unavailable artifacts, located evidence, site-level
 * findings, fetched and skipped scripts) pointed at other planted values.
 */
function leakySource(): EvidenceSource {
  planted.length = 0;
  const t = plant(TEMPLATE());
  const [stored, missing] = t.pages;
  const snippet = t.findings[0]!.items[0]!.snippet;
  stored!.html = `<html><body>${stored!.html}<p>${snippet}</p></body></html>`;
  const evicted = { ...missing!, html: null };
  const [onPage, onMissing, siteLevel] = t.findings;
  onPage!.pageUrl = stored!.url;
  onPage!.items[0]!.sourcePages = [stored!.url];
  onMissing!.pageUrl = evicted.url;
  const site = { ...siteLevel!, pageUrl: undefined };
  site.items[0]!.sourcePages = [stored!.url, evicted.url];
  const [fetched, skipped] = t.scripts;
  fetched!.sourcePages = [stored!.url];
  const notFetched = { ...skipped!, body: null };
  return {
    ...t,
    pages: [stored!, evicted],
    findings: [onPage!, onMissing!, site],
    scripts: [fetched!, notFetched],
  };
}

// ── Walk the whole output ────────────────────────────────────────────────────────

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

/** Every marker found anywhere in a bundle directory, with where it was found. */
function findMarkers(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const scan = (text: string, where: string): void => {
    for (const m of text.matchAll(ANY_MARKER)) found.set(m[0], where);
  };
  const walk = (value: unknown, where: string): void => {
    if (typeof value === "string") scan(value, where);
    else if (Array.isArray(value))
      for (const [i, v] of value.entries()) walk(v, `${where}[${i}]`);
    else if (value !== null && typeof value === "object")
      for (const [k, v] of Object.entries(value)) {
        scan(k, `${where} (key)`);
        walk(v, `${where}.${k}`);
      }
  };
  const list = files(dir);
  expect(list.length).toBeGreaterThan(5);
  for (const file of list) {
    const name = relative(dir, file);
    const text = readFileSync(file, "utf-8");
    scan(text, `${name} (raw text)`);
    if (name.endsWith(".json")) walk(JSON.parse(text), name);
  }
  return found;
}

describe("shareable export fails closed", () => {
  test("no planted marker survives anywhere in a --shareable bundle", () => {
    const source = leakySource();
    expect(planted.length).toBeGreaterThan(500);
    const dir = join(tmp(), "shareable");
    exportEvidenceBundle(source, dir, { kind: "shareable" });

    const leaks = findMarkers(dir);
    expect([...leaks.entries()]).toEqual([]);

    // Still a valid bundle, and the builder reached the branches we planted for.
    expect(verifyEvidenceBundle(dir).ok).toBe(true);
    const findings = JSON.parse(
      readFileSync(join(dir, "findings.json"), "utf-8")
    );
    const states = findings.flatMap((f: { evidence: { state: string }[] }) =>
      f.evidence.map((e) => e.state)
    );
    expect(states).toContain("unavailable");
    expect(states.some((s: string) => s !== "unavailable")).toBe(true);
    expect(
      findings.some((f: { evidence: { locator: { selector?: string } }[] }) =>
        f.evidence.some((e) => e.locator.selector !== undefined)
      )
    ).toBe(true);
  });

  test("the raw bundle is unchanged: it carries the planted values", () => {
    const source = leakySource();
    const first = [...source.pages][0]!;
    const finding = [...source.findings][0]!;
    const dir = join(tmp(), "raw");
    exportEvidenceBundle(source, dir, { kind: "raw" });

    const found = findMarkers(dir);
    const raw = (file: string): string =>
      readFileSync(join(dir, file), "utf-8");
    // Header values only a credential key can catch, verbatim.
    expect(JSON.parse(raw("pages.json"))[0].responseHeaders.Authorization).toBe(
      first.headers.Authorization
    );
    // The observation, selector, URLs (userinfo and query) and the body as sent.
    const findings = JSON.parse(raw("findings.json"));
    expect(findings[0].observation).toEqual(finding.observation);
    expect(findings[0].evidence[0].locator.selector).toBe(
      finding.items![0]!.selector
    );
    const pages = JSON.parse(raw("pages.json"));
    expect(pages[0].url).toBe(first.url);
    expect(raw(pages[0].artifacts[0].path)).toBe(first.html!);
    // Most of what was planted is in the raw bundle (snippets and item ids are
    // never serialized, so not all of it).
    expect(found.size).toBeGreaterThan(planted.length / 2);
  });
});
