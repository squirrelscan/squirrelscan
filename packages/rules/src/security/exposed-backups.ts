// security/exposed-backups - backup and temporary copies of crawled server-side
// files (#2330)
//
// Editors and deploy scripts leave copies such as `page.php.bak`, `page.php~`
// or `.page.php.swp` next to the real file. The server runs `page.php`, but it
// serves the copy as a plain file, so the source code (and any credentials in
// it) is readable by anyone who guesses the name.
//
// A loud probing rule: it runs only on an aggressive run (`--probe aggressive`
// or `--pentest`), and below that, or with no `ctx.probe`, it sends nothing and
// reports a not-checked line that says how to turn it on.
//
// What may be probed. Candidates are derived only from the paths of pages the
// crawl fetched, never from a wordlist: a same-origin page whose last path
// segment has a server-side extension (BACKUP_SOURCE_EXTENSIONS) yields at most
// BACKUP_PROBES_PER_FILE sibling names (BACKUP_SIBLINGS). At most
// MAX_BACKUP_SOURCE_FILES files are used, and the whole run sends at most
// MAX_BACKUP_PROBES requests, baselines included. Every request is also
// admitted by the shared probe budget. A state-changing path (`logout.php`) is
// never used. Every URL is built on the audited origin, so no request leaves it.
//
// What is sent: a GET per candidate, no cookies, no query string, redirects
// never followed, at most BACKUP_READ_CAP bytes read with body decoding off
// until that cap (#722).
//
// What counts as a hit: a 2xx whose body is recognized by content as source
// code (PHP, ASP, JSP, ColdFusion, server-side includes, a script with a
// shebang), an archive (zip, gzip, tar), a Vim swap file or an SQL dump. A
// status code alone is never a hit, and a rendered HTML page carries none of
// these signatures. A catch-all answer (soft 404) is dropped by a baseline: on
// the first hit for a directory and sibling shape, the same shape is requested
// for a random file name that cannot exist, and the hit is dropped when that
// answer is a 2xx with the same bytes or the same inferred content type.
//
// What is reported: each exposed copy's URL, the crawled file it copies, its
// status, size and inferred content type. Never a line from the file.
//
// Stops: an HTTP 429 or a bot challenge stops the run at once (no retry), as
// do the probe budget and the per-audit cap. The result then says the check is
// incomplete, and any hit already confirmed is still reported.

import {
  PROBE_INCOMPLETE_SKIP_REASON,
  PROBE_LEVEL_TOO_LOW_SKIP_REASON,
} from "@squirrelscan/core-contracts";
import { SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import { fetchUndecoded } from "@squirrelscan/utils/response-body";

import type {
  CheckItem,
  CheckResult,
  Rule,
  RuleContext,
  RuleResult,
} from "../types";

import { hasRequestTool } from "../tools";
import { matchSqlDump, type ProbeAnswer } from "./exposed-files-allowlist";
import { isStateChangingPath } from "./graphql-probe";
import { isThrottledOrChallenged, readCappedBytes } from "./probe-http";

const CHECK = "exposed-backups";
const CLEAN = "exposed-backups-none";
const NOT_CHECKED = "exposed-backups-not-checked";
const INCOMPLETE = "exposed-backups-incomplete";

/** Per-request timeout, on top of the shared probe budget's deadline. */
export const BACKUP_PROBE_TIMEOUT_MS = 10_000;

/** Body bytes read per probe: enough for every signature below. */
export const BACKUP_READ_CAP = 16 * 1024;

/** Crawled files whose siblings are probed, per audit. */
export const MAX_BACKUP_SOURCE_FILES = 15;

/** Requests per audit, baselines included. A hard cap under the shared probe budget. */
export const MAX_BACKUP_PROBES = 120;

/**
 * Extensions of files a server runs instead of serving, so a copy under
 * another name exposes code the site never meant to publish. A static file
 * (`.html`, `.css`) is not listed: its copy shows nothing the original does not.
 */
export const BACKUP_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  "php",
  "php3",
  "php4",
  "php5",
  "php7",
  "phtml",
  "inc",
  "asp",
  "aspx",
  "ascx",
  "ashx",
  "asmx",
  "jsp",
  "jspx",
  "cfm",
  "cfml",
  "cfc",
  "pl",
  "cgi",
  "py",
  "rb",
  "shtml",
]);

