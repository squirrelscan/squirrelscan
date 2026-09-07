// Which storage statements a real crawl actually compiles, and how often (#1911).
//
// `bun:sqlite` has two ways to get a statement and they are not interchangeable:
// `db.query(sql)` caches by SQL text and hands back the SAME compiled statement,
// `db.prepare(sql)` compiles a new one every call. The storage layer used
// `prepare` in all 116 places, so every operation re-parsed its SQL; #247
// converted the frontier hot path and `getCrawl` and deliberately left the rest.
//
// The rest is not a mass edit, because most of those 95 statements run once or
// twice per crawl and converting them buys nothing while widening the change.
// This says which ones are hot, from a REAL crawl rather than from reading the
// code: it patches `Database.prototype.prepare` to count compilations by SQL,
// runs a crawl against an in-process origin, and prints the ranking.
//
//   bun run scripts/statement-compile-census.ts --pages 200 --links 50
//
// Read the COUNT column, not the SQL. A statement compiled once per crawl is
// not worth touching however expensive its text looks; one compiled per link is
// the whole point of the issue.
//
// The origin is served in-process so the census measures storage rather than
// network: pages are small and link-dense, which is the shape that makes the
// frontier and link-appearance statements dominate.

import { Database } from "bun:sqlite";
import { Effect } from "effect";

