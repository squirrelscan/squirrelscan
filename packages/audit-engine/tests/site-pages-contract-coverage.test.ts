// Every in-repo `upsertSitePages` implementation runs the keyed-upsert contract (#497).
//
// The cloud merge hands `upsertSitePages` only the pages a run changed, which is
// safe only for a store that upserts by key and never drops a row the call left
// out. `helpers/site-pages-contract.ts` holds the cases. This file finds every
// implementation in the repo and fails when one is not run through them, so a new
// store cannot ship without the contract.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { BenchStore } from "../scripts/bench-store";
import { describeSitePagesContract } from "./helpers/site-pages-contract";

describeSitePagesContract("scripts/bench-store.ts BenchStore", () => new BenchStore());

const REPO = join(import.meta.dir, "../../..");
const SELF = "packages/audit-engine/tests/site-pages-contract-coverage.test.ts";

/**
 * An implementation with a body: a method (`upsertSitePages(pages) {`, with or
 * without `async` and a return type) or an object property
 * (`upsertSitePages: async (rows) => {`). An interface member ends in `;` and a
 * call site has no body, so neither matches.
 */
const IMPLEMENTATION =
  /(?<![.\w])upsertSitePages\s*\([^)]*\)\s*(?::\s*[^{;=]+)?\{|(?<![.\w])upsertSitePages\s*:\s*async\s*\([^)]*\)\s*=>\s*\{/;

/**
 * Implementations whose contract run lives in another file, mapped to it. A test
 * double runs the contract from its own file instead, beside the store it defines.
 */
const RUN_ELSEWHERE: Record<string, string> = {
  "packages/crawler/src/storage/sqlite.ts": "packages/crawler/tests/page-findings-store.test.ts",
  "packages/audit-engine/scripts/bench-store.ts": SELF,
};

function implementations(): string[] {
  const found: string[] = [];
  for (const root of ["packages", "apps"]) {
    for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: join(REPO, root) })) {
      if (file.includes("node_modules/")) continue;
      const path = `${root}/${file}`;
      if (IMPLEMENTATION.test(readFileSync(join(REPO, path), "utf8"))) found.push(path);
    }
  }
  return found.sort();
}

describe("upsertSitePages contract coverage", () => {
  const found = implementations();

  test("the scan finds the known implementations", () => {
    // A scan that found nothing would pass the next test vacuously.
    expect(found).toContain("packages/crawler/src/storage/sqlite.ts");
    expect(found).toContain("packages/audit-engine/scripts/bench-store.ts");
    expect(found).toContain("packages/audit-engine/tests/cloud-merge.test.ts");
  });

  test("every implementation runs describeSitePagesContract", () => {
    const missing = found.filter((path) => {
      const runner = RUN_ELSEWHERE[path] ?? path;
      return !readFileSync(join(REPO, runner), "utf8").includes("describeSitePagesContract(");
    });
    expect(missing).toEqual([]);
  });

  test("the mapped implementations still exist", () => {
    for (const path of Object.keys(RUN_ELSEWHERE)) expect(found).toContain(path);
    expect(relative(REPO, join(import.meta.dir, "site-pages-contract-coverage.test.ts"))).toBe(SELF);
  });
});
