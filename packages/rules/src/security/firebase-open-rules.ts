// security/firebase-open-rules - Firebase Realtime Database and Firestore readable without sign-in (#2325)
//
// A Firebase web app ships its client config (database URL, project id) to every
// visitor. That is by design: security rules decide what an unauthenticated
// caller may read. A database or collection whose rules are open answers a plain
// REST read to anyone who can see the config, which is anyone who opened the site.
//
// A probing rule, and a loud one, on the model of security/supabase-rls: it
// requests hosts that are not the audited origin, so it runs only on an
// aggressive run (`--probe aggressive`), only when the audit may request other
// hosts (not `--offline`, external link checking on), and inside the shared
// probe budget. A hosted audit of an unverified website is locked passive.
//
// Finding the targets sends nothing: they are read from the scripts and inline
// scripts the crawl already fetched.
//  - Realtime Database: a `databaseURL` in a Firebase config. The host is built
//    from the name and region parsed out of it, and is only ever
//    `<name>.firebaseio.com` or `<name>.<region>.firebasedatabase.app`.
//  - Firestore: a `projectId` in a script that also holds a Firebase web API key
//    (`AIza...`). The host is always `firestore.googleapis.com`. Collections are
//    only the names the site's own code queries; no name is guessed.
//
// What is sent, and what is read. No key, cookie or custom header is sent, so
// the answer is exactly what any anonymous visitor gets. Realtime Database:
// `GET /.json?shallow=true`, which returns top-level key names only, never
// values; the body is read up to MAX_BODY_BYTES. Firestore: `GET .../documents/
// <collection>?pageSize=1&mask.fieldPaths=__name__`; the mask drops every field,
// so a document comes back as its name alone, and only whether the list is
// empty is used. Nothing is stored or reported but the database or project, the
// collection or top-level path names (bounded, and any name that could be an id
// is redacted to a count), and the verdict. No redirect is followed, and the
// egress guard refuses a host that resolves to a private or metadata address.

import { PROBE_INCOMPLETE_SKIP_REASON } from "@squirrelscan/core-contracts";
import { SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import {
  egressGuardedSend,
  memoizeResolveHost,
  resolveHostAddresses,
  type EgressPolicy,
  type ResolveHost,
} from "@squirrelscan/utils/public-egress";
import { fetchUndecoded } from "@squirrelscan/utils/response-body";

import type { ProbeBudget } from "../probe-budget";
import type {
  CheckItem,
  CheckResult,
  Rule,
  RuleContext,
  RuleResult,
} from "../types";

import { isThrottledOrChallenged, readCappedBytes } from "./probe-http";

const CHECK = "firebase-open-rules";

/** Realtime Databases probed per run. */
export const MAX_DATABASES = 2;
/** Firestore projects probed per run. */
export const MAX_FIRESTORE_PROJECTS = 2;
/** Collections probed per Firestore project. */
export const MAX_COLLECTIONS_PER_PROJECT = 10;
/** Requests per run, across every target. */
export const MAX_PROBES = 25;
/** Per-request timeout, on top of the shared probe budget's deadline. */
export const PROBE_TIMEOUT_MS = 10_000;
/** Decoded response bytes read from one answer. */
export const MAX_BODY_BYTES = 16 * 1024;
/** Top-level path names listed in one finding. */
export const MAX_PATHS_REPORTED = 10;
/** Longest path name reported; a longer one is counted, not named. */
export const MAX_PATH_NAME_CHARS = 24;
/** Characters of one script scanned. */
const MAX_SCAN_CHARS = 4 * 1024 * 1024;

// `databaseURL: "https://my-app-default-rtdb.europe-west1.firebasedatabase.app"`
// or `"databaseURL":"https://my-app.firebaseio.com"`.
const DATABASE_URL_RE =
  /databaseURL["']?\s{0,8}[:=]\s{0,8}["'`]https:\/\/([a-z0-9][a-z0-9-]{0,62})(?:\.([a-z0-9-]{1,30}))?\.(firebaseio\.com|firebasedatabase\.app)(?![a-z0-9.-])/g;
const PROJECT_ID_RE =
  /projectId["']?\s{0,8}[:=]\s{0,8}["'`]([a-z][a-z0-9-]{4,28}[a-z0-9])["'`]/g;
const API_KEY_RE = /\bAIza[0-9A-Za-z_-]{35}\b/;
// Modular `collection(db, "users")` and namespaced `.collection("users")`. A
// nested path (`users/1/posts`) is not matched: only a flat collection name.
const COLLECTION_RE =
  /\bcollection\(\s{0,8}(?:[A-Za-z_$][\w$]{0,40}\s{0,8},\s{0,8})?(["'`])([A-Za-z][A-Za-z0-9_-]{0,62})\1\s{0,8}[,)]/g;
