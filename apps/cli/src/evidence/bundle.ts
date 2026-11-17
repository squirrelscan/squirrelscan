// Versioned, replayable audit evidence bundle (repo#2301).
//
// An audit keeps JSON findings, but the crawl store behind them is pruned (see
// `retention.ts`), and a later re-fetch is a different observation. This module
// turns one stored crawl into a directory that stands on its own:
//
//   manifest.json          index of every file with sha256 + size, and the bundle hash. Written LAST,
//                          so a directory without one is an interrupted export, never a bundle.
//   audit.json             configuration, scanner and rules revision, stats, completion and limits.
//   pages.json             per page: URLs, status, headers, fetch mode, redirect provenance, artifacts.
//   findings.json          per finding: evidence refs (content hash + selector / byte range).
//   failures.json          URLs that were never stored (failed, skipped), with the reason.
//   scripts.json           external scripts, with the pages that referenced them.
//   artifacts/<type>/<sha> the bytes: response-body, rendered-dom and script are separate types.
//
// `kind: "raw"` is what the site sent and is RESTRICTED (0700/0600, README warns).
// `kind: "shareable"` sends every byte through `BundleWriter.serialize`, the one exit, which runs
// every JSON string and key and every artifact body through `ShareableRedactor` (`redact.ts`).
// Deny by default: only the named `SHAREABLE_ALLOWLIST` paths are exempt.
// Verification and replay need nothing but the directory: no network, no store.

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import {
  type RedactionCounts,
  REDACTION_PATTERN_NAMES,
  ShareableRedactor,
} from "./redact";

export const EVIDENCE_FORMAT = "squirrelscan-evidence";
export const EVIDENCE_FORMAT_VERSION = 1;

/** How many pages one site-level finding item names evidence for, before it says it stopped. */
const MAX_EVIDENCE_PAGES_PER_ITEM = 20;

export type ArtifactType = "response-body" | "rendered-dom" | "script";
export type BundleKind = "raw" | "shareable";

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ── Source model: plain data, so the builder is testable without a store ─────────────

export interface SourcePage {
  url: string;
  normalizedUrl: string;
  finalUrl: string;
  depth: number;
  parentUrl?: string;
  status: number;
  contentType: string | null;
  sizeBytes: number;
  loadTimeMs: number;
  fetchedAt: number;
  headers: Record<string, unknown>;
  requestHeaders?: Record<string, string> | null;
  fetcherId?: string;
  fallbackReason?: string;
  redirectChain?: {
    sourceUrl: string;
    finalUrl: string;
    hops: Array<{ url: string; statusCode: number; type: string }>;
    chainLength: number;
    isLoop: boolean;
    endsInError: boolean;
  };
  /** The stored body, or null when it was never stored or has been evicted. */
  html: string | null;
}

export interface SourceScript {
  url: string;
  finalUrl: string | null;
  sizeBytes: number | null;
  status: "stored" | "skipped";
  skipReason: string | null;
  sourcePages: string[];
  evicted: boolean;
  body: string | null;
}

export interface SourceFailure {
  url: string;
  status: string;
  reason?: string;
  depth: number;
  parentUrl?: string;
  source: string;
  retryCount: number;
}

export interface SourceFinding {
  ruleId: string;
  name: string;
  status: string;
  message: string;
  pageUrl?: string;
  value?: string | number | null;
  expected?: string | number | null;
  skipReason?: string;
  observation?: unknown;
  items?: Array<{
    id: string;
    label?: string;
    snippet?: string;
    selector?: string;
    sourcePages?: string[];
  }>;
}

export interface EvidenceSource {
  crawl: {
    id: string;
    baseUrl: string;
    seedUrl?: string;
    originalUrl?: string;
    startedAt: number;
    completedAt?: number;
    status: string;
    reportStatus?: string | null;
    retiredAt?: number;
    config: Record<string, unknown>;
    stats: Record<string, unknown>;
    scanScope?: unknown;
  };
  scanner: { name: string; version: string; rulesRevision: string };
  pages: Iterable<SourcePage>;
  scripts: Iterable<SourceScript>;
  scriptsSummary?: { fetchLimit: number | null; droppedByLimit: number } | null;
  failures: Iterable<SourceFailure>;
  findings: Iterable<SourceFinding>;
}

