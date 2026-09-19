// #2307 end-to-end: component evidence must survive the REAL `squirrel audit`
// path, not just the in-process rule/report unit paths.
//
// This exists because every unit and synthetic-corpus test passed while the
// shipped CLI emitted no evidence at all. The CLI does not hand rule results
// straight to the renderer: it writes them to SQLite and rebuilds the report
// from `rule_results` on the way out, and that row<->CheckResult mapping is
// field-by-field. Any additive CheckResult field that the store does not
// persist is therefore invisible in production while every in-memory test
// stays green. So this drives the actual binary against a local fixture site
// and asserts on the files it writes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../../src/cli.ts");
// Deliberately far in the past: the rule compares against the wall clock, and a
// year like 2025 would stop being stale the moment the clock rolls over.
const STALE_YEAR = 2019;

/** Shared site chrome: the same footer markup on every page. */
function footer(): string {
  return `<footer class="site-footer">
    <nav><a href="/">Home</a><a href="/about">About</a><a href="/docs">Docs</a></nav>
    <p>&copy; ${STALE_YEAR} Example Corp</p>
    <a href="/pricing">Read more</a>
  </footer>`;
}

/** Two different layouts around the identical footer. */
function page(path: string, layout: "plain" | "with-header"): string {
  const body =
    layout === "plain"
      ? `<main><h1>${path}</h1><p>Body copy for ${path}.</p></main>`
      : `<header><nav><a href="/">Brand</a></nav></header><main><article><h1>${path}</h1><p>Article copy.</p></article></main>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${path} page</title><meta name="description" content="Fixture page ${path} for component evidence."></head><body>${body}${footer()}</body></html>`;
}

const PAGES: Record<string, string> = {
  "/": page("/", "plain"),
  "/about": page("/about", "plain"),
  "/docs": page("/docs", "with-header"),
};

let server: ReturnType<typeof Bun.serve>;
let base: string;
let home: string;
let out: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/robots.txt") {
        return new Response("User-agent: *\nAllow: /\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      const html = PAGES[pathname];
      if (!html) return new Response("Not found", { status: 404 });
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  home = mkdtempSync(join(tmpdir(), "sq-2307-home-"));
  out = mkdtempSync(join(tmpdir(), "sq-2307-out-"));
});

afterAll(() => {
  server?.stop(true);
  for (const dir of [home, out]) rmSync(dir, { recursive: true, force: true });
});

/**
 * Async on purpose: `Bun.spawnSync` blocks this process's event loop, so the
 * fixture server above could never answer the CLI's requests and every crawl
 * timed out.
 */
async function cli(args: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, HOME: home, NO_COLOR: "1", NO_TELEMETRY: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`cli ${args.join(" ")} exited ${exitCode}\n${stderr}`);
  }
  return stdout;
}