import { createCrawler } from "../src/core";
import { SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

const PAGES = Number.parseInt(arg("pages", "200"), 10);
// The CLI defaults `incremental` to TRUE, and that path reads a cached page per
// URL, so a census run with it off measures a configuration real audits do not
// use. Default it on here and let it be turned off rather than the reverse.
const INCREMENTAL = !process.argv.includes("--no-incremental");
const LINKS = Number.parseInt(arg("links", "50"), 10);
const TOP = Number.parseInt(arg("top", "20"), 10);
// `--digest` prints a hash of what the crawl actually stored instead of the
// ranking, so the same crawl can be run on two revisions and the outputs
// compared. A statement-caching change must not move it by a byte.
const DIGEST = process.argv.includes("--digest");
// `--cost` measures what one compilation of each converted statement costs
// against the real schema, so the census's count can be turned into time
// without borrowing a number from somewhere else or from a toy table.
const COST = process.argv.includes("--cost");
const REPEATS = Math.max(1, Number.parseInt(arg("repeat", "1"), 10));

if (COST) {
  // The REAL statements, against the real schema, because a toy SELECT against
  // a three-column table compiles faster than a twenty-column INSERT and would
  // understate what the conversion removes.
  const costStore = new SQLiteStorage(":memory:");
  await run(costStore.init());
  const db = (costStore as unknown as { getDb(): Database }).getDb();
  const SQL: Array<[string, string]> = [
    ["getIncomingLinkCount", "SELECT COUNT(*) as count FROM link_appearances WHERE crawl_id = ? AND href = ?"],
    ["getCachedPage", "SELECT * FROM pages WHERE normalized_url = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 1"],
    ["updateCrawl (stats)", "UPDATE crawls SET stats = ? WHERE id = ?"],
    ["upsertFrontier", "INSERT OR REPLACE INTO frontier (crawl_id, normalized_url, raw_url, depth, parent_url, priority, status, source, enqueued_at, fetched_at, retry_count, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"],
  ];
  const N = 5_000;
  // Interleaved, minimum of five rounds: the two arms then share whatever the
  // machine is doing rather than one of them getting a quiet stretch.
  console.log(`compilation cost per statement, minimum of five interleaved rounds of ${N}:`);
  console.log(`  ${"statement".padEnd(22)} ${"prepare".padStart(10)} ${"query hit".padStart(10)}`);
  let totalPrepare = 0;
  for (const [name, sql] of SQL) {
    let bestPrepare = Infinity;
    let bestQuery = Infinity;
    for (let round = 0; round < 5; round++) {
      let t = Bun.nanoseconds();
      for (let i = 0; i < N; i++) db.prepare(sql);
      bestPrepare = Math.min(bestPrepare, (Bun.nanoseconds() - t) / N / 1000);
      t = Bun.nanoseconds();
      for (let i = 0; i < N; i++) db.query(sql);
      bestQuery = Math.min(bestQuery, (Bun.nanoseconds() - t) / N / 1000);
    }
    totalPrepare += bestPrepare;
    console.log(
      `  ${name.padEnd(22)} ${`${bestPrepare.toFixed(2)} us`.padStart(10)} ${`${bestQuery.toFixed(2)} us`.padStart(10)}`,
    );
  }
  // `upsertPage` is left out: its INSERT is the widest statement in the file and
  // needs the full binding set to compile representatively, so quoting a number
  // for it here would be a guess. The four above are the measurable ones.
  console.log(`  ${"sum of the four".padEnd(22)} ${`${totalPrepare.toFixed(2)} us`.padStart(10)}`);
  await run(costStore.close());
  process.exit(0);
}

// ── the origin ───────────────────────────────────────────────────────────────

const path = (i: number) => (i === 0 ? "/" : `/p/${String(i).padStart(5, "0")}`);

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /\n", {
        headers: { "content-type": "text/plain" },
      });
    }
    const index = pathname === "/" ? 0 : Number.parseInt(pathname.slice(3), 10);
    if (!Number.isFinite(index) || index < 0 || index >= PAGES) {
      return new Response("not found", { status: 404 });
    }
    // Link-dense and small: the census is about statement counts, and a big
    // page would just spend the run in the parser.
    const links = Array.from(
      { length: LINKS },
      (_, k) => `<a href="${path((index * 7 + k * 13) % PAGES)}">Link ${k}</a>`,
    ).join("");
    const images = Array.from(
      { length: 8 },
      (_, k) => `<img src="/img/${index}/${k}.png" alt="Image ${k}">`,
    ).join("");
    return new Response(
      `<!doctype html><html lang="en"><head><title>Page ${index}</title>` +
        `<meta name="description" content="Census page ${index}"></head>` +
        `<body><h1>Page ${index}</h1><nav>${links}</nav>${images}</body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});
const origin = `http://127.0.0.1:${server.port}`;

// ── the census ───────────────────────────────────────────────────────────────

// BOTH entry points are patched, and they are counted differently, because
// hooking `prepare` alone counts the wrong thing.
//
// `db.query` does not go through the public `prepare`: Bun compiles it via an
// internal path, so a hook on `prepare` sees none of it and a run that converted
// everything to `query` would report zero compilations whether or not the cache
// was working. What `query` guarantees instead is one compilation per distinct
// SQL TEXT, with every later call a cache hit — so its compilations are the
// count of distinct texts, and its calls beyond the first are free.
//
// `prepare` compiles on every call, so each call is one compilation.
const prepareCalls = new Map<string, number>();
const queryCalls = new Map<string, number>();
const realPrepare = Database.prototype.prepare;
const realQuery = Database.prototype.query;
(Database.prototype as unknown as Record<string, unknown>).prepare = function patched(
  this: Database,
  sql: string,
  ...rest: unknown[]
) {
  prepareCalls.set(sql, (prepareCalls.get(sql) ?? 0) + 1);
  return (realPrepare as (this: Database, sql: string, ...r: unknown[]) => unknown).call(this, sql, ...rest);
};
(Database.prototype as unknown as Record<string, unknown>).query = function patchedQuery(
  this: Database,
  sql: string,
  ...rest: unknown[]
) {
  queryCalls.set(sql, (queryCalls.get(sql) ?? 0) + 1);
  return (realQuery as (this: Database, sql: string, ...r: unknown[]) => unknown).call(this, sql, ...rest);
};

const storage = new SQLiteStorage(":memory:");
await run(storage.init());
// Digest mode crawls SERIALLY. With workers in flight the order URLs are
// discovered in decides each one's depth and parent, so the same binary
// produces a different digest on every run and the comparison is worthless —
// verified: three runs of identical code gave three different hashes. One
// worker makes discovery order a function of the site, which is what lets two
// revisions be compared at all.
const concurrency = DIGEST ? 1 : 8;
const crawler = await run(createCrawler({ storage, config: { maxPages: PAGES, concurrency, perHostConcurrency: concurrency, delayMs: 0, perHostDelayMs: 0, respectRobots: false, incremental: INCREMENTAL } as never }));

const startedAt = Date.now();
const crawlId = await run(crawler.start(origin) as Effect.Effect<string, unknown, never>);
const elapsed = Date.now() - startedAt;
const pageCount = await run(storage.getPageCount(crawlId));

if (DIGEST) {
  // Everything the crawl decided, in a stable order: which URLs it stored, what
  // it made of each one, and every frontier verdict. Volatile columns are left
  // out on purpose — timings and row ids differ run to run and would mask the
  // question with noise rather than answer it.
  const db = (storage as unknown as { getDb(): import("bun:sqlite").Database }).getDb();
  // Every column a statement-caching bug could corrupt, not a readable subset.
  // A narrower projection let a version of this pass with `parsed_data` nulled
  // on all 120 rows: the digest is only as good as what it looks at.
  const pages = db
    .query(
      `SELECT normalized_url, final_url, depth, parent_url, redirect_chain, status, content_type,
              size_bytes, content_hash, html, parsed_data, headers, security_headers
       FROM pages WHERE crawl_id = ? ORDER BY normalized_url`,
    )
    .all(crawlId);
  const frontier = db
    .query(
      `SELECT normalized_url, raw_url, depth, parent_url, priority, status, source, retry_count, reason
       FROM frontier WHERE crawl_id = ? ORDER BY normalized_url`,
    )
    .all(crawlId);
  // The crawls row too: the stats UPDATE is one of the converted statements, so
  // leaving its output out would exempt the change from its own check.
  const crawls = db
    .query(`SELECT base_url, seed_url, original_url, status, config, stats FROM crawls WHERE id = ?`)
    .all(crawlId);
  const links = db
    .query(
      `SELECT href, page_url, position, is_nofollow FROM link_appearances
       WHERE crawl_id = ? ORDER BY page_url, href, position`,
    )
    .all(crawlId);
  // The origin is stripped before hashing. `port: 0` takes an ephemeral port,
  // so every run has a different host in every URL and two runs of IDENTICAL
  // code hash differently — which is what this looked like the first time, and
  // is not a difference in what the crawl decided.
  const strip = (value: unknown): unknown =>
    typeof value === "string" ? value.split(origin).join("{origin}") : value;
  const normalise = (rows: unknown[]) =>
    rows.map((row) =>
      Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([k, v]) => [k, strip(v)])),
    );
  const digestable = {
    pages: normalise(pages),
    frontier: normalise(frontier),
    links: normalise(links),
    crawls: normalise(crawls),
  };

  const outPath = arg("out", "");
  if (outPath) await Bun.write(outPath, JSON.stringify(digestable, null, 1));
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(JSON.stringify(digestable));
  console.log(
    `DIGEST pages=${pages.length} frontier=${frontier.length} links=${links.length} ` +
      `crawls=${crawls.length} ` +
      `sha256=${hash.digest("hex").slice(0, 32)}`,
  );
  await run(storage.close());
  server.stop(true);
  process.exit(0);
}

