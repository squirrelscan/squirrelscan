// Template-invariance probe (#1950) — which page rules give the SAME verdict for
// every member of a template cluster, measured on a finished `project.db`. No
// network, and no write to the crawl it reads.
//
//   bun run scripts/template-rule-invariance.ts --db ~/.squirrel/projects/rl-e2e/project.db
//   bun run scripts/template-rule-invariance.ts --db <path> --check   # gate the declarations
//
// `--check` is the assertion #1950 asks for: every rule whose `meta.verdictScope`
// is "template" must be constant in every multi-page cluster of this corpus. Any
// rule that is not is printed with the cluster and the two members that disagree,
// and the script exits 2. The declarations are a claim about a rule's INPUTS; this
// is the falsifier, run against a real crawl.
//
// The reverse direction is reported but NOT gated: a rule measured constant here
// may still be page-scoped (this corpus simply never exercised the difference), and
// several are constant only because an offline probe cannot supply the per-page
// site data they read (see SITE-DATA CAVEAT below).
//
// SITE-DATA CAVEAT. `SiteData` is site-scoped, so a rule reading it cannot vary
// WITHIN a run — except where it looks its own page up in a per-page-keyed list
// (`resourceSizes`, `scripts`, `externalLinks`, `sitemapUrlStatuses`,
// `cloakingProbes`). Those lists come from network fetches this probe deliberately
// does not do, so they arrive empty and such rules read as constant here whatever
// they would do live. Every rule reading one of them is classified "page" by hand
// regardless of what this prints.
//
// Measured for #1026, and what --check reproduces:
//
//   corpus                  pages  multi-page clusters  rules constant / total
//   gymshark.com              247                    8             89 / 198
//   openelectricity.org.au    100                    3            142 / 198
//
// (#1026 reported 101 and 150 comparing only name/status/message. This compares the
// WHOLE check via `templateVerdictKey`, including items and details, so it is
// strictly stricter and the constant sets are smaller. 85 rules are constant on
// both; 26 are declared "template" — see VerdictScope for why the rest are not.)
//
// Do NOT run this against the synthetic bench corpora to size anything: they are
// generated from 1-6 templates, so every page is a cluster member and every
// clustering question comes out flattering and wrong.

import { SQLiteStorage } from "@squirrelscan/crawler";
import {
  buildSiteContext,
  isAuditablePage,
  isRenderedFetch,
  templateFingerprintKey,
  templateVerdictKey,
} from "@squirrelscan/audit-engine";
import { buildHeadersMap } from "@squirrelscan/audit-engine/adapter";
import { createRunner, fingerprintPage, loadAllRules } from "@squirrelscan/rules";
import type { PageData, SiteData } from "@squirrelscan/rules";
import { isRateLimitStatus } from "@squirrelscan/utils/rate-limit";
import { Effect } from "effect";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getGlobalContentStore } from "@/crawler/storage/content-store";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const DB = arg("db", "");
if (!DB) {
  console.error("usage: bun run scripts/template-rule-invariance.ts --db <project.db> [--crawl <id>] [--check]");
  process.exit(1);
}
// Validated as TEXT before conversion: `parseInt` turns "1.5" into 1, "25garbage"
// into 25 and "1e3" into 1, all of which pass an is-integer check afterwards. A
// non-positive or NaN batch would make storage omit its LIMIT and never advance
// the offset, i.e. read the whole crawl forever.
const BATCH_ARG = arg("batch", "25");
if (!/^[1-9][0-9]{0,6}$/.test(BATCH_ARG)) {
  console.error(`--batch must be a positive integer, got ${JSON.stringify(BATCH_ARG)}`);
  process.exit(1);
}
const BATCH = Number.parseInt(BATCH_ARG, 10);

// `SQLiteStorage.init()` opens the file WRITABLE, switches it to WAL and runs
// migrations, so pointing it straight at a corpus would silently upgrade someone's
// crawl (and a mistyped path would create an empty database instead of failing).
// Probe a disposable copy instead, and take the -wal/-shm sidecars with it so the
// copy is not missing committed pages.
if (!existsSync(DB)) {
  console.error(`no such database: ${DB}`);
  process.exit(1);
}
const scratch = mkdtempSync(join(tmpdir(), "squirrel-invariance-"));
const dbCopy = join(scratch, "probe.db");
copyFileSync(DB, dbCopy);
for (const suffix of ["-wal", "-shm"]) {
  if (existsSync(DB + suffix)) copyFileSync(DB + suffix, dbCopy + suffix);
}

const storage = new SQLiteStorage(dbCopy, getGlobalContentStore());
await run(storage.init());

const crawlArg = arg("crawl", "");
const crawls = (await run(storage.listCrawls(50))) as Array<{ id: string; baseUrl?: string }>;
const crawl = crawlArg ? crawls.find((c) => c.id === crawlArg) : crawls[0];
if (!crawl) {
  console.error("no crawls in this db");
  process.exit(1);
}

const CONFIG = { rule_options: {}, rules: { enable: ["*"] } } as unknown as Parameters<typeof createRunner>[0];
const runner = createRunner(CONFIG);
const siteData: SiteData = {
  baseUrl: crawl.baseUrl ?? "",
  pages: [],
  robotsTxt: null,
  sitemaps: null,
};

const clusterOf = new Map<string, string>(); // url -> cluster key
const verdicts = new Map<string, Map<string, string>>(); // ruleId -> url -> verdict
let scored = 0;