// ── Bundle shapes ────────────────────────────────────────────────────────────────

export interface ArtifactRef {
  type: ArtifactType;
  state: "stored" | "unavailable";
  /** Why it is unavailable. Always set when `state` is `unavailable`. */
  reason?: string;
  sha256?: string;
  bytes?: number;
  path?: string;
  /** The stored text is the decoded body, re-encoded as UTF-8: these are not wire bytes. */
  encoding?: "utf-8";
}

export interface InlineScriptRef {
  kind: "inline-script" | "inline-data";
  scriptType: string | null;
  byteStart: number;
  byteEnd: number;
  sha256: string;
  /** The artifact the byte range is relative to. */
  parentSha256: string;
}

export interface EvidenceRef {
  pageUrl: string;
  artifactType: ArtifactType | null;
  contentSha256: string | null;
  locator: {
    selector?: string;
    byteRange?: { start: number; end: number; snippetSha256: string };
  };
  /**
   * located: a selector and/or byte range is recorded. page-only: the page is
   * archived but the rule gave no location. truncated: the rule's snippet was
   * clipped, so the range is only a prefix. unavailable: no artifact to point at.
   */
  state: "located" | "page-only" | "truncated" | "unavailable";
  reason?: string;
}

export interface BundleFinding {
  ruleId: string;
  check: string;
  status: string;
  message: string;
  pageUrl: string | null;
  value?: string | number | null;
  expected?: string | number | null;
  skipReason?: string;
  observation?: unknown;
  evidence: EvidenceRef[];
}

export interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface Manifest {
  format: typeof EVIDENCE_FORMAT;
  formatVersion: number;
  kind: BundleKind;
  sensitivity: "restricted" | "shareable";
  createdAt: string;
  scanner: { name: string; version: string; rulesRevision: string };
  crawlId: string;
  site: string;
  counts: {
    pages: number;
    artifacts: number;
    findings: number;
    failures: number;
    scripts: number;
    pagesWithoutArtifact: number;
    evidenceUnavailable: number;
  };
  redaction?: { patterns: readonly string[]; counts: RedactionCounts };
  files: ManifestFile[];
  /** sha256 of the sorted "<sha256>  <path>" lines of `files`. */
  bundleSha256: string;
}