server.stop(true);

// One compilation per `prepare` CALL; one per distinct `query` TEXT.
const rows = [...prepareCalls].sort((a, b) => b[1] - a[1]);
const prepareCompiles = rows.reduce((sum, [, n]) => sum + n, 0);
const queryCompiles = queryCalls.size;
const queryHits = [...queryCalls.values()].reduce((sum, n) => sum + n, 0) - queryCompiles;
const total = prepareCompiles + queryCompiles;
console.log(
  `crawled ${pageCount} pages in ${(elapsed / 1000).toFixed(1)}s, ${LINKS} links/page, ` +
    `incremental=${INCREMENTAL}\n` +
    `${total} statement compilations (${(total / Math.max(1, pageCount)).toFixed(1)} per page): ` +
    `${prepareCompiles} from ${rows.length} prepare texts, ` +
    `${queryCompiles} from ${queryCalls.size} query texts with ${queryHits} cache hits\n`,
);
if (queryCalls.size > 20) {
  // Bun caches query statements in a bounded LRU. Past its size the cache
  // thrashes and `query` starts recompiling, which would make every number
  // above wrong in the safe-looking direction.
  console.log(`  WARNING: ${queryCalls.size} distinct query texts may exceed Bun's statement cache\n`);
}
console.log(`${"count".padStart(8)} ${"per page".padStart(9)}  sql`);
for (const [sql, n] of rows.slice(0, TOP)) {
  const flat = sql.replace(/\s+/g, " ").trim();
  console.log(
    `${String(n).padStart(8)} ${(n / Math.max(1, pageCount)).toFixed(1).padStart(9)}  ` +
      `${flat.length > 110 ? `${flat.slice(0, 107)}...` : flat}`,
  );
}
const tail = rows.slice(TOP).reduce((sum, [, n]) => sum + n, 0);
if (tail > 0) console.log(`${String(tail).padStart(8)} ${"".padStart(9)}  (${rows.length - TOP} more SQL texts)`);
await run(storage.close());
