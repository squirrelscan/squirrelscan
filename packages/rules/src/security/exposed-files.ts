// security/exposed-files - well-known sensitive files that are publicly readable
// (#1932)
//
// A loud probing rule: it requests a fixed, curated list of paths
// (exposed-files-allowlist.ts) that should never be served, so it runs only on
// an aggressive run (`--probe aggressive` or `--pentest`), the level the probe
// policy reserves for requests that make many 404s and hit robots-disallowed
// paths on purpose. Below aggressive, or with no `ctx.probe`, it sends nothing
// and reports a not-checked line that says how to turn it on.
//
// What is sent: one GET to a random path that cannot exist (the baseline),
// then one request per listed path, GET or, for a file that must never be
// downloaded, HEAD. Nothing else: no POST, no query string, no cookies. Every
// URL is built from the audited origin (scheme, host and port), so no request
// leaves it, and a redirect is never followed: a 3xx is "not exposed here",
// wherever it points. Each request is admitted by the shared probe budget, has
// its own timeout, and reads at most EXPOSED_FILE_READ_CAP bytes with body
// decoding off until that cap (#722), so a backup archive or a compression bomb
// is never pulled in full.
//
// What counts as a hit: a 2xx whose body matches the file's content signature
// (a magic number, a header line, a format only that file has). A status code
// alone is never a hit. A catch-all answer (homepage, SPA shell, themed 404
// served with 200) is dropped twice: the signatures reject HTML, and a hit is
// dropped when the baseline answered with the same bytes or also matched the
// signature.
//
// What is reported: each exposed file's URL, status, size, the signature that
// confirmed it and what kind of data it reveals. Never a value or a line from
// the file, and nothing is logged.
//
// Stops: an HTTP 429 or a bot challenge stops the run at once (no retry), as
// does the probe budget running out. The result then says the check is
// incomplete, and any hit already confirmed is still reported.