export function bundleHash(files: readonly ManifestFile[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.sha256}  ${f.path}\n`)
    .join("");
  return sha256(lines);
}

// ── Writer ───────────────────────────────────────────────────────────────────────

class BundleWriter {
  readonly files: ManifestFile[] = [];
  private readonly seen = new Set<string>();

  /** `redactor` is set for a shareable bundle and null for a raw one. */
  constructor(
    readonly dir: string,
    private readonly redactor: ShareableRedactor | null
  ) {}

  /**
   * THE exit: every file of the bundle, manifest included, is turned into bytes
   * here, and nowhere else. For a shareable bundle that is where redaction
   * happens: JSON is walked (every string value and key), text is redacted whole.
   */
  private serialize(
    path: string,
    payload: { json: unknown } | { text: string }
  ): string {
    if ("text" in payload)
      return this.redactor ? this.redactor.text(payload.text) : payload.text;
    const value = this.redactor
      ? this.redactor.json(path, payload.json)
      : payload.json;
    return JSON.stringify(value, null, 2) + "\n";
  }

  /**
   * The form a fragment of an artifact body takes once written, so a rule's
   * snippet can be located in the written bytes. The result is only hashed and
   * searched for; it is never written itself.
   */
  asWritten(fragment: string): string {
    return this.serialize("", { text: fragment });
  }

  private write(path: string, data: string): ManifestFile {
    const bytes = Buffer.from(data, "utf-8");
    const entry: ManifestFile = {
      path,
      sha256: sha256(bytes),
      bytes: bytes.length,
    };
    if (this.seen.has(path)) return entry; // content addressed: same path, same bytes
    this.seen.add(path);
    const full = join(this.dir, ...path.split("/"));
    mkdirSync(dirname(full), {
      recursive: true,
      mode: this.redactor ? 0o755 : 0o700,
    });
    writeFileSync(full, bytes, { mode: this.redactor ? 0o644 : 0o600 });
    this.files.push(entry);
    return entry;
  }

  /** A content-addressed artifact. Returns the entry and the text as written. */
  addArtifact(
    type: ArtifactType,
    body: string
  ): { entry: ManifestFile; written: string } {
    const written = this.serialize("artifact", { text: body });
    return {
      entry: this.write(artifactPath(type, sha256(written)), written),
      written,
    };
  }

  addText(path: string, text: string): ManifestFile {
    return this.write(path, this.serialize(path, { text }));
  }

  addJson(path: string, value: unknown): ManifestFile {
    return this.write(path, this.serialize(path, { json: value }));
  }

  /** Written last and not listed in itself. Returns the manifest as written. */
  writeManifest(manifest: Manifest): Manifest {
    const data = this.serialize("manifest.json", { json: manifest });
    writeFileSync(join(this.dir, "manifest.json"), data, {
      mode: this.redactor ? 0o644 : 0o600,
    });
    return JSON.parse(data) as Manifest;
  }
}

function artifactPath(type: ArtifactType, hash: string): string {
  return `artifacts/${type}/${hash}`;
}

/** The stored page text is a rendered DOM when a browser or render service produced it. */
export function pageArtifactType(fetcherId: string | undefined): ArtifactType {
  if (!fetcherId || fetcherId === "fetch" || fetcherId === "http")
    return "response-body";
  return "rendered-dom";
}

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi;

/** Inline scripts and inline data blocks, with byte ranges into the page artifact. */
export function findInlineScripts(
  html: string,
  parentSha256: string
): InlineScriptRef[] {
  const out: InlineScriptRef[] = [];
  SCRIPT_TAG.lastIndex = 0;
  for (const match of html.matchAll(SCRIPT_TAG)) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    if (/\bsrc\s*=/i.test(attrs) || body.length === 0) continue;
    const typeMatch = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    const scriptType = typeMatch ? typeMatch[1]!.toLowerCase() : null;
    const isData =
      scriptType !== null &&
      !/^(module|text\/javascript|application\/javascript|text\/babel)$/.test(
        scriptType
      );
    const charStart = (match.index ?? 0) + match[0].indexOf(">") + 1;
    const byteStart = Buffer.byteLength(html.slice(0, charStart), "utf-8");
    const byteEnd = byteStart + Buffer.byteLength(body, "utf-8");
    out.push({
      kind: isData ? "inline-data" : "inline-script",
      scriptType,
      byteStart,
      byteEnd,
      sha256: sha256(body),
      parentSha256,
    });
  }
  return out;
}

function looksTruncated(snippet: string): boolean {
  return /(…|\.\.\.)$/.test(snippet.trimEnd());
}

function locate(
  artifact: Buffer,
  snippet: string
): { start: number; end: number; snippetSha256: string } | null {
  const needle = Buffer.from(snippet, "utf-8");
  if (needle.length === 0) return null;
  const start = artifact.indexOf(needle);
  if (start < 0) return null;
  return { start, end: start + needle.length, snippetSha256: sha256(needle) };
}

// ── Build ────────────────────────────────────────────────────────────────────────

export interface ExportOptions {
  kind: BundleKind;
  /** Injected for tests; defaults to now. */
  now?: () => Date;
}

export interface ExportResult {
  manifest: Manifest;
  dir: string;
}

/** Thrown when the target exists and is not empty: an export never overwrites. */
export class ExportTargetError extends Error {}

export function exportEvidenceBundle(
  source: EvidenceSource,
  dir: string,
  options: ExportOptions
): ExportResult {
  const shareable = options.kind === "shareable";
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new ExportTargetError(`${dir} already exists and is not empty`);
  }
  mkdirSync(dir, { recursive: true, mode: shareable ? 0o755 : 0o700 });
  if (!shareable) chmodSync(dir, 0o700);

  // Everything below builds the bundle from the raw values. Redaction is not
  // done here: the writer applies it to every file on the way out.
  const redactor = shareable ? new ShareableRedactor() : null;
  const writer = new BundleWriter(dir, redactor);

  // Pages: write artifacts, keep a per-page buffer for locating findings.
  const pageEntries: unknown[] = [];
  const pageArtifacts = new Map<string, ArtifactRef>(); // keyed by ORIGINAL page url
  const pageBuffers = new Map<string, Buffer>();
  const inlineByPage: Record<string, InlineScriptRef[]> = {};
  let pagesWithoutArtifact = 0;
  const findingsByPage = new Map<string, SourceFinding[]>();
  const siteFindings: SourceFinding[] = [];
  for (const finding of source.findings) {
    if (finding.pageUrl) {
      const list = findingsByPage.get(finding.pageUrl) ?? [];
      list.push(finding);
      findingsByPage.set(finding.pageUrl, list);
    } else siteFindings.push(finding);
  }

  const bundleFindings: BundleFinding[] = [];
  let evidenceUnavailable = 0;
  const finish = (finding: SourceFinding, evidence: EvidenceRef[]): void => {
    for (const ref of evidence)
      if (ref.state === "unavailable") evidenceUnavailable++;
    bundleFindings.push({
      ruleId: finding.ruleId,
      check: finding.name,
      status: finding.status,
      message: finding.message,
      pageUrl: finding.pageUrl ?? null,
      ...(finding.value !== undefined ? { value: finding.value } : {}),
      ...(finding.expected !== undefined ? { expected: finding.expected } : {}),
      ...(finding.skipReason ? { skipReason: finding.skipReason } : {}),
      ...(finding.observation !== undefined
        ? { observation: finding.observation }
        : {}),
      evidence,
    });
  };

  const refFor = (
    pageUrl: string,
    item?: NonNullable<SourceFinding["items"]>[number]
  ): EvidenceRef => {
    const artifact = pageArtifacts.get(pageUrl);
    if (!artifact || artifact.state !== "stored") {
      return {
        pageUrl,
        artifactType: artifact?.type ?? null,
        contentSha256: null,
        locator: {},
        state: "unavailable",
        reason: artifact?.reason ?? "page was not stored in this crawl",
      };
    }
    const locator: EvidenceRef["locator"] = {};
    let state: EvidenceRef["state"] = "page-only";
    let reason: string | undefined;
    if (item?.selector) {
      locator.selector = item.selector;
      state = "located";
    }
    if (item?.snippet) {
      const buffer = pageBuffers.get(pageUrl);
      // Located in the bytes as written, so the snippet takes the same form.
      const snippet = writer.asWritten(item.snippet);
      const range = buffer ? locate(buffer, snippet) : null;
      if (range) {
        locator.byteRange = range;
        state = "located";
      } else if (looksTruncated(snippet)) {
        const trimmed = snippet.trimEnd().replace(/(…|\.\.\.)$/, "");
        const prefix = buffer ? locate(buffer, trimmed) : null;
        if (prefix) locator.byteRange = prefix;
        state = "truncated";
        reason = "rule snippet was clipped; byte range covers the prefix only";
      } else if (state === "page-only") {
        reason = "snippet not found in the archived artifact";
      }
    }
    if (state === "page-only" && !reason) reason = "rule gave no location";
    return {
      pageUrl,
      artifactType: artifact.type,
      contentSha256: artifact.sha256 ?? null,
      locator,
      state,
      ...(reason ? { reason } : {}),
    };
  };

  const evidenceForFinding = (finding: SourceFinding): EvidenceRef[] => {
    const refs: EvidenceRef[] = [];
    const items = finding.items ?? [];
    if (finding.pageUrl && items.length === 0) return [refFor(finding.pageUrl)];
    for (const item of items) {
      const pages = item.sourcePages?.length
        ? item.sourcePages
        : finding.pageUrl
          ? [finding.pageUrl]
          : [];
      for (const page of pages.slice(0, MAX_EVIDENCE_PAGES_PER_ITEM))
        refs.push(refFor(page, item));
      if (pages.length > MAX_EVIDENCE_PAGES_PER_ITEM) {
        refs.push({
          pageUrl: "",
          artifactType: null,
          contentSha256: null,
          locator: {},
          state: "truncated",
          reason: `evidence lists the first ${MAX_EVIDENCE_PAGES_PER_ITEM} of ${pages.length} pages`,
        });
      }
    }
    return refs;
  };

  let pageCount = 0;
  for (const page of source.pages) {
    pageCount++;
    const type = pageArtifactType(page.fetcherId);
    const otherType: ArtifactType =
      type === "response-body" ? "rendered-dom" : "response-body";
    let artifact: ArtifactRef;
    if (page.html === null) {
      pagesWithoutArtifact++;
      artifact = {
        type,
        state: "unavailable",
        reason:
          "body was not stored or has been evicted from the content store",
      };
    } else {
      const { entry, written: body } = writer.addArtifact(type, page.html);
      artifact = {
        type,
        state: "stored",
        sha256: entry.sha256,
        bytes: entry.bytes,
        path: entry.path,
        encoding: "utf-8",
      };
      const buffer = Buffer.from(body, "utf-8");
      pageBuffers.set(page.url, buffer);
      pageBuffers.set(page.normalizedUrl, buffer);
      const inline = findInlineScripts(body, entry.sha256);
      if (inline.length > 0) inlineByPage[page.url] = inline;
    }
    pageArtifacts.set(page.url, artifact);
    pageArtifacts.set(page.normalizedUrl, artifact);
    const other: ArtifactRef = {
      type: otherType,
      state: "unavailable",
      reason:
        type === "response-body"
          ? "fetched without rendering: no rendered DOM exists"
          : "fetched through a renderer: the original response bytes were not retained",
    };
    pageEntries.push({
      url: page.url,
      normalizedUrl: page.normalizedUrl,
      finalUrl: page.finalUrl,
      depth: page.depth,
      ...(page.parentUrl ? { parentUrl: page.parentUrl } : {}),
      status: page.status,
      contentType: page.contentType,
      sizeBytes: page.sizeBytes,
      loadTimeMs: page.loadTimeMs,
      capturedAt: new Date(page.fetchedAt).toISOString(),
      fetch: {
        mode: type === "response-body" ? "http" : "render",
        fetcher: page.fetcherId ?? null,
        fallbackReason: page.fallbackReason ?? null,
      },
      requestHeaders: page.requestHeaders ?? null,
      responseHeaders: page.headers,
      redirect: page.redirectChain
        ? {
            sourceUrl: page.redirectChain.sourceUrl,
            finalUrl: page.redirectChain.finalUrl,
            hops: page.redirectChain.hops.map((h) => ({ ...h })),
            chainLength: page.redirectChain.chainLength,
            isLoop: page.redirectChain.isLoop,
            endsInError: page.redirectChain.endsInError,
          }
        : null,
      artifacts: [artifact, other],
    });
    // Page-scoped findings are located while this page's buffer is live.
    for (const key of new Set([page.url, page.normalizedUrl])) {
      for (const finding of findingsByPage.get(key) ?? []) {
        finish(finding, evidenceForFinding(finding));
      }
      findingsByPage.delete(key);
    }
    pageBuffers.delete(page.url);
    pageBuffers.delete(page.normalizedUrl);
  }
  // Findings on pages not in the store, then site-level findings (whose items name pages).
  for (const list of findingsByPage.values()) {
    for (const finding of list) finish(finding, evidenceForFinding(finding));
  }
  // Site-level evidence is page-only: no buffers are kept, by design (memory).
  for (const finding of siteFindings)
    finish(finding, evidenceForFinding(finding));

  // Scripts: external bodies keep their lineage (url, final url, referencing pages).
  const scriptEntries: unknown[] = [];
  for (const script of source.scripts) {
    let artifact: ArtifactRef;
    if (script.body !== null) {
      const { entry } = writer.addArtifact("script", script.body);
      artifact = {
        type: "script",
        state: "stored",
        sha256: entry.sha256,
        bytes: entry.bytes,
        path: entry.path,
        encoding: "utf-8",
      };
    } else {
      artifact = {
        type: "script",
        state: "unavailable",
        reason: script.evicted
          ? "body evicted from the content store"
          : script.skipReason
            ? `not fetched: ${script.skipReason}`
            : "body not stored",
      };
    }
    scriptEntries.push({
      url: script.url,
      finalUrl: script.finalUrl ?? null,
      referencedFrom: script.sourcePages.map((p) => {
        const parent = pageArtifacts.get(p);
        return { page: p, pageArtifactSha256: parent?.sha256 ?? null };
      }),
      artifact,
    });
  }

  const failures = [...source.failures].map((f) => ({
    url: f.url,
    status: f.status,
    reason: f.reason ?? null,
    depth: f.depth,
    ...(f.parentUrl ? { parentUrl: f.parentUrl } : {}),
    source: f.source,
    retryCount: f.retryCount,
  }));

  const config = source.crawl.config;
  const stats = source.crawl.stats;
  const pagesCap = typeof config.maxPages === "number" ? config.maxPages : null;
  writer.addJson("audit.json", {
    crawl: {
      id: source.crawl.id,
      site: source.crawl.baseUrl,
      seedUrl: source.crawl.seedUrl ?? null,
      originalUrl: source.crawl.originalUrl ?? null,
      startedAt: new Date(source.crawl.startedAt).toISOString(),
      completedAt: source.crawl.completedAt
        ? new Date(source.crawl.completedAt).toISOString()
        : null,
    },
    scanner: source.scanner,
    configuration: config,
    // Completion: why the crawl stopped, and every cap that could have cut it short.
    completion: {
      crawlStatus: source.crawl.status,
      reportStatus: source.crawl.reportStatus ?? null,
      retiredAt: source.crawl.retiredAt
        ? new Date(source.crawl.retiredAt).toISOString()
        : null,
      hitPageLimit: pagesCap !== null && pageCount >= pagesCap,
      stats,
      scanScope: source.crawl.scanScope ?? null,
    },
    limits: {
      maxPages: pagesCap,
      maxDepth: config.maxDepth ?? null,
      timeoutMs: config.timeoutMs ?? null,
      scripts: source.scriptsSummary ?? null,
      bodyEncoding:
        "stored text re-encoded as UTF-8; byte ranges are relative to those bytes",
    },
  });
  writer.addJson("pages.json", pageEntries);
  writer.addJson("inline-scripts.json", inlineByPage);
  writer.addJson("scripts.json", scriptEntries);
  writer.addJson("failures.json", failures);
  writer.addJson("findings.json", bundleFindings);
  if (!shareable) {
    writer.addText(
      "README.txt",
      "RESTRICTED: this is a raw squirrelscan evidence bundle.\n" +
        "It holds the response bodies and headers the site sent, which can include cookies,\n" +
        "tokens and account data. Do not share it. Run the export with --shareable for a\n" +
        "redacted copy. Check integrity with: squirrel evidence verify <dir>\n"
    );
  }

  const artifactFiles = writer.files.filter((f) =>
    f.path.startsWith("artifacts/")
  ).length;
  const files = [...writer.files].sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest: Manifest = {
    format: EVIDENCE_FORMAT,
    formatVersion: EVIDENCE_FORMAT_VERSION,
    kind: options.kind,
    sensitivity: shareable ? "shareable" : "restricted",
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    scanner: source.scanner,
    crawlId: source.crawl.id,
    site: source.crawl.baseUrl,
    counts: {
      pages: pageCount,
      artifacts: artifactFiles,
      findings: bundleFindings.length,
      failures: failures.length,
      scripts: scriptEntries.length,
      pagesWithoutArtifact,
      evidenceUnavailable,
    },
    ...(redactor
      ? {
          // A snapshot: the manifest's own pass must not change what it reports.
          redaction: {
            patterns: REDACTION_PATTERN_NAMES,
            counts: structuredClone(redactor.counts),
          },
        }
      : {}),
    files,
    bundleSha256: bundleHash(files),
  };
  // Last: its presence is what says the export finished.
  return { manifest: writer.writeManifest(manifest), dir };
}

// ── Verify ───────────────────────────────────────────────────────────────────────

export interface VerifyResult {
  ok: boolean;
  issues: string[];
  manifest: Manifest | null;
}

function walk(root: string, dir: string = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(root, full));
    else out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

/** Check a bundle directory against its manifest. Offline, read-only. */
export function verifyEvidenceBundle(dir: string): VerifyResult {
  const issues: string[] = [];
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: false, issues: [`${dir} is not a directory`], manifest: null };
  }
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      issues: [
        "manifest.json is missing: the export was interrupted or this is not a bundle",
      ],
      manifest: null,
    };
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
  } catch (error) {
    return {
      ok: false,
      issues: [`manifest.json is not valid JSON: ${String(error)}`],
      manifest: null,
    };
  }
  if (manifest.format !== EVIDENCE_FORMAT) {
    return {
      ok: false,
      issues: [`unknown format "${String(manifest.format)}"`],
      manifest: null,
    };
  }
  if (
    typeof manifest.formatVersion !== "number" ||
    manifest.formatVersion > EVIDENCE_FORMAT_VERSION
  ) {
    return {
      ok: false,
      issues: [
        `bundle format version ${String(manifest.formatVersion)} is newer than this squirrel reads (${EVIDENCE_FORMAT_VERSION}); update squirrel`,
      ],
      manifest,
    };
  }
  if (!Array.isArray(manifest.files)) {
    return { ok: false, issues: ["manifest.json has no files list"], manifest };
  }
  const listed = new Set<string>();
  for (const file of manifest.files) {
    listed.add(file.path);
    const full = join(dir, ...file.path.split("/"));
    if (file.path.includes("..") || file.path.startsWith("/")) {
      issues.push(`${file.path}: unsafe path`);
      continue;
    }
    if (!existsSync(full)) {
      issues.push(`${file.path}: missing`);
      continue;
    }
    const bytes = readFileSync(full);
    if (bytes.length !== file.bytes)
      issues.push(
        `${file.path}: size ${bytes.length}, manifest says ${file.bytes}`
      );
    if (sha256(bytes) !== file.sha256)
      issues.push(`${file.path}: sha256 mismatch`);
    if (
      file.path.startsWith("artifacts/") &&
      !file.path.endsWith(file.sha256)
    ) {
      issues.push(`${file.path}: file name is not its sha256`);
    }
  }
  for (const path of walk(dir)) {
    if (path !== "manifest.json" && !listed.has(path))
      issues.push(`${path}: not in the manifest`);
  }
  if (bundleHash(manifest.files) !== manifest.bundleSha256)
    issues.push("bundleSha256 does not match the file list");

  // Every evidence ref must point at a listed artifact, or say why it cannot.
  const findingsFile = join(dir, "findings.json");
  if (existsSync(findingsFile)) {
    try {
      const findings = JSON.parse(
        readFileSync(findingsFile, "utf-8")
      ) as BundleFinding[];
      for (const finding of findings) {
        for (const ref of finding.evidence) {
          if (ref.state === "unavailable") {
            if (!ref.reason)
              issues.push(
                `finding ${finding.ruleId}: unavailable evidence has no reason`
              );
          } else if (ref.contentSha256 && ref.artifactType) {
            if (
              !listed.has(artifactPath(ref.artifactType, ref.contentSha256))
            ) {
              issues.push(
                `finding ${finding.ruleId}: references artifact ${ref.contentSha256} that is not in the bundle`
              );
            }
          }
        }
      }
    } catch (error) {
      issues.push(`findings.json is not valid JSON: ${String(error)}`);
    }
  }
  return { ok: issues.length === 0, issues, manifest };
}

// ── Replay ───────────────────────────────────────────────────────────────────────

export interface ReplayEntry {
  ruleId: string;
  check: string;
  pageUrl: string;
  outcome: "confirmed" | "mismatch" | "unavailable" | "no-location";
  detail?: string;
}

export interface ReplayResult {
  verified: VerifyResult;
  total: number;
  confirmed: number;
  mismatched: number;
  unavailable: number;
  noLocation: number;
  entries: ReplayEntry[];
}

/**
 * Re-check every finding's evidence against the archived artifacts: the byte range must still hash to
 * the recorded snippet, and the selector must still resolve in the archived DOM. Never touches the
 * network or the crawl store. Refuses a bundle that fails verification.
 */
export function replayEvidenceBundle(
  dir: string,
  resolveSelector: (html: string, selector: string) => boolean
): ReplayResult {
  const verified = verifyEvidenceBundle(dir);
  const empty: ReplayResult = {
    verified,
    total: 0,
    confirmed: 0,
    mismatched: 0,
    unavailable: 0,
    noLocation: 0,
    entries: [],
  };
  if (!verified.ok) return empty;
  const findings = JSON.parse(
    readFileSync(join(dir, "findings.json"), "utf-8")
  ) as BundleFinding[];
  const cache = new Map<string, Buffer>();
  const read = (type: ArtifactType, hash: string): Buffer => {
    const key = `${type}/${hash}`;
    let buf = cache.get(key);
    if (!buf) {
      buf = readFileSync(join(dir, ...artifactPath(type, hash).split("/")));
      if (cache.size > 8) cache.clear();
      cache.set(key, buf);
    }
    return buf;
  };
  const result = empty;
  for (const finding of findings) {
    for (const ref of finding.evidence) {
      result.total++;
      const base = {
        ruleId: finding.ruleId,
        check: finding.check,
        pageUrl: ref.pageUrl,
      };
      if (
        ref.state === "unavailable" ||
        !ref.contentSha256 ||
        !ref.artifactType
      ) {
        result.unavailable++;
        result.entries.push({
          ...base,
          outcome: "unavailable",
          detail: ref.reason,
        });
        continue;
      }
      const { selector, byteRange } = ref.locator;
      if (!selector && !byteRange) {
        result.noLocation++;
        result.entries.push({
          ...base,
          outcome: "no-location",
          detail: ref.reason,
        });
        continue;
      }
      const buffer = read(ref.artifactType, ref.contentSha256);
      let mismatch: string | null = null;
      if (byteRange) {
        const slice = buffer.subarray(byteRange.start, byteRange.end);
        if (sha256(slice) !== byteRange.snippetSha256)
          mismatch = "byte range no longer hashes to the recorded snippet";
      }
      if (!mismatch && selector) {
        let found = false;
        try {
          found = resolveSelector(buffer.toString("utf-8"), selector);
        } catch {
          found = false;
        }
        if (!found) mismatch = `selector does not resolve: ${selector}`;
      }
      if (mismatch) {
        result.mismatched++;
        result.entries.push({ ...base, outcome: "mismatch", detail: mismatch });
      } else {
        result.confirmed++;
        result.entries.push({ ...base, outcome: "confirmed" });
      }
    }
  }
  return result;
}

/** Whether `dir` holds a bundle for `crawlId` that passes verification. Used as the cleanup gate. */
export function hasVerifiedBundle(
  archiveRoot: string,
  crawlId: string
): boolean {
  const dir = join(archiveRoot, crawlId);
  if (!existsSync(join(dir, "manifest.json"))) return false;
  const result = verifyEvidenceBundle(dir);
  return result.ok && result.manifest?.crawlId === crawlId;
}