export interface BackupSibling {
  /** Stable id of the shape, in findings and baseline keys. */
  id: string;
  /** The sibling's file name, from the crawled file's name and its name without the extension. */
  build(name: string, stem: string): string;
}

/** Sibling shapes, most common first. */
export const BACKUP_SIBLINGS: readonly BackupSibling[] = [
  { id: "bak", build: (name) => `${name}.bak` },
  { id: "tilde", build: (name) => `${name}~` },
  { id: "swp", build: (name) => `.${name}.swp` },
  { id: "old", build: (name) => `${name}.old` },
  { id: "stem-bak", build: (_name, stem) => `${stem}.bak` },
  { id: "zip", build: (name) => `${name}.zip` },
];

/** Sibling names probed per crawled file. */
export const BACKUP_PROBES_PER_FILE = 6;

// A last path segment with an extension: bounded, so a long segment costs nothing.
const FILE_SEGMENT_RE = /^([^/]{1,200})\.([A-Za-z0-9]{1,8})$/;

export interface BackupSourceFile {
  /** Pathname of the crawled file (percent-encoded, as the URL holds it). */
  path: string;
  /** Directory, ending in `/`. */
  dir: string;
  name: string;
  stem: string;
  ext: string;
}

export interface BackupCandidate {
  source: BackupSourceFile;
  sibling: BackupSibling;
  /** Pathname of the sibling. */
  path: string;
}

function siteOrigin(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The crawled file a URL names, or null when it is off-origin or not a server-side file. */
export function backupSourceFile(
  url: string,
  origin: string
): BackupSourceFile | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  const path = u.pathname;
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const m = FILE_SEGMENT_RE.exec(name);
  if (!m) return null;
  const ext = m[2]!.toLowerCase();
  if (!BACKUP_SOURCE_EXTENSIONS.has(ext)) return null;
  if (isStateChangingPath(path)) return null;
  return { path, dir: path.slice(0, slash + 1), name, stem: m[1]!, ext };
}

/**
 * Crawled server-side files, in crawl order, deduped on path and capped at
 * {@link MAX_BACKUP_SOURCE_FILES}. `found` counts every eligible file.
 */
export function selectBackupSourceFiles(
  urls: Iterable<string>,
  origin: string
): { files: BackupSourceFile[]; found: number } {
  const seen = new Set<string>();
  const files: BackupSourceFile[] = [];
  for (const url of urls) {
    const file = backupSourceFile(url, origin);
    if (!file || seen.has(file.path)) continue;
    seen.add(file.path);
    if (files.length < MAX_BACKUP_SOURCE_FILES) files.push(file);
  }
  return { files, found: seen.size };
}

/** The sibling candidates of one file, at most {@link BACKUP_PROBES_PER_FILE}. */
export function backupCandidates(file: BackupSourceFile): BackupCandidate[] {
  return BACKUP_SIBLINGS.slice(0, BACKUP_PROBES_PER_FILE).map((sibling) => ({
    source: file,
    sibling,
    path: `${file.dir}${sibling.build(file.name, file.stem)}`,
  }));
}

/** The exact URL and init for one probe. Exported so tests can pin what is sent. */
export function buildBackupProbe(
  origin: string,
  path: string
): { url: string; init: RequestInit } {
  const url = new URL(path, `${origin}/`);
  if (url.origin !== origin)
    throw new Error("exposed-backups: probe left the audited origin");
  url.search = "";
  url.hash = "";
  return {
    url: url.href,
    init: {
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      headers: { Accept: "*/*", "User-Agent": SQUIRRELSCAN_USER_AGENT },
    },
  };
}

// ── content signatures ──────────────────────────────────────────────

export type BackupContentKind = "source" | "archive" | "swap" | "data";

export interface BackupContent {
  kind: BackupContentKind;
  /** The inferred content type, in the finding ("PHP source", "ZIP archive"). */
  contentType: string;
}

