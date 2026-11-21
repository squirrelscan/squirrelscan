// security/supabase-rls - Supabase tables readable with the site's public anon key (repo#1959)
//
// A Supabase app ships its project URL and anon key to every visitor. That is by
// design: Row Level Security (RLS) policies decide what the anon role may read.
// A table with RLS off answers its rows to anyone holding the anon key, which is
// anyone who opened the site.
//
// A probing rule, and a loud one (the policy decision on repo#1959, under
// repo#1931): it sends requests to the site's Supabase project host, which is not
// the audited origin, so it runs only on an aggressive run (`--probe
// aggressive`), only when the audit may request other hosts (external link
// checking on, not `--offline`), and inside the shared probe budget. A hosted
// audit of a website whose ownership is not verified is locked passive, so it
// never sends one.
//
// What may be probed. Finding the project and key sends nothing: they are read
// from the scripts and inline scripts the crawl already fetched.
//  - The host is always `<ref>.supabase.co` (or the legacy `.supabase.in`), with
//    `<ref>` a 20-character project ref, built here from that pattern. No other
//    host is ever requested, and the egress guard refuses one that resolves to
//    a private, link-local or metadata address.
//  - The key is an anon key: a JWT whose payload says `iss: "supabase"`,
//    `role: "anon"`, names the project in `ref` and has not expired, sent only
//    to that project; or a `sb_publishable_` key, sent only to the one project
//    the same script names. A service-role key or a `sb_secret_` key is never
//    used: it bypasses RLS, so a hit would prove nothing, and it is not ours to
//    use.
//  - Tables: only the names the site's own shipped code queries
//    (`.from("x").select(...)`, `/rest/v1/x`). No table name is guessed. At most
//    MAX_PROJECTS projects, MAX_TABLES_PER_PROJECT tables each and
//    MAX_TABLE_PROBES requests in all.
//
// What is sent (the planning decision on repo#1959: no row is ever read). One
// `HEAD /rest/v1/<table>` per table, with no query string, `Prefer: count=exact`
// and the anon key in the `apikey` header (and as the bearer token for a JWT
// key). PostgREST answers a HEAD with the status and a `Content-Range` header
// whose total is the number of rows the anon role can see; there is no body,
// and the rule never reads one even if a server sends it. No cookies, none of
// the audit's custom headers, no redirects followed. Exposure is judged only
// from the status and that total: no row, no value and no column name comes
// back, so none can be stored or reported.