const COLLECTION_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const RTDB_HOST_RE =
  /^[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9-]{1,30})?\.(?:firebaseio\.com|firebasedatabase\.app)$/;
const FIRESTORE_HOST = "firestore.googleapis.com";
const PROJECT_ID_VALID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
// A top-level key of `?shallow=true`: `"users":true`.
const SHALLOW_KEY_RE = /"((?:[^"\\]|\\.){1,128})"\s{0,4}:\s{0,4}true/g;
// Reported path names: identifier-like and short. Longer or odd names (user ids,
// emails, push ids) are counted and never named.
const SAFE_PATH_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export interface FirebaseDatabase {
  /** `<name>.firebaseio.com` or `<name>.<region>.firebasedatabase.app`. */
  host: string;
  source: string;
}

export interface FirebaseDiscovery {
  databases: FirebaseDatabase[];
  databasesSkipped: number;
  projects: Array<{ projectId: string; source: string }>;
  projectsSkipped: number;
  /** Collection names the code queries, deduped, in code-unit order. */
  collections: string[];
}

/** Code-unit order: the same on every machine and locale (#2104). */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The Firebase targets and queried collections in the given sources. Pure: sends nothing. */
export function discoverFirebase(
  sources: ReadonlyArray<{ url: string; content: string }>
): FirebaseDiscovery {
  const databases = new Map<string, FirebaseDatabase>();
  const projects = new Map<string, { projectId: string; source: string }>();
  const collections = new Set<string>();
  const ordered = [...sources].sort((a, b) => compareNames(a.url, b.url));
  for (const source of ordered) {
    const text =
      source.content.length > MAX_SCAN_CHARS
        ? source.content.slice(0, MAX_SCAN_CHARS)
        : source.content;
    for (const m of text.matchAll(DATABASE_URL_RE)) {
      const host = m[2] ? `${m[1]}.${m[2]}.${m[3]}` : `${m[1]}.${m[3]}`;
      if (RTDB_HOST_RE.test(host) && !databases.has(host))
        databases.set(host, { host, source: source.url });
    }
    if (API_KEY_RE.test(text)) {
      for (const m of text.matchAll(PROJECT_ID_RE)) {
        const projectId = m[1]!;
        if (!projects.has(projectId))
          projects.set(projectId, { projectId, source: source.url });
      }
    }
    for (const m of text.matchAll(COLLECTION_RE)) {
      if (COLLECTION_NAME_RE.test(m[2]!)) collections.add(m[2]!);
    }
  }
  const dbs = [...databases.values()].sort((a, b) =>
    compareNames(a.host, b.host)
  );
  const prs = [...projects.values()].sort((a, b) =>
    compareNames(a.projectId, b.projectId)
  );
  return {
    databases: dbs.slice(0, MAX_DATABASES),
    databasesSkipped: Math.max(0, dbs.length - MAX_DATABASES),
    projects: prs.slice(0, MAX_FIRESTORE_PROJECTS),
    projectsSkipped: Math.max(0, prs.length - MAX_FIRESTORE_PROJECTS),
    collections: [...collections].sort(compareNames),
  };
}

type Target =
  | { kind: "rtdb"; host: string }
  | { kind: "firestore"; projectId: string; collection: string };

/** The exact URL and init of one probe. Exported so tests can pin what is sent. */
export function buildProbe(target: Target): { url: string; init: RequestInit } {
  const headers = { "User-Agent": SQUIRRELSCAN_USER_AGENT };
  const init: RequestInit = {
    method: "GET",
    credentials: "omit",
    redirect: "manual",
    headers,
  };
  if (target.kind === "rtdb") {
    if (!RTDB_HOST_RE.test(target.host))
      throw new Error("refused: not a Firebase database host");
    return { url: `https://${target.host}/.json?shallow=true`, init };
  }
  if (
    !PROJECT_ID_VALID_RE.test(target.projectId) ||
    !COLLECTION_NAME_RE.test(target.collection)
  )
    throw new Error("refused: not a project id or collection");
  return {
    url: `https://${FIRESTORE_HOST}/v1/projects/${target.projectId}/databases/(default)/documents/${target.collection}?pageSize=1&mask.fieldPaths=__name__`,
    init,
  };
}

