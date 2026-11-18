// repo#2730: a link whose status means "blocked us" is unverifiable, never
// broken. The cloud bulk checker normally sends 999, 401 and 406 as
// unverifiable already; an older server or a legacy cached answer may send the
// bare status, which the engine marks unverifiable (and does not cache). A
// bare 403 or 405 from the service is its final-tier answer and is kept as sent.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  checkExternalLinks,
  type ExternalCheckResult,
  type LinkCache,
  type LinkCacheEntry,
} from "../src/external-checker";

const OPTIONS = { ttlSeconds: 60, concurrency: 2, timeoutMs: 2000 };

function answer(href: string, extra: Partial<ExternalCheckResult>): ExternalCheckResult {
  return { href, status: null, error: null, redirectTarget: null, fromCache: false, ...extra };
}

/** A bulk checker that answers every url it is asked about, so no local fetch happens. */
function bulk(answers: ExternalCheckResult[]) {
  const byHref = new Map(answers.map((a) => [a.href, a]));
  return async (urls: string[]) => new Map(urls.flatMap((u) => (byHref.has(u) ? [[u, byHref.get(u)!] as const] : [])));
}

async function run(
  answers: ExternalCheckResult[],
  cache: LinkCache | null = null,
  onVerdict?: (result: ExternalCheckResult) => void,
) {
  const results = await Effect.runPromise(
    checkExternalLinks(
      answers.map((a) => a.href),
      cache,
      { ...OPTIONS, bulkChecker: bulk(answers), ...(onVerdict ? { onVerdict } : {}) },
    ),
  );
  return new Map(results.map((r) => [r.href, r]));
}

describe("bulk checker wall statuses (repo#2730)", () => {
  test("a bare 999, 401 or 406 is unverifiable, status kept", async () => {
    const answers = [999, 401, 406].map((status) => answer(`https://example.com/${status}`, { status }));
    const byHref = await run(answers);
    for (const status of [999, 401, 406]) {
      expect(byHref.get(`https://example.com/${status}`)).toMatchObject({
        status,
        wafBlocked: true,
        wafProvider: "unknown",
        unverifiedReason: "blocked",
      });
    }
  });

  test("a bare 403 or 405 stays as the service answered", async () => {
    const byHref = await run([
      answer("https://example.com/403", { status: 403 }),
      answer("https://example.com/405", { status: 405 }),
    ]);
    for (const status of [403, 405]) {
      const r = byHref.get(`https://example.com/${status}`)!;
      expect(r.status).toBe(status);
      expect(r.wafBlocked).toBeUndefined();
      expect(r.unverifiedReason).toBeUndefined();
    }
  });

  test("a 404 is unchanged", async () => {
    const r = (await run([answer("https://example.com/404", { status: 404 })])).get("https://example.com/404")!;
    expect(r.status).toBe(404);
    expect(r.wafBlocked).toBeUndefined();
  });

  test("an already unverifiable 406 keeps its provider", async () => {
    const r = (
      await run([
        answer("https://example.com/406", {
          status: 406,
          wafBlocked: true,
          wafProvider: "cloudflare",
          unverifiedReason: "blocked",
        }),
      ])
    ).get("https://example.com/406")!;
    expect(r).toMatchObject({ wafBlocked: true, wafProvider: "cloudflare", unverifiedReason: "blocked" });
  });

  test("the unverifiable answer is not cached, a 404 is", async () => {
    const written: LinkCacheEntry[] = [];
    const cache: LinkCache = {
      getCachedBulk: () => new Map(),
      setCachedBulk: (entries) => void written.push(...entries),
    };
    await run(
      [
        answer("https://example.com/999", { status: 999 }),
        answer("https://example.com/404", { status: 404 }),
      ],
      cache,
    );
    expect(written.map((e) => e.href)).toEqual(["https://example.com/404"]);
  });

  test("the late-bound verdict carries the same unverifiable answer (repo#2144)", async () => {
    const told: ExternalCheckResult[] = [];
    await run([answer("https://example.com/999", { status: 999 })], null, (r) => told.push(r));
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      href: "https://example.com/999",
      status: 999,
      wafBlocked: true,
      wafProvider: "unknown",
      unverifiedReason: "blocked",
    });
  });
});