import { PROBE_INCOMPLETE_SKIP_REASON } from "@squirrelscan/core-contracts";
import { SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import {
  egressGuardedSend,
  memoizeResolveHost,
  resolveHostAddresses,
  type EgressPolicy,
  type ResolveHost,
} from "@squirrelscan/utils/public-egress";

import type { ProbeBudget } from "../probe-budget";
import type { CheckItem, CheckResult, Rule, RuleContext, RuleResult } from "../types";
import { isThrottledOrChallenged } from "./probe-http";

const CHECK = "supabase-rls";

/** Supabase projects probed per run. */
export const MAX_PROJECTS = 2;
/** Tables probed per project. */
export const MAX_TABLES_PER_PROJECT = 8;
/** Table requests per run, across every project. */
export const MAX_TABLE_PROBES = 10;
/** Per-request timeout, on top of the shared probe budget's deadline. */
export const PROBE_TIMEOUT_MS = 10_000;
/** Characters of one script scanned. Bundles past it are read up to it. */
const MAX_SCAN_CHARS = 4 * 1024 * 1024;

// A project ref is 20 lowercase alphanumerics. Placeholders (`your-project`,
// twenty of one character) are not refs.
const PROJECT_URL_RE =
  /https:\/\/(?!your)(?!([a-z0-9])\1{19}\.)([a-z0-9]{20})\.supabase\.(co|in)(?![a-z0-9-])/g;
const REF_RE = /^[a-z0-9]{20}$/;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,2000}\.eyJ[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,1000}/g;
const PUBLISHABLE_RE = /\bsb_publishable_[A-Za-z0-9_-]{20,200}/g;
// supabase-js query chains keep their method names when minified:
// `.from("profiles").select("*")`. Requiring the chain keeps `Array.from("abc")`
// and `Buffer.from("...")` out.
const FROM_CHAIN_RE =
  /\.from\(\s*(["'`])([A-Za-z_][A-Za-z0-9_]{0,62})\1\s*\)\s*\.\s*(?:select|insert|update|upsert|delete)\s*\(/g;
const REST_PATH_RE = /\/rest\/v1\/([A-Za-z_][A-Za-z0-9_]{0,62})(?![A-Za-z0-9_])/g;
const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
/** PostgREST paths under /rest/v1 that are not tables. */
const NOT_TABLES = new Set(["rpc"]);

export type SupabaseKeyKind = "anon-jwt" | "publishable";

export interface SupabaseProject {
  ref: string;
  /** `<ref>.supabase.co` or `<ref>.supabase.in`. */
  host: string;
  key: string;
  keyKind: SupabaseKeyKind;
  /** Where the key was read: a script URL or a page URL. */
  keySource: string;
}

export interface SupabaseDiscovery {
  projects: SupabaseProject[];
  /** Projects past MAX_PROJECTS. */
  projectsSkipped: number;
  /** Table names the site's code queries, in first-seen order. */
  tables: string[];
  /** Service-role or secret keys seen and deliberately not used. */
  privilegedKeysIgnored: number;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json: unknown = JSON.parse(atob(padded));
    return typeof json === "object" && json !== null && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A Supabase key the JWT is, or null: an unexpired anon key names its project. */
export function readSupabaseJwt(
  token: string,
  nowSeconds: number,
): { role: "anon"; ref: string } | { role: "privileged" } | null {
  const payload = decodeJwtPayload(token);
  if (!payload || payload.iss !== "supabase") return null;
  if (payload.role !== "anon")
    return payload.role === "service_role" ? { role: "privileged" } : null;
  const ref = payload.ref;
  if (typeof ref !== "string" || !REF_RE.test(ref)) return null;
  if (typeof payload.exp === "number" && payload.exp <= nowSeconds) return null;
  return { role: "anon", ref };
}

/**
 * The Supabase projects, anon keys and queried table names in the given
 * sources. Pure: sends nothing.
 */
export function discoverSupabase(
  sources: ReadonlyArray<{ url: string; content: string }>,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SupabaseDiscovery {
  const projects = new Map<string, SupabaseProject>();
  const hostByRef = new Map<string, string>();
  const tables: string[] = [];
  const seenTables = new Set<string>();
  let privilegedKeysIgnored = 0;

  const addTable = (name: string): void => {
    if (!TABLE_NAME_RE.test(name) || NOT_TABLES.has(name.toLowerCase())) return;
    if (seenTables.has(name)) return;
    seenTables.add(name);
    tables.push(name);
  };

  for (const source of sources) {
    const text =
      source.content.length > MAX_SCAN_CHARS
        ? source.content.slice(0, MAX_SCAN_CHARS)
        : source.content;
    const refsHere = new Map<string, string>();
    for (const m of text.matchAll(PROJECT_URL_RE)) {
      const ref = m[2]!;
      const host = `${ref}.supabase.${m[3]}`;
      refsHere.set(ref, host);
      if (!hostByRef.has(ref)) hostByRef.set(ref, host);
    }
    for (const m of text.matchAll(JWT_RE)) {
      const read = readSupabaseJwt(m[0], nowSeconds);
      if (!read) continue;
      if (read.role === "privileged") {
        privilegedKeysIgnored++;
        continue;
      }
      if (!projects.has(read.ref)) {
        projects.set(read.ref, {
          ref: read.ref,
          host: refsHere.get(read.ref) ?? hostByRef.get(read.ref) ?? `${read.ref}.supabase.co`,
          key: m[0],
          keyKind: "anon-jwt",
          keySource: source.url,
        });
      }
    }
    // A publishable key does not name its project: use it only when the same
    // source names exactly one.
    const publishable = text.match(PUBLISHABLE_RE);
    if (publishable && refsHere.size === 1) {
      const [ref, host] = [...refsHere][0]!;
      if (!projects.has(ref)) {
        projects.set(ref, {
          ref,
          host,
          key: publishable[0],
          keyKind: "publishable",
          keySource: source.url,
        });
      }
    }
    if (/\bsb_secret_[A-Za-z0-9_-]{20,}/.test(text)) privilegedKeysIgnored++;
    for (const m of text.matchAll(FROM_CHAIN_RE)) addTable(m[2]!);
    for (const m of text.matchAll(REST_PATH_RE)) addTable(m[1]!);
  }

  const all = [...projects.values()];
  return {
    projects: all.slice(0, MAX_PROJECTS),
    projectsSkipped: Math.max(0, all.length - MAX_PROJECTS),
    tables,
    privilegedKeysIgnored,
  };
}

/** The tables to try on one project: only the ones the site's own code names, capped. */
export function tableTargets(codeTables: readonly string[]): string[] {
  return [...new Set(codeTables)].slice(0, MAX_TABLES_PER_PROJECT);
}

/** The exact URL and init of one table probe. Exported so tests can pin what is sent. */
export function buildTableProbe(
  project: SupabaseProject,
  table: string,
): { url: string; init: RequestInit } {
  if (!REF_RE.test(project.ref) || !TABLE_NAME_RE.test(table))
    throw new Error("refused: not a project ref or table");
  const host = project.host.endsWith(".supabase.in")
    ? `${project.ref}.supabase.in`
    : `${project.ref}.supabase.co`;
  const headers: Record<string, string> = {
    Prefer: "count=exact",
    "User-Agent": SQUIRRELSCAN_USER_AGENT,
    apikey: project.key,
  };
  if (project.keyKind === "anon-jwt") headers.Authorization = `Bearer ${project.key}`;
  return {
    url: `https://${host}/rest/v1/${table}`,
    init: { method: "HEAD", credentials: "omit", redirect: "manual", headers },
  };
}

export type TableVerdict =
  /** 2xx with a Content-Range total above zero: the anon role can see that many rows. */
  | { kind: "exposed"; rows: number }
  /**
   * The project pushed back instead of answering: a 429, a bot challenge
   * (`cf-mitigated: challenge`) or a 403 carrying WAF or challenge markers. Says
   * nothing about the table, and ends the run.
   */
  | { kind: "throttled"; status: number }
  /** 401 or a plain 403, not HTML: RLS or grants refuse the anon role (PostgREST answers `42501` with one of these). */
  | { kind: "protected"; status: number }
  /** 2xx with a total of zero: RLS hides every row, or the table is empty. The two look the same. */
  | { kind: "empty"; status: number }
  /** 404, not HTML: no such table in the exposed schema. */
  | { kind: "missing"; status: number }
  /** Any other status, an HTML 401, 403 or 404, or a 2xx without a usable total: not checked. */
  | { kind: "other"; status: number }
  | { kind: "errored" }
  | { kind: "not-sent" };

// `0-24/25`, `*/0`, `*/25`. A total of `*` is a count the server would not give.
const CONTENT_RANGE_RE = /^\s*(?:\d+-\d+|\*)\s*\/\s*(\d{1,15}|\*)\s*$/;

/**
 * Judge one answer from its status, its headers' pushback markers and its
 * `Content-Range` total alone. No body is an input: there is none to a HEAD,
 * and the rule does not read one.
 */
export function classifyTableResponse(
  status: number,
  contentRange: string | null,
  headers: Headers | null = null,
): TableVerdict {
  if (isThrottledOrChallenged({ status, headers, text: "" })) return { kind: "throttled", status };
  // An HTML 401, 403 or 404 is a page from something in front of the API (a
  // WAF block page without cf-mitigated, a proxy's error page), not PostgREST's
  // answer, and a HEAD has no body to tell which. Not checked. A JSON content
  // type, or none at all, keeps its meaning (#1883 review).
  if ((status === 401 || status === 403 || status === 404) && isHtml(headers))
    return { kind: "other", status };
  if (status === 401 || status === 403) return { kind: "protected", status };
  if (status === 404) return { kind: "missing", status };
  if (status < 200 || status >= 300) return { kind: "other", status };
  const m = contentRange ? CONTENT_RANGE_RE.exec(contentRange) : null;
  if (!m || m[1] === "*") return { kind: "other", status };
  const rows = Number(m[1]);
  return rows > 0 ? { kind: "exposed", rows } : { kind: "empty", status };
}

function isHtml(headers: Headers | null): boolean {
  const type = headers?.get("content-type");
  if (!type) return false;
  return type.split(";")[0]!.trim().toLowerCase() === "text/html";
}

async function probeTable(
  budget: ProbeBudget,
  project: SupabaseProject,
  table: string,
  egress: EgressPolicy,
): Promise<TableVerdict> {
  if (!budget.allows("loud")) return { kind: "not-sent" };
  const { url, init } = buildTableProbe(project, table);
  const done = new AbortController();
  const signal = AbortSignal.any([
    budget.signal(),
    AbortSignal.timeout(PROBE_TIMEOUT_MS),
    done.signal,
  ]);
  // Counted before the request leaves, so a request that fails still uses budget.
  budget.record();
  try {
    // Pinned to the address the egress guard vetted. Only the status and one
    // header are read; the body, if a server sends one to a HEAD, is never
    // touched, and aborting `done` below releases the connection.
    const res = await egressGuardedSend((u, i) => fetch(u, i), egress)(url, { ...init, signal });
    return classifyTableResponse(res.status, res.headers.get("content-range"), res.headers);
  } catch {
    // A network error, a timeout, or a refusal by the egress guard (nothing was sent).
    return { kind: "errored" };
  } finally {
    done.abort();
  }
}

/** The text the rule scans: fetched scripts, then the inline scripts of live pages. */
function sourcesOf(ctx: RuleContext): Array<{ url: string; content: string }> {
  const out: Array<{ url: string; content: string }> = [];
  for (const script of ctx.site?.scripts ?? []) {
    if (script.content) out.push({ url: script.url, content: script.content });
  }
  for (const page of ctx.site?.pages ?? []) {
    const doc = page.parsed?.document;
    if (!doc) continue;
    const inline: string[] = [];
    for (const el of doc.querySelectorAll("script:not([src])")) {
      const text = el.textContent ?? "";
      if (text.length > 0) inline.push(text);
    }
    if (inline.length > 0) out.push({ url: page.url, content: inline.join("\n") });
  }
  return out;
}

export interface SupabaseRlsDeps {
  resolve?: ResolveHost;
  now?: () => number;
}

interface ProjectResult {
  project: SupabaseProject;
  exposed: Array<{ table: string; rows: number }>;
  probed: number;
  protectedCount: number;
  empty: number;
  missing: number;
  notChecked: number;
  errored: number;
  throttled: number;
}

/**
 * The URL a key was read from, without userinfo, query string or fragment: a
 * script served as `https://user:pass@host/index.js?token=...#x` must not carry
 * the credentials or the token into the result.
 */
export function sanitizeKeySource(source: string): string {
  try {
    const u = new URL(source);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    const bare = source.split(/[?#]/, 1)[0] ?? "";
    // Drop anything up to an `@` in the authority, as the URL parser would.
    return bare.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
  }
}

/** The rule, with DNS and the clock injectable for tests; {@link supabaseRlsRule} uses the system ones. */
export function createSupabaseRlsRule(deps: SupabaseRlsDeps = {}): Rule {
  const resolveHost = deps.resolve ?? resolveHostAddresses;
  const now = deps.now ?? Date.now;
  return {
    meta: {
      id: "security/supabase-rls",
      name: "Supabase Row Level Security",
      description:
        "Finds the Supabase project and public anon key the site ships, then sends one HEAD request with a row count to each table its own code queries, using that key. A table that reports rows to the anon key is readable by anyone: Row Level Security is off or a policy allows it. No row is read. A loud probe: runs only with --probe aggressive.",
      solution:
        'Turn on Row Level Security for every table in the exposed schema: `alter table public.<table> enable row level security;`, then add policies that grant only what each role needs, for example `create policy "own rows" on public.profiles for select using (auth.uid() = id);`. With RLS on and no policy, the anon key reads nothing. If a table is meant to be public, keep a policy that allows only the rows and columns you mean to publish. Check the Supabase dashboard\'s Security Advisor for other tables without RLS, and treat the exposed rows as already read: rotate anything sensitive they held.',
      category: "security",
      scope: "site",
      findingScope: "page",
      severity: "error",
      weight: 8,
      messageCountsItems: true,
      checks: [
        { name: CHECK, outcome: "problem" },
        { name: CHECK, outcome: "clean", clears: [CHECK] },
        { name: CHECK, outcome: "skipped" },
      ],
    },

    async run(ctx: RuleContext): Promise<RuleResult> {
      const checks: CheckResult[] = [];
      const discovery = discoverSupabase(sourcesOf(ctx), Math.floor(now() / 1000));
      const discovered = {
        projects: discovery.projects.map((p) => p.host),
        projectsSkipped: discovery.projectsSkipped,
        codeTables: discovery.tables.length,
        privilegedKeysIgnored: discovery.privilegedKeysIgnored,
      };

      if (discovery.projects.length === 0) {
        checks.push({
          name: CHECK,
          status: "skipped",
          skipReason: "not-applicable",
          message: "No Supabase project with a public anon key was found in the site's scripts",
          details: discovered,
        });
        return { checks };
      }

      const hosts = discovery.projects.map((p) => p.host).join(", ");
      if (!ctx.probe || ctx.probe.level !== "aggressive") {
        const passive = !ctx.probe || ctx.probe.level === "passive";
        checks.push({
          name: CHECK,
          status: "skipped",
          skipReason: passive ? "probing-passive" : "probing-not-aggressive",
          message: `The site uses Supabase (${hosts}), but its tables were not probed: this is a loud probe of another host. Run with --probe aggressive on a site you own to check Row Level Security.`,
          details: discovered,
        });
        return { checks };
      }

      // The engine leaves `externalLinks` undefined only when external link
      // checking is off for the run (`--offline`, a targeted run,
      // `[external_links] enabled = false`); checking on with no external links
      // is `[]`. The rule context has no other "may request other hosts" signal,
      // so the rule is in LINK_VERDICT_RULE_IDS and runs after the link check
      // binds this field (repo#2144).
      if (ctx.site?.externalLinks === undefined) {
        checks.push({
          name: CHECK,
          status: "skipped",
          skipReason: "external-requests-off",
          message: `The site uses Supabase (${hosts}), but this audit does not request other hosts (--offline, or external link checking is off), so its tables were not probed`,
          details: discovered,
        });
        return { checks };
      }

      const targets = tableTargets(discovery.tables);
      if (targets.length === 0) {
        checks.push({
          name: CHECK,
          status: "skipped",
          skipReason: "no-tables-in-code",
          message: `The site uses Supabase (${hosts}), but its scripts name no table, so nothing was probed. Table names are never guessed`,
          details: discovered,
        });
        return { checks };
      }

      const budget = ctx.probe;
      const resolve = memoizeResolveHost(resolveHost);
      const egress: EgressPolicy = {
        allowPrivateNetwork: false,
        allowHost: (host) => /^[a-z0-9]{20}\.supabase\.(?:co|in)$/.test(host),
        resolve,
      };

      const results: ProjectResult[] = [];
      let sentTotal = 0;
      let budgetStopped = false;
      let capped = 0;
      let throttled = false;
      outer: for (const project of discovery.projects) {
        const result: ProjectResult = {
          project,
          exposed: [],
          probed: 0,
          protectedCount: 0,
          empty: 0,
          missing: 0,
          notChecked: 0,
          errored: 0,
          throttled: 0,
        };
        results.push(result);
        for (const [i, target] of targets.entries()) {
          if (sentTotal >= MAX_TABLE_PROBES) {
            capped += targets.length - i;
            continue outer;
          }
          const verdict = await probeTable(budget, project, target, egress);
          if (verdict.kind === "not-sent") {
            budgetStopped = true;
            break outer;
          }
          sentTotal++;
          result.probed++;
          if (verdict.kind === "exposed") result.exposed.push({ table: target, rows: verdict.rows });
          else if (verdict.kind === "protected") result.protectedCount++;
          else if (verdict.kind === "empty") result.empty++;
          else if (verdict.kind === "missing") result.missing++;
          else if (verdict.kind === "other") result.notChecked++;
          else if (verdict.kind === "throttled") {
            // The project pushed back: no further request this run, and
            // every table not yet answered stays unchecked.
            result.throttled++;
            throttled = true;
            break outer;
          } else result.errored++;
        }
      }
      // Tables the run never reached: past the per-project or per-run cap,
      // after a stop, or in a project past MAX_PROJECTS. None of them got an
      // answer. discovery.tables is deduped, so it is every table the code names.
      const planned = (discovery.projects.length + discovery.projectsSkipped) * discovery.tables.length;
      const unanswered = planned - sentTotal;
      // Left out by a cap in the projects that were probed: past the per-run
      // cap, plus the tables past MAX_TABLES_PER_PROJECT in each project.
      // Projects past MAX_PROJECTS are reported as projectsSkipped.
      const perProjectDropped = discovery.tables.length - targets.length;
      capped += discovery.projects.length * perProjectDropped;

      const summary = {
        ...discovered,
        tablesProbed: sentTotal,
        tablesCapped: capped,
        budgetStopped,
        throttled,
        perProject: results.map((r) => ({
          host: r.project.host,
          probed: r.probed,
          exposed: r.exposed.length,
          protected: r.protectedCount,
          emptyOrHidden: r.empty,
          missing: r.missing,
          notChecked: r.notChecked,
          errored: r.errored,
          throttled: r.throttled,
        })),
      };

      for (const r of results) {
        if (r.exposed.length === 0) continue;
        const { host, keyKind } = r.project;
        const keySource = sanitizeKeySource(r.project.keySource);
        // The label is the bare table name, so `[[ignore]] items = ["posts"]`
        // waives that table in every project (#2103); the row count is the
        // snippet. The message names no table and starts with the count
        // (`messageCountsItems`), so after a waiver it neither names a waived
        // table nor counts one: the items list the tables.
        const items: CheckItem[] = r.exposed.map(({ table, rows }) => ({
          id: `${host}/rest/v1/${table}`,
          label: table,
          snippet: `${rows} row(s) visible to the anon key`,
          meta: { project: host, table, rows, keyKind, keySource },
        }));
        checks.push({
          name: CHECK,
          status: "fail",
          message: `${r.exposed.length} Supabase table(s) in ${host} report rows to the site's public anon key. Row Level Security is off, or a policy lets anyone read them (counted with a HEAD request, no row read)`,
          items,
          details: {
            project: host,
            exposedTables: r.exposed.map((e) => e.table),
            ...summary,
          },
        });
      }
      if (checks.length > 0) return { checks };

      const budgetSize =
        budget.budgetMs % 1000 === 0 ? `${budget.budgetMs / 1000} s` : `${budget.budgetMs} ms`;
      const budgetCap = `the shared probe time budget of ${budgetSize} for all probing rules ran out`;
      if (sentTotal === 0) {
        checks.push({
          name: CHECK,
          status: "skipped",
          skipReason: "probe-budget",
          message: `No Supabase table was probed: ${budgetCap} first (0 of ${planned} table probe(s) sent)`,
          details: summary,
        });
        return { checks };
      }
      const errored = results.reduce((n, r) => n + r.errored, 0);
      const notChecked = results.reduce((n, r) => n + r.notChecked, 0);
      if (errored === sentTotal && !throttled) {
        checks.push({
          name: CHECK,
          status: "skipped",
          skipReason: "probe-errors",
          message: `Every Supabase table probe failed with a network error, timeout or refusal (${sentTotal} request(s)), so Row Level Security was not checked`,
          details: summary,
        });
        return { checks };
      }
      if (errored + notChecked === sentTotal && !throttled && unanswered === 0) {
        checks.push({
          name: CHECK,
          status: "skipped",
          skipReason: "probe-inconclusive",
          message: `No Supabase table probe answered with a status and row count squirrel can judge (${sentTotal} request(s)), so Row Level Security was not checked`,
          details: summary,
        });
        return { checks };
      }
      if (budgetStopped && !throttled && errored + notChecked === 0) {
        checks.push({
          name: CHECK,
          status: "skipped",
          skipReason: "probe-budget",
          message: `Supabase Row Level Security check stopped: ${budgetCap} after ${sentTotal} of ${planned} table probe(s). None of those reported rows, but the rest were not checked`,
          details: summary,
        });
        return { checks };
      }
      // A pass clears the rule, so it needs a definite answer (a non-HTML 401,
      // plain 403 or 404, or a zero total) from every table the site's code
      // names, in every project. Pushback, an error, an HTML error page, an
      // answer without a usable total, or a table never reached leaves the run
      // not checked (#1883 review).
      const unverified = unanswered + errored + notChecked + (throttled ? 1 : 0);
      if (unverified > 0) {
        const why: string[] = [];
        if (throttled)
          why.push(
            "the Supabase project throttled the probes (HTTP 429) or answered with a bot challenge, so no further request was sent",
          );
        if (budgetStopped) why.push(budgetCap);
        if (errored > 0) why.push(`${errored} probe(s) failed with a network error or timeout`);
        if (notChecked > 0)
          why.push(`${notChecked} answer(s) had no status and row count squirrel can judge`);
        if (capped + discovery.projectsSkipped * targets.length > 0 || discovery.tables.length > targets.length)
          why.push(
            `the per-audit cap of ${MAX_TABLE_PROBES} table probes, ${MAX_TABLES_PER_PROJECT} tables per project and ${MAX_PROJECTS} projects was reached`,
          );
        checks.push({
          name: CHECK,
          status: "skipped",
          skipReason: PROBE_INCOMPLETE_SKIP_REASON,
          value: "not-checked",
          message: `Supabase Row Level Security check incomplete: ${why.join("; ")}. ${unverified} of ${planned} table probe(s) got no definite answer, and those tables may be readable with the anon key`,
          details: { ...summary, unverified },
        });
        return { checks };
      }
      checks.push({
        name: CHECK,
        status: "pass",
        message: `No Supabase table reported rows to the public anon key (${sentTotal} table(s) probed in ${results.length} project(s))`,
        details: summary,
      });
      return { checks };
    },
  };
}

export const supabaseRlsRule: Rule = createSupabaseRlsRule();