export type ProbeVerdict =
  | { kind: "exposed"; paths: string[]; redacted: number }
  | { kind: "throttled"; status: number }
  | { kind: "protected"; status: number }
  | { kind: "empty"; status: number }
  | { kind: "missing"; status: number }
  | { kind: "other"; status: number }
  | { kind: "errored" }
  | { kind: "not-sent" };

function isHtml(headers: Headers | null): boolean {
  const type = headers?.get("content-type");
  return !!type && type.split(";")[0]!.trim().toLowerCase() === "text/html";
}

/** Split top-level key names into the ones safe to name and a count of the rest. */
export function redactPaths(keys: readonly string[]): {
  paths: string[];
  redacted: number;
} {
  const paths: string[] = [];
  let redacted = 0;
  for (const key of [...new Set(keys)].sort(compareNames)) {
    if (
      key.length <= MAX_PATH_NAME_CHARS &&
      SAFE_PATH_RE.test(key) &&
      paths.length < MAX_PATHS_REPORTED
    )
      paths.push(key);
    else redacted++;
  }
  return { paths, redacted };
}

/**
 * Judge one answer. `body` is the decoded prefix, at most MAX_BODY_BYTES. A
 * Realtime Database answer is exposed when it is a JSON object of top-level
 * keys; Firestore when it lists at least one document.
 */