for (let offset = 0; ; offset += BATCH) {
  const batch = await run(storage.getPages(crawl.id, { limit: BATCH, offset }));
  if (batch.length === 0) break;
  const ctx = await run(buildSiteContext(batch));

  for (const { page, parsed } of ctx) {
    if (!parsed) continue;
    if (isRateLimitStatus(page.status) || !isAuditablePage(page)) {
      parsed.document = null;
      continue;
    }
    const key = templateFingerprintKey(fingerprintPage(parsed, page.normalizedUrl));
    if (key == null) {
      parsed.document = null;
      continue;
    }
    clusterOf.set(page.normalizedUrl, key);

    const pageData: PageData = {
      url: page.url,
      html: page.html!,
      statusCode: page.status,
      loadTime: page.loadTimeMs,
      ttfb: page.ttfb,
      downloadTime: page.downloadTime,
      headers: buildHeadersMap(page),
      parsed,
      finalUrl: page.finalUrl,
      redirectChain: page.redirectChain,
      rendered: isRenderedFetch(page.fetcherId),
    };
    const result = await runner.runPageRules(pageData, siteData);
    for (const [ruleId, rr] of result.ruleResults) {
      let byUrl = verdicts.get(ruleId);
      if (!byUrl) verdicts.set(ruleId, (byUrl = new Map()));
      byUrl.set(page.normalizedUrl, templateVerdictKey(rr.checks as unknown as Array<Record<string, unknown>>, page.normalizedUrl));
    }

    scored++;
    parsed.document = null;
  }
  process.stderr.write(`\r  ${scored} pages scored`);
}
process.stderr.write("\n");

// Multi-page clusters only. A cluster of one is not a cluster: it can never
// disagree with itself, so counting it would inflate every rule to "constant".
const members = new Map<string, string[]>();
for (const [url, key] of clusterOf) {
  const list = members.get(key);
  if (list) list.push(url);
  else members.set(key, [url]);
}
const multi = [...members.entries()].filter(([, urls]) => urls.length > 1).sort((a, b) => b[1].length - a[1].length);

type Divergence = { cluster: string; a: string; b: string };
const firstDivergence = new Map<string, Divergence>();
const constant: string[] = [];
const varying: string[] = [];

for (const [ruleId, byUrl] of [...verdicts.entries()].sort()) {
  let diverged: Divergence | null = null;
  for (const [key, urls] of multi) {
    const present = urls.filter((u) => byUrl.has(u));
    if (present.length < 2) continue;
    const base = byUrl.get(present[0]!)!;
    const other = present.find((u) => byUrl.get(u) !== base);
    if (other) {
      diverged = { cluster: key, a: present[0]!, b: other };
      break;
    }
  }
  if (diverged) {
    varying.push(ruleId);
    firstDivergence.set(ruleId, diverged);
  } else {
    constant.push(ruleId);
  }
}

const pageRules = [...loadAllRules().values()].filter((r) => r.meta.scope === "page");
const declaredTemplate = new Set(
  pageRules.filter((r) => r.meta.verdictScope === "template").map((r) => r.meta.id),
);

console.log(`db          ${DB}`);
console.log(`crawl       ${crawl.id}`);
console.log(`pages       ${scored} scored`);
console.log(`clusters    ${members.size} (${multi.length} multi-page)`);
console.log(`measured    ${constant.length} of ${verdicts.size} page rules constant in every multi-page cluster`);
console.log(`declared    ${declaredTemplate.size} of ${pageRules.length} page rules declare verdictScope "template"`);

// A corpus that CANNOT falsify anything must not read as a pass. `--check` is a
// gate, and "no multi-page clusters" or "the declared rules were never compared"
// is inconclusive, not clean: an empty crawl, an all-singleton crawl, or a rule
// that emitted nothing would otherwise exit 0 with no evidence behind it.
const compared = new Set<string>();
for (const [ruleId, byUrl] of verdicts) {
  for (const [, urls] of multi) {
    if (urls.filter((u) => byUrl.has(u)).length >= 2) {
      compared.add(ruleId);
      break;
    }
  }
}
const uncompared = [...declaredTemplate].filter((id) => !compared.has(id));

// The gate: a declaration of "template" that this corpus falsifies.
const falsified = varying.filter((id) => declaredTemplate.has(id));
if (falsified.length > 0) {
  console.error("");
  console.error(`FALSIFIED: ${falsified.length} rule(s) declared "template" vary inside a cluster here`);
  for (const id of falsified) {
    const d = firstDivergence.get(id)!;
    console.error(`  ${id}`);
    console.error(`    cluster ${d.cluster}`);
    console.error(`      ${d.a}`);
    console.error(`      ${d.b}`);
  }
}

if (!flag("check")) {
  console.log("");
  console.log("constant here (candidates; still must be justified by the rule's inputs):");
  for (const id of constant) console.log(`  ${declaredTemplate.has(id) ? "T" : " "} ${id}`);
  console.log("");
  console.log("varying here (must be verdictScope \"page\"):");
  for (const id of varying) console.log(`  ${declaredTemplate.has(id) ? "T" : " "} ${id}`);
}

console.log("");
console.log(`compared    ${compared.size} rules over >=2 members of a cluster`);
if (uncompared.length > 0) {
  console.error(`INCONCLUSIVE: ${uncompared.length} declared-"template" rule(s) were never compared here`);
  for (const id of uncompared) console.error(`  ${id}`);
}

await run(storage.close());
rmSync(scratch, { recursive: true, force: true });

if (flag("check")) {
  if (multi.length === 0) {
    console.error("INCONCLUSIVE: this crawl has no multi-page clusters, so it can falsify nothing");
    process.exit(3);
  }
  if (uncompared.length > 0) process.exit(3);
}
if (falsified.length > 0) process.exit(2);