describe("#2307 component evidence survives the real audit pipeline", () => {
  let report: {
    issues: Array<{
      ruleId: string;
      componentFixGroups?: Array<{
        id: string;
        affectedPageCount: number;
        affectedPages: string[];
        affectedPagesHasMore: boolean;
        occurrenceCount: number;
        occurrenceRefs: Array<{ checkIndex: number; occurrenceIndex: number }>;
        region: { role: string; nestedIn: string };
        defect: { kind: string };
      }>;
      checks: Array<{ componentOccurrences?: Array<Record<string, unknown>> }>;
    }>;
  };

  test(
    "audit writes component evidence and one cross-page fix group to JSON",
    async () => {
      const file = join(out, "report.json");
      await cli([
        "audit",
        base,
        "-m",
        "5",
        "--offline",
        "--http",
        "--refresh",
        "-y",
        "-f",
        "json",
        "--rule-include",
        "content/stale-copyright,a11y/link-text",
        "-o",
        file,
      ]);
      report = JSON.parse(readFileSync(file, "utf8"));

      const stale = report.issues.find((issue) => issue.ruleId === "content/stale-copyright");
      expect(stale).toBeDefined();

      // The evidence exists at all — this is what the store used to drop.
      const occurrences = stale!.checks.flatMap((check) => check.componentOccurrences ?? []);
      expect(occurrences.length).toBeGreaterThanOrEqual(3);
      for (const occurrence of occurrences) {
        expect(typeof occurrence.siteOrigin).toBe("string");
        expect(occurrence.provenance).toEqual({ source: "page-dom", rendered: false });
      }

      // The identical footer on three pages across two layouts is ONE target.
      const groups = stale!.componentFixGroups ?? [];
      expect(groups).toHaveLength(1);
      const group = groups[0]!;
      expect(group.id).toMatch(/^component-fix:[0-9a-f]{32}(-\d+)?$/);
      expect(group.defect.kind).toBe("stale-copyright");
      expect(group.region).toMatchObject({ role: "footer", nestedIn: "none" });
      expect(group.affectedPageCount).toBe(3);
      expect(new Set(group.affectedPages).size).toBe(3);
      expect(group.affectedPagesHasMore).toBe(false);

      // Evidence is serialized once and referenced, never repeated.
      expect((group as { occurrences?: unknown }).occurrences).toBeUndefined();
      expect(group.occurrenceRefs).toHaveLength(group.occurrenceCount);
      for (const ref of group.occurrenceRefs) {
        expect(stale!.checks[ref.checkIndex]?.componentOccurrences?.[ref.occurrenceIndex]).toBeDefined();
      }
    },
    120_000,
  );

  test(
    "the stored audit renders the group with a labelled page sample in llm, markdown and text",
    async () => {
      const llm = await cli(["report", "-f", "llm"]);
      expect(llm).toContain("<component-fix-group");
      expect(llm).toContain('defect_kind="stale-copyright"');
      expect(llm).toContain('affected_pages="3"');
      expect(llm).toMatch(/<affected-page-sample bounded="true" shown="\d+" total="3">/);

      const markdown = await cli(["report", "-f", "markdown"]);
      expect(markdown).toContain("**Actionable component fix target:**");
      expect(markdown).toContain("3 affected page(s)");

      const text = await cli(["report", "-f", "text"]);
      expect(text).toContain("Actionable component fix target: stale-copyright in footer (none)");
      expect(text).toContain("3 affected page(s)");
    },
    120_000,
  );

  test(
    "reimporting the JSON with -i keeps the evidence and re-derives the same group",
    async () => {
      const file = join(out, "report.json");

      // `convertSlimReport` rebuilds CheckResults field-by-field from the file,
      // so this is the second place (after the SQLite row mapper) where an
      // additive field is dropped unless it is explicitly carried.
      const reimported = JSON.parse(await cli(["report", "-i", file, "-f", "json"]));
      const stale = reimported.issues.find(
        (issue: { ruleId: string }) => issue.ruleId === "content/stale-copyright",
      );
      expect(stale).toBeDefined();
      const occurrences = stale.checks.flatMap(
        (check: { componentOccurrences?: unknown[] }) => check.componentOccurrences ?? [],
      );
      expect(occurrences).toHaveLength(3);

      const groups = stale.componentFixGroups ?? [];
      expect(groups).toHaveLength(1);
      expect(groups[0].affectedPageCount).toBe(3);
      expect(groups[0].occurrenceRefs).toHaveLength(3);
      for (const ref of groups[0].occurrenceRefs) {
        expect(stale.checks[ref.checkIndex]?.componentOccurrences?.[ref.occurrenceIndex]).toBeDefined();
      }
      // Reimport must reach the SAME target id as the audit that wrote the file.
      const original = JSON.parse(readFileSync(file, "utf8"));
      const originalGroup = original.issues.find(
        (issue: { ruleId: string }) => issue.ruleId === "content/stale-copyright",
      ).componentFixGroups[0];
      expect(groups[0].id).toBe(originalGroup.id);

      const llm = await cli(["report", "-i", file, "-f", "llm"]);
      expect(llm).toContain("<component-fix-group");
      expect(llm).toContain('affected_pages="3"');
      expect(llm).toMatch(/<affected-page-sample bounded="true" shown="\d+" total="3">/);
    },
    120_000,
  );
});