import {
  PROBE_INCOMPLETE_SKIP_REASON,
  PROBE_LEVEL_TOO_LOW_SKIP_REASON,
} from "@squirrelscan/core-contracts";
import { SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import { fetchUndecoded } from "@squirrelscan/utils/response-body";

import { hasRequestTool } from "../tools";
import type { CheckItem, CheckResult, Rule, RuleContext, RuleResult } from "../types";
import {
  EXPOSED_FILE_READ_CAP,
  EXPOSED_FILES_LIST_VERSION,
  type ProbeAnswer,
  SENSITIVE_FILES,
  type SensitiveFile,
  type SignatureMatch,
} from "./exposed-files-allowlist";
import { isThrottledOrChallenged, readCappedBytes } from "./probe-http";

const CHECK = "exposed-files";
const CLEAN = "exposed-files-none";
const NOT_CHECKED = "exposed-files-not-checked";
const INCOMPLETE = "exposed-files-incomplete";

/** Per-request timeout, on top of the shared probe budget's deadline. */
export const EXPOSED_FILE_PROBE_TIMEOUT_MS = 10_000;

const ENABLE_HINT = "Run with --probe aggressive (or --pentest) to check, on a site you own or may test.";

type ProbeOutcome =
  | { kind: "not-allowed" }
  | { kind: "error" }
  | { kind: "answer"; answer: ProbeAnswer; url: string };

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

/** The exact URL and init for one probe. Exported so tests can pin what is sent. */
export function buildExposedFileProbe(
  origin: string,
  path: string,
  method: "GET" | "HEAD"
): { url: string; init: RequestInit } {
  // Built on the origin, so a path can never name another host.
  const url = new URL(path, `${origin}/`);
  if (url.origin !== origin) throw new Error("exposed-files: probe left the audited origin");
  return {
    url: url.href,
    init: {
      method,
      credentials: "omit",
      redirect: "manual",
      headers: { Accept: "*/*", "User-Agent": SQUIRRELSCAN_USER_AGENT },
    },
  };
}

async function sendProbe(
  ctx: RuleContext,
  origin: string,
  path: string,
  method: "GET" | "HEAD"
): Promise<ProbeOutcome> {
  const probe = ctx.probe;
  if (!probe || !probe.allows("loud")) return { kind: "not-allowed" };
  const { url, init } = buildExposedFileProbe(origin, path, method);
  // Aborted once the probe is read, so a capped read does not keep pulling the
  // rest of a large file off the wire (see sendGraphqlProbe).
  const done = new AbortController();
  const signal = AbortSignal.any([
    probe.signal(),
    AbortSignal.timeout(EXPOSED_FILE_PROBE_TIMEOUT_MS),
    done.signal,
  ]);
  probe.record();
  try {
    const res = await fetchUndecoded(url, { ...init, signal });
    const { bytes } =
      method === "HEAD" ? { bytes: new Uint8Array(0) } : await readCappedBytes(res, EXPOSED_FILE_READ_CAP);
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
}

/** Rate limited or challenged: the site is pushing back, so no further probe is sent. */
export function isPushback(answer: ProbeAnswer): boolean {
  return isThrottledOrChallenged(answer);
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
 * The signature verdict for one answer, with the catch-all baseline applied: a
 * 2xx, a signature match, and not something the baseline path also produced.
 */
export function confirmHit(
  file: SensitiveFile,
  answer: ProbeAnswer,
  baseline: ProbeAnswer | null
): SignatureMatch | null {
  if (!isSuccess(answer.status)) return null;
  const match = file.match(answer);
  if (!match) return null;
  if (baseline && isSuccess(baseline.status)) {
    if (file.method === "GET" && answer.bytes.byteLength > 0 && sameBytes(answer.bytes, baseline.bytes)) return null;
    if (file.match(baseline)) return null;
  }
  return match;
}

function randomBaselinePath(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `/.squirrelscan-baseline-${hex}`;
}

interface Hit {
  file: SensitiveFile;
  url: string;
  status: number;
  /** See {@link answerSize}. */
  size: number | null;
  match: SignatureMatch;
}

/** Content-Length when the server sent a valid one, else the bytes read (a lower bound when the read was cut). */
function answerSize(file: SensitiveFile, answer: ProbeAnswer): number | null {
  const header = answer.headers.get("content-length");
  const length = header === null ? NaN : Number(header);
  if (Number.isFinite(length) && length >= 0) return length;
  return file.method === "GET" ? answer.bytes.byteLength : null;
}

function hitCheck(hit: Hit): CheckResult {
  const { file, url, status, size, match } = hit;
  const detail = match.detail ? ` (${match.detail})` : "";
  const item: CheckItem = {
    id: url,
    label: `${file.path}: ${file.reveals}${detail}`,
    meta: {
      path: file.path,
      method: file.method,
      status,
      ...(size !== null ? { size } : {}),
      signature: file.signature,
      group: file.group,
      reveals: file.reveals,
      ...(match.detail ? { detail: match.detail } : {}),
    },
  };
  return {
    name: CHECK,
    status: file.severity === "high" ? "fail" : "warn",
    message: `${file.path} is publicly readable at ${url}: it reveals ${file.reveals}${detail}`,
    items: [item],
    details: { path: file.path, status, signature: file.signature, group: file.group, severity: file.severity },
  };
}

export const exposedFilesRule: Rule = {
  meta: {
    id: "security/exposed-files",
    name: "Exposed Sensitive Files",
    description:
      "Requests a short, curated list of sensitive files that should never be public (.git and other version control metadata, .env files, configuration backups, server status pages, database dumps, .DS_Store) and flags each one the site serves, confirmed by its content, not its status code. Runs only when probing is aggressive.",
    solution:
      "Remove each listed file from the web root, or block it at the server: deny dotfiles and dot-directories (`location ~ /\\. { deny all; }` in nginx, `<FilesMatch \"^\\.\">Require all denied</FilesMatch>` in Apache), and keep backups, dumps and configuration copies outside the document root. Deploy from a build output, not a working copy, so `.git` never ships. Turn off `server-status`, `server-info` and `phpinfo()` pages in production, or restrict them to internal addresses. Then treat anything the file exposed as leaked: rotate every credential and key it held, and assume the source and history are public.",
    category: "security",
    scope: "site",
    findingScope: "page",
    severity: "error",
    weight: 8,
    // Check names by outcome class (#1741).
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
            message: `Exposed sensitive files not checked: probing is ${level}, and this rule only probes at aggressive. ${ENABLE_HINT}`,
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
              "Exposed sensitive files not checked: analyze runs offline; run `squirrel audit` to probe",
            value: "not-checked",
          },
        ],
      };
    }

    const origin = siteOrigin(ctx.site?.baseUrl);
    if (!origin) {
      return { checks: [{ name: NOT_CHECKED, status: "skipped", message: "Invalid base URL" }] };
    }

    const listDetails = { listVersion: EXPOSED_FILES_LIST_VERSION, listed: SENSITIVE_FILES.length };
    let stopped: "budget" | "pushback" | null = null;
    let probed = 0;
    let errored = 0;
    let redirected = 0;
    let serverErrors = 0;

    const baselineOutcome = await sendProbe(ctx, origin, randomBaselinePath(), "GET");
    let baseline: ProbeAnswer | null = null;
    if (baselineOutcome.kind === "not-allowed") stopped = "budget";
    else if (baselineOutcome.kind === "answer") {
      if (isPushback(baselineOutcome.answer)) stopped = "pushback";
      else baseline = baselineOutcome.answer;
    }

    const hits: Hit[] = [];
    if (!stopped) {
      for (const file of SENSITIVE_FILES) {
        const outcome = await sendProbe(ctx, origin, file.path, file.method);
        if (outcome.kind === "not-allowed") {
          stopped = "budget";
          break;
        }
        probed++;
        if (outcome.kind === "error") {
          errored++;
          continue;
        }
        const { answer, url } = outcome;
        if (isPushback(answer)) {
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
          continue;
        }
        const match = confirmHit(file, answer, baseline);
        if (!match) continue;
        hits.push({ file, url, status: answer.status, size: answerSize(file, answer), match });
      }
    }

    const checks: CheckResult[] = hits.map(hitCheck);
    const total = SENSITIVE_FILES.length;
    // Every path not answered: never reached, errored, a server error, or the
    // one that drew the pushback.
    const unverified = total - (probed - errored - serverErrors - (stopped === "pushback" && probed > 0 ? 1 : 0));
    const runDetails = {
      ...listDetails,
      probed,
      errored,
      serverErrors,
      redirected,
      exposed: hits.length,
      unverified,
    };

    // A path that was never answered may be exposed, so any gap makes the run incomplete.
    if (unverified > 0) {
      const why: string[] = [];
      if (stopped === "pushback") {
        why.push(
          `the site throttled the probes (HTTP 429) or answered with a bot challenge after ${probed} of ${total} path(s), so no further request was sent`
        );
      }
      if (stopped === "budget") why.push(`the probe budget ran out after ${probed} of ${total} path(s)`);
      if (errored > 0) why.push(`${errored} probe(s) failed with a network error or timeout`);
      if (serverErrors > 0) why.push(`${serverErrors} path(s) answered with a server error (5xx)`);
      checks.push({
        name: INCOMPLETE,
        status: "skipped",
        skipReason: PROBE_INCOMPLETE_SKIP_REASON,
        message: `Exposed sensitive files check incomplete: ${why.join("; ")}. ${unverified} of ${total} path(s) were not verified and may be exposed`,
        value: "not-checked",
        details: { ...runDetails, stoppedBy: stopped ?? (errored > 0 ? "errors" : "server-errors") },
      });
      return { checks };
    }

    if (hits.length === 0) {
      checks.push({
        name: CLEAN,
        status: "pass",
        message: `None of the ${SENSITIVE_FILES.length} well-known sensitive files is publicly readable`,
        details: runDetails,
      });
    }
    return { checks };
  },
};