function startsWithBytes(
  bytes: Uint8Array,
  magic: readonly number[],
  offset = 0
): boolean {
  if (bytes.byteLength < offset + magic.length) return false;
  return magic.every((b, i) => bytes[offset + i] === b);
}

const ASP_DIRECTIVE_RE =
  /<%@\s{0,16}(page|language|import|taglib|control|include|master|webhandler|webservice|application)\b/i;
const RUNAT_SERVER_RE =
  /<script\b[^>]{0,512}\brunat\s{0,16}=\s{0,16}["']?server\b/i;
const CFML_RE =
  /<cf(set|query|component|function|if|include|param|output|script|location|mail)\b/i;
const SSI_RE = /<!--#(include|exec|echo|set|config|if)\s/i;
const SHEBANG_RE =
  /^#!\s{0,4}\/[\w/. -]{0,64}?\b(perl|python[\d.]{0,4}|ruby|php|bash|sh)\b/;
const ASP_OR_JSP_EXTENSIONS: ReadonlySet<string> = new Set([
  "asp",
  "aspx",
  "ascx",
  "ashx",
  "asmx",
  "jsp",
  "jspx",
]);

/** An ASP or JSP code block: `<%` then `=`, `#`, `:` or a space, and a closing `%>` later. */
function hasServerCodeBlock(text: string): boolean {
  let from = 0;
  while (true) {
    const at = text.indexOf("<%", from);
    if (at === -1) return false;
    const next = text[at + 2];
    if (next !== undefined && /[=#:\s]/.test(next))
      return text.includes("%>", at + 3);
    from = at + 2;
  }
}

function aspLabel(ext: string): string {
  if (ext === "jsp" || ext === "jspx") return "JSP source";
  if (ext === "asp") return "ASP source";
  if (ext.startsWith("as")) return "ASP.NET source";
  return "ASP or JSP source";
}

/**
 * What a backup body exposes, judged by its content alone, or null when it is
 * nothing this rule recognizes (a rendered HTML page, an empty body, text).
 * `sourceExt` is the crawled file's extension: it names an ASP or JSP block's
 * language and gates the loosest signature.
 */
export function classifyBackup(
  answer: ProbeAnswer,
  sourceExt: string
): BackupContent | null {
  const { bytes, text } = answer;
  if (bytes.byteLength === 0) return null;
  if (
    startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWithBytes(bytes, [0x50, 0x4b, 0x05, 0x06])
  )
    return { kind: "archive", contentType: "ZIP archive" };
  if (startsWithBytes(bytes, [0x1f, 0x8b]))
    return { kind: "archive", contentType: "gzip archive" };
  if (startsWithBytes(bytes, [0x75, 0x73, 0x74, 0x61, 0x72], 257))
    return { kind: "archive", contentType: "tar archive" };
  // "b0VIM " opens every Vim swap file; it holds the edited text.
  if (startsWithBytes(bytes, [0x62, 0x30, 0x56, 0x49, 0x4d, 0x20]))
    return { kind: "swap", contentType: "Vim swap file" };
  if (/<\?php\b/i.test(text))
    return { kind: "source", contentType: "PHP source" };
  // A bare `<% %>` block is read only for an ASP or JSP file: any other page
  // may show one as text.
  if (
    ASP_DIRECTIVE_RE.test(text) ||
    RUNAT_SERVER_RE.test(text) ||
    (ASP_OR_JSP_EXTENSIONS.has(sourceExt) && hasServerCodeBlock(text))
  )
    return { kind: "source", contentType: aspLabel(sourceExt) };
  if (CFML_RE.test(text))
    return { kind: "source", contentType: "ColdFusion source" };
  if (SSI_RE.test(text))
    return { kind: "source", contentType: "server-side include directives" };
  const shebang = SHEBANG_RE.exec(text);
  if (shebang) {
    const lang = shebang[1]!.replace(/[\d.]+$/, "");
    const names: Record<string, string> = {
      perl: "Perl",
      python: "Python",
      ruby: "Ruby",
      php: "PHP",
      bash: "shell",
      sh: "shell",
    };
    return {
      kind: "source",
      contentType: `${names[lang] ?? "script"} script source`,
    };
  }
  if (matchSqlDump(answer)) return { kind: "data", contentType: "SQL dump" };
  return null;
}

// ── probing ─────────────────────────────────────────────────────────

type ProbeOutcome =
  | { kind: "not-allowed" }
  | { kind: "capped" }
  | { kind: "error" }
  | { kind: "answer"; answer: ProbeAnswer; url: string };

interface Sender {
  sent: number;
  send(path: string): Promise<ProbeOutcome>;
}

function createSender(ctx: RuleContext, origin: string): Sender {
  const sender: Sender = {
    sent: 0,
    async send(path) {
      if (sender.sent >= MAX_BACKUP_PROBES) return { kind: "capped" };
      const probe = ctx.probe;
      if (!probe || !probe.allows("loud")) return { kind: "not-allowed" };
      const { url, init } = buildBackupProbe(origin, path);
      const done = new AbortController();
      const signal = AbortSignal.any([
        probe.signal(),
        AbortSignal.timeout(BACKUP_PROBE_TIMEOUT_MS),
        done.signal,
      ]);
      sender.sent++;
      probe.record();
      try {
        const res = await fetchUndecoded(url, { ...init, signal });
        const { bytes } = await readCappedBytes(res, BACKUP_READ_CAP);
        return {
          kind: "answer",
          url,
          answer: {
            status: res.status,
            contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
            headers: res.headers,
            bytes,
            text: new TextDecoder().decode(bytes),
          },
        };
      } catch {
        return { kind: "error" };
      } finally {
        done.abort();
      }
    },
  };
  return sender;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * True when the baseline (the same sibling shape for a file that cannot exist)
 * shows the hit is a catch-all: a 2xx with the same bytes or the same
 * inferred content type.
 */
export function isCatchAll(
  hit: ProbeAnswer,
  hitContent: BackupContent,
  baseline: ProbeAnswer,
  sourceExt: string
): boolean {
  if (!isSuccess(baseline.status)) return false;
  if (sameBytes(hit.bytes, baseline.bytes)) return true;
  return (
    classifyBackup(baseline, sourceExt)?.contentType === hitContent.contentType
  );
}

function randomStem(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `squirrelscan-baseline-${hex}`;
}

type BaselineVerdict =
  | "confirmed"
  | "catch-all"
  | "unverified"
  | "pushback"
  | "budget"
  | "cap";

interface Hit {
  candidate: BackupCandidate;
  url: string;
  status: number;
  size: number;
  content: BackupContent;
}

/** Content-Length when the server sent a valid one, else the bytes read (a lower bound when the read was cut). */
function answerSize(answer: ProbeAnswer): number {
  const header = answer.headers.get("content-length");
  const length = header === null ? NaN : Number(header);
  if (Number.isFinite(length) && length >= 0) return length;
  return answer.bytes.byteLength;
}

function hitCheck(hit: Hit): CheckResult {
  const { candidate, url, status, size, content } = hit;
  const item: CheckItem = {
    id: url,
    label: `${candidate.path}: ${content.contentType}, a copy of ${candidate.source.path}`,
    meta: {
      path: candidate.path,
      source: candidate.source.path,
      sibling: candidate.sibling.id,
      status,
      size,
      contentType: content.contentType,
      kind: content.kind,
    },
  };
  return {
    name: CHECK,
    status: "fail",
    message: `${candidate.path} is publicly readable at ${url}: a backup or temporary copy of ${candidate.source.path}, served as ${content.contentType}`,
    items: [item],
    details: {
      path: candidate.path,
      source: candidate.source.path,
      status,
      contentType: content.contentType,
      kind: content.kind,
    },
  };
}

function crawledUrls(ctx: RuleContext): string[] {
  const urls: string[] = [];
  for (const page of ctx.site?.pages ?? []) {
    urls.push(page.url);
    if (page.finalUrl && page.finalUrl !== page.url) urls.push(page.finalUrl);
  }
  return urls;
}

export const exposedBackupsRule: Rule = {
  meta: {
    id: "security/exposed-backups",
    name: "Exposed Backup Copies",
    description:
      "Requests backup and temporary copies of crawled server-side files (page.php.bak, page.php~, .page.php.swp, page.php.zip and the like) and flags each one the site serves, confirmed by its content: source code, an archive, a Vim swap file or an SQL dump. Runs only when probing is aggressive.",
    solution:
      "Delete each listed copy from the web root and stop new ones from appearing: deploy from a build output or a clean checkout, not a directory you edit in place, and keep editor swap and backup files out of it. Block the shapes at the server as well, for example `location ~* (\\.(bak|old|orig|swp|zip)|~)$ { deny all; }` in nginx or a matching `<FilesMatch>` with `Require all denied` in Apache. Then treat what the copy exposed as leaked: rotate every credential it held, and review the source for the flaws an attacker can now read.",
    category: "security",
    scope: "site",
    findingScope: "page",
    severity: "error",
    weight: 8,
    checks: [
      { name: CHECK, outcome: "problem" },
      { name: CLEAN, outcome: "clean", clears: [CHECK] },
      { name: NOT_CHECKED, outcome: "skipped" },
      { name: INCOMPLETE, outcome: "skipped" },
    ],
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const level = ctx.probe?.level ?? "passive";
    if (level !== "aggressive") {
      return {
        checks: [
          {
            name: NOT_CHECKED,
            status: "skipped",
            skipReason: PROBE_LEVEL_TOO_LOW_SKIP_REASON,
            message: `Backup copies of crawled files not checked: probing is ${level}, and this rule only probes at aggressive.`,
            value: "not-checked",
            details: { probeLevel: level, requiredLevel: "aggressive" },
          },
        ],
      };
    }

    // `squirrel analyze` installs no request tool: it re-reads stored data and must not touch the site.
    if (!hasRequestTool()) {
      return {
        checks: [
          {
            name: NOT_CHECKED,
            status: "skipped",
            skipReason: "analyze-offline",
            message:
              "Backup copies of crawled files not checked: analyze runs offline; run `squirrel audit` to probe",
            value: "not-checked",
          },
        ],
      };
    }

    const origin = siteOrigin(ctx.site?.baseUrl);
    if (!origin) {
      return {
        checks: [
          { name: NOT_CHECKED, status: "skipped", message: "Invalid base URL" },
        ],
      };
    }

    const { files, found } = selectBackupSourceFiles(crawledUrls(ctx), origin);
    if (files.length === 0) {
      return {
        checks: [
          {
            name: CLEAN,
            status: "pass",
            message:
              "No crawled server-side file (.php, .asp, .jsp and the like) to derive backup copies from",
            details: { files: 0, probed: 0 },
          },
        ],
      };
    }

    const candidates = files.flatMap(backupCandidates);
    const sender = createSender(ctx, origin);
    const baselines = new Map<string, Promise<BaselineVerdict>>();
    let stopped: "budget" | "pushback" | "cap" | null = null;
    let probed = 0;
    let errored = 0;
    let serverErrors = 0;
    let redirected = 0;
    let catchAll = 0;
    let unconfirmed = 0;
    const hits: Hit[] = [];

    const baselineFor = (
      candidate: BackupCandidate,
      hit: ProbeAnswer,
      content: BackupContent
    ): Promise<BaselineVerdict> => {
      const key = JSON.stringify([
        candidate.source.dir,
        candidate.sibling.id,
        content.contentType,
      ]);
      let pending = baselines.get(key);
      if (!pending) {
        const stem = randomStem();
        const name = `${stem}.${candidate.source.ext}`;
        const path = `${candidate.source.dir}${candidate.sibling.build(name, stem)}`;
        pending = sender.send(path).then((outcome): BaselineVerdict => {
          if (outcome.kind === "not-allowed") return "budget";
          if (outcome.kind === "capped") return "cap";
          if (outcome.kind === "error") return "unverified";
          const { answer } = outcome;
          if (isThrottledOrChallenged(answer)) return "pushback";
          if (answer.status >= 500) return "unverified";
          return isCatchAll(hit, content, answer, candidate.source.ext)
            ? "catch-all"
            : "confirmed";
        });
        baselines.set(key, pending);
      }
      return pending;
    };

    // Candidates sent and answered in a way that settles them: a miss, a
    // redirect, a catch-all, or a confirmed hit.
    let settled = 0;
    for (const candidate of candidates) {
      const outcome = await sender.send(candidate.path);
      if (outcome.kind === "not-allowed") {
        stopped = "budget";
        break;
      }
      if (outcome.kind === "capped") {
        stopped = "cap";
        break;
      }
      probed++;
      if (outcome.kind === "error") {
        errored++;
        continue;
      }
      const { answer, url } = outcome;
      if (isThrottledOrChallenged(answer)) {
        stopped = "pushback";
        break;
      }
      if (answer.status >= 500) {
        // A server error says nothing about the path: not checked (#1920).
        serverErrors++;
        continue;
      }
      if (answer.status >= 300 && answer.status < 400) {
        // Never followed, wherever it points.
        redirected++;
        settled++;
        continue;
      }
      const content = isSuccess(answer.status)
        ? classifyBackup(answer, candidate.source.ext)
        : null;
      if (!content) {
        settled++;
        continue;
      }
      const verdict = await baselineFor(candidate, answer, content);
      if (verdict === "catch-all") {
        catchAll++;
        settled++;
        continue;
      }
      if (verdict !== "confirmed") {
        // The copy may be real, but nothing tells it from a catch-all.
        unconfirmed++;
        if (verdict === "unverified") continue;
        stopped = verdict;
        break;
      }
      settled++;
      hits.push({
        candidate,
        url,
        status: answer.status,
        size: answerSize(answer),
        content,
      });
    }

    const checks: CheckResult[] = hits.map(hitCheck);
    const total = candidates.length;
    // Every candidate not settled: never reached, errored, a server error,
    // the one that drew the pushback, or a hit no baseline could confirm.
    const unverified = total - settled;
    const runDetails = {
      files: files.length,
      filesFound: found,
      candidates: total,
      probed,
      requests: sender.sent,
      errored,
      serverErrors,
      redirected,
      catchAll,
      exposed: hits.length,
      unverified,
    };

    if (unverified > 0) {
      const why: string[] = [];
      if (stopped === "pushback")
        why.push(
          `the site throttled the probes (HTTP 429) or answered with a bot challenge after ${probed} of ${total} path(s), so no further request was sent`
        );
      if (stopped === "budget")
        why.push(
          `the probe budget ran out after ${probed} of ${total} path(s)`
        );
      if (stopped === "cap")
        why.push(
          `the per-audit cap of ${MAX_BACKUP_PROBES} requests was reached after ${probed} of ${total} path(s)`
        );
      if (errored > 0)
        why.push(`${errored} probe(s) failed with a network error or timeout`);
      if (serverErrors > 0)
        why.push(`${serverErrors} path(s) answered with a server error (5xx)`);
      if (unconfirmed > 0)
        why.push(
          `${unconfirmed} possible copy(ies) could not be told apart from a catch-all answer`
        );
      checks.push({
        name: INCOMPLETE,
        status: "skipped",
        skipReason: PROBE_INCOMPLETE_SKIP_REASON,
        message: `Backup copies check incomplete: ${why.join("; ")}. ${unverified} of ${total} path(s) were not verified and may be exposed`,
        value: "not-checked",
        details: {
          ...runDetails,
          stoppedBy:
            stopped ??
            (errored > 0
              ? "errors"
              : serverErrors > 0
                ? "server-errors"
                : "unconfirmed"),
        },
      });
      return { checks };
    }

    if (hits.length === 0) {
      const sampled =
        found > files.length
          ? ` (the first ${files.length} of ${found} crawled server-side files)`
          : "";
      checks.push({
        name: CLEAN,
        status: "pass",
        message: `No backup or temporary copy of ${files.length} crawled server-side file(s) is publicly readable${sampled}`,
        details: runDetails,
      });
    }
    return { checks };
  },
};