export function classifyResponse(
  kind: Target["kind"],
  status: number,
  headers: Headers | null,
  body: string
): ProbeVerdict {
  if (isThrottledOrChallenged({ status, headers, text: body }))
    return { kind: "throttled", status };
  if ((status === 401 || status === 403 || status === 404) && isHtml(headers))
    return { kind: "other", status };
  if (status === 401 || status === 403) return { kind: "protected", status };
  if (status === 404) return { kind: "missing", status };
  if (status < 200 || status >= 300) return { kind: "other", status };
  const text = body.trim();
  if (kind === "rtdb") {
    if (text === "null") return { kind: "empty", status };
    if (!text.startsWith("{")) return { kind: "other", status };
    if (text === "{}") return { kind: "empty", status };
    const keys: string[] = [];
    for (const m of text.matchAll(SHALLOW_KEY_RE)) {
      keys.push(m[1]!);
      if (keys.length >= 500) break;
    }
    if (keys.length === 0) return { kind: "other", status };
    return { kind: "exposed", ...redactPaths(keys) };
  }
  // Firestore: `{}` when empty, `{"documents":[{"name":"..."}]}` otherwise.
  if (text === "{}") return { kind: "empty", status };
  if (/^\{\s{0,8}"documents"\s{0,4}:\s{0,4}\[\s{0,8}\{/.test(text))
    return { kind: "exposed", paths: [], redacted: 0 };
  return { kind: "other", status };
}

async function probe(
  budget: ProbeBudget,
  target: Target,
  egress: EgressPolicy
): Promise<ProbeVerdict> {
  if (!budget.allows("loud")) return { kind: "not-sent" };
  const { url, init } = buildProbe(target);
  const done = new AbortController();
  const signal = AbortSignal.any([
    budget.signal(),
    AbortSignal.timeout(PROBE_TIMEOUT_MS),
    done.signal,
  ]);
  budget.record();
  try {
    // Undecoded, so the runtime never inflates a compressed body past the cap
    // (#2717): readCappedBytes decodes it and stops at MAX_BODY_BYTES.
    const res = await egressGuardedSend(fetchUndecoded, egress)(url, {
      ...init,
      signal,
    });
    const { bytes } = await readCappedBytes(res, MAX_BODY_BYTES);
    return classifyResponse(
      target.kind,
      res.status,
      res.headers,
      new TextDecoder().decode(bytes)
    );
  } catch {
    return { kind: "errored" };
  } finally {
    done.abort();
  }
}

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
    if (inline.length > 0)
      out.push({ url: page.url, content: inline.join("\n") });
  }
  return out;
}

export interface FirebaseOpenRulesDeps {
  resolve?: ResolveHost;
}

/** The rule, with DNS injectable for tests; {@link firebaseOpenRulesRule} uses the system one. */
export function createFirebaseOpenRulesRule(
  deps: FirebaseOpenRulesDeps = {}
): Rule {
  const resolveHost = deps.resolve ?? resolveHostAddresses;
  return {
    meta: {
      id: "security/firebase-open-rules",
      name: "Firebase open security rules",
      description:
        "Finds the Firebase Realtime Database URL and Firestore project the site's scripts ship, then makes one unauthenticated REST read to each database and to each collection its own code queries. A database or collection that answers data to a caller with no sign-in has open security rules. Only key and collection names are read, never values. A loud probe: runs only with --probe aggressive.",
      solution:
        'Lock the rules. Realtime Database: replace `".read": true` with a condition such as `"auth != null"` and scope it per path, for example `"users": { "$uid": { ".read": "auth.uid === $uid" } }`. Firestore: replace `allow read: if true;` with `allow read: if request.auth != null;` and scope it per document, for example `match /users/{uid} { allow read: if request.auth.uid == uid; }`. Publish the rules, then treat anything the open rules exposed as already read and rotate anything sensitive it held.',
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
      const discovery = discoverFirebase(sourcesOf(ctx));
      const firestoreTargets =
        discovery.collections.length > 0 ? discovery.projects : [];
      const collections = discovery.collections.slice(
        0,
        MAX_COLLECTIONS_PER_PROJECT
      );
      const names = [
        ...discovery.databases.map((d) => d.host),
        ...discovery.projects.map((p) => `Firestore project ${p.projectId}`),
      ];
      const discovered = {
        databases: discovery.databases.map((d) => d.host),
        databasesSkipped: discovery.databasesSkipped,
        projects: discovery.projects.map((p) => p.projectId),
        projectsSkipped: discovery.projectsSkipped,
        codeCollections: discovery.collections.length,
      };

      if (names.length === 0) {
        checks.push({
          name: CHECK,
          status: "skipped",
          skipReason: "not-applicable",
          message:
            "No Firebase Realtime Database URL or Firestore project was found in the site's scripts",
          details: discovered,
        });
        return { checks };
      }
      const list = names.join(", ");
      if (!ctx.probe || ctx.probe.level !== "aggressive") {
        const passive = !ctx.probe || ctx.probe.level === "passive";
        checks.push({
          name: CHECK,
          status: "skipped",
          skipReason: passive ? "probing-passive" : "probing-not-aggressive",
          message: `The site uses Firebase (${list}), but its security rules were not probed: this is a loud probe of another host. Run with --probe aggressive on a site you own to check them.`,
          details: discovered,
        });
        return { checks };
      }
      if (ctx.site?.mayRequestOtherHosts !== true) {
        checks.push({
          name: CHECK,
          status: "skipped",
          skipReason: "external-requests-off",
          message: `The site uses Firebase (${list}), but this audit does not request other hosts (--offline, or external link checking is off), so its security rules were not probed`,
          details: discovered,
        });
        return { checks };
      }

      const targets: Target[] = [
        ...discovery.databases.map(
          (d): Target => ({
            kind: "rtdb",
            host: d.host,
          })
        ),
        ...firestoreTargets.flatMap((p) =>
          collections.map(
            (collection): Target => ({
              kind: "firestore",
              projectId: p.projectId,
              collection,
            })
          )
        ),
      ];
      if (targets.length === 0) {
        checks.push({
          name: CHECK,
          status: "skipped",
          skipReason: "no-tables-in-code",
          message: `The site uses Firebase (${list}), but has no Realtime Database URL and its scripts name no Firestore collection, so nothing was probed. Collection names are never guessed`,
          details: discovered,
        });
        return { checks };
      }

      const budget = ctx.probe;
      const egress: EgressPolicy = {
        allowPrivateNetwork: false,
        allowHost: (host) => host === FIRESTORE_HOST || RTDB_HOST_RE.test(host),
        resolve: memoizeResolveHost(resolveHost),
      };

      const exposed: Array<{
        target: Target;
        paths: string[];
        redacted: number;
      }> = [];
      let sent = 0;
      let definite = 0;
      let errored = 0;
      let notChecked = 0;
      let throttled = false;
      let budgetStopped = false;
      for (const target of targets) {
        if (sent >= MAX_PROBES) break;
        const verdict = await probe(budget, target, egress);
        if (verdict.kind === "not-sent") {
          budgetStopped = true;
          break;
        }
        sent++;
        if (verdict.kind === "exposed") {
          definite++;
          exposed.push({
            target,
            paths: verdict.paths,
            redacted: verdict.redacted,
          });
        } else if (
          verdict.kind === "protected" ||
          verdict.kind === "empty" ||
          verdict.kind === "missing"
        )
          definite++;
        else if (verdict.kind === "other") notChecked++;
        else if (verdict.kind === "throttled") {
          throttled = true;
          break;
        } else errored++;
      }

      const planned = targets.length;
      const unchecked = planned - definite;
      // Targets dropped by a per-run cap or a discovery cap are not checked.
      const capped =
        discovery.databasesSkipped > 0 ||
        discovery.projectsSkipped > 0 ||
        discovery.collections.length > collections.length;
      const summary = {
        ...discovered,
        probesPlanned: planned,
        probesSent: sent,
        probesChecked: definite,
        probesUnchecked: unchecked,
        budgetStopped,
        throttled,
        capped,
      };
      const why: string[] = [];
      if (throttled)
        why.push(
          "a host throttled the probes (HTTP 429) or answered with a bot challenge, so no further request was sent"
        );
      if (budgetStopped)
        why.push("the shared probe time budget for all probing rules ran out");
      if (errored > 0)
        why.push(`${errored} probe(s) failed with a network error or timeout`);
      if (notChecked > 0)
        why.push(`${notChecked} answer(s) squirrel could not judge`);
      if (capped)
        why.push(
          `the caps of ${MAX_DATABASES} databases, ${MAX_FIRESTORE_PROJECTS} Firestore projects and ${MAX_COLLECTIONS_PER_PROJECT} collections per project were reached`
        );
      const counts = `${definite} of ${planned} probe(s) got a definite answer`;
      const incomplete =
        unchecked > 0 || capped
          ? `. The list may be incomplete: ${counts}${why.length > 0 ? ` (${why.join("; ")})` : ""}`
          : "";

      if (exposed.length > 0) {
        const items: CheckItem[] = [];
        for (const e of exposed) {
          if (e.target.kind === "rtdb") {
            const host = e.target.host;
            const named = e.paths.map((p) => ({
              id: `${host}/${p}`,
              label: `/${p}`,
              snippet: "top-level path readable without sign-in",
              meta: { database: host, path: p },
            }));
            items.push(...named);
            if (named.length === 0 || e.redacted > 0)
              items.push({
                id: `${host}/`,
                label: "/",
                snippet:
                  e.redacted > 0
                    ? `${e.redacted} more top-level path(s) not named`
                    : "database root readable without sign-in",
                meta: { database: host, redactedPaths: e.redacted },
              });
          } else {
            const { projectId, collection } = e.target;
            items.push({
              id: `firestore/${projectId}/${collection}`,
              label: collection,
              snippet: "collection lists documents without sign-in",
              meta: { project: projectId, collection },
            });
          }
        }
        checks.push({
          name: CHECK,
          status: "fail",
          // Starts with the item count (`messageCountsItems`), so an
          // `[[ignore]]` that waives some items rewrites it to what remains.
          message: `${items.length} Firebase database path(s) or collection(s) answer a read with no sign-in. The security rules are open (key and collection names read only, no value)${incomplete}`,
          items,
          details: {
            exposed: exposed.map((e) =>
              e.target.kind === "rtdb"
                ? { database: e.target.host }
                : {
                    project: e.target.projectId,
                    collection: e.target.collection,
                  }
            ),
            ...summary,
          },
        });
        return { checks };
      }

      if (sent === 0) {
        checks.push({
          name: CHECK,
          status: "skipped",
          skipReason: "probe-budget",
          message: `No Firebase probe was sent: the shared probe time budget ran out first (0 of ${planned} probe(s) sent)`,
          details: summary,
        });
        return { checks };
      }
      if (unchecked > 0 || capped) {
        checks.push({
          name: CHECK,
          status: "skipped",
          skipReason: PROBE_INCOMPLETE_SKIP_REASON,
          value: "not-checked",
          message: `Firebase security rules check incomplete: ${why.join("; ")}. ${counts}, and the unchecked targets may be readable`,
          details: summary,
        });
        return { checks };
      }
      checks.push({
        name: CHECK,
        status: "pass",
        message: `No Firebase database or collection answered a read with no sign-in (${sent} probe(s))`,
        details: summary,
      });
      return { checks };
    },
  };
}

export const firebaseOpenRulesRule: Rule = createFirebaseOpenRulesRule();
