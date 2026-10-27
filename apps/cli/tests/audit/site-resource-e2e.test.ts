// #2341 end-to-end: the shared-bundle collapse must survive the REAL
// `squirrel audit` path.
//
// Same reason `component-evidence-e2e` exists. The CLI does not hand rule
// results to the renderer: it writes them to SQLite and rebuilds the report
// from `rule_results` on the way out, field by field. An additive CheckResult
// field the store does not persist is invisible in production while every
// in-memory test stays green — so this drives the actual binary against a
// fixture site and asserts on the files it writes.
//
// The fixture is the shape the issue describes: a shared bundle on every page,
// plus a second bundle only the section pages load.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../../src/cli.ts");

/** The two maps every page ships, via one shared inline bundle. */
const SHARED_BUNDLE = `<script>
//# sourceMappingURL=/assets/app.js.map
//# sourceMappingURL=/assets/vendor.js.map
</script>`;

/** A third map only the /blog/* pages load. */
const SECTION_BUNDLE = `<script>
//# sourceMappingURL=/assets/blog.js.map
</script>`;

function page(path: string, section: boolean): string {
  const nav = `<nav><a href="/">Home</a><a href="/about">About</a><a href="/blog/one">One</a><a href="/blog/two">Two</a></nav>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${path} page</title><meta name="description" content="Fixture page ${path} for shared source maps."></head><body>${nav}<main><h1>${path}</h1><p>Body copy for ${path}.</p></main>${SHARED_BUNDLE}${section ? SECTION_BUNDLE : ""}</body></html>`;
}

const PAGES: Record<string, string> = {
  "/": page("/", false),
  "/about": page("/about", false),
  "/blog/one": page("/blog/one", true),
  "/blog/two": page("/blog/two", true),
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
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  home = mkdtempSync(join(tmpdir(), "sq-2341-home-"));
  out = mkdtempSync(join(tmpdir(), "sq-2341-out-"));
});

afterAll(() => {
  server?.stop(true);
  for (const dir of [home, out]) rmSync(dir, { recursive: true, force: true });
});

/**
 * Async on purpose: `Bun.spawnSync` blocks this process's event loop, so the
 * fixture server above could never answer the CLI's requests.
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
  if (exitCode !== 0)
    throw new Error(`cli ${args.join(" ")} exited ${exitCode}\n${stderr}`);
  return stdout;
}

describe("#2341 shared source maps collapse through the real audit pipeline", () => {
  test("json carries one site unit and one section unit", async () => {
    const file = join(out, "report.json");
    await cli([
      "audit",
      base,
      "-m",
      "10",
      "--offline",
      "--http",
      "--refresh",
      "-y",
      "-f",
      "json",
      "--rule-include",
      "perf/source-maps",
      "-o",
      file,
    ]);
    const report = JSON.parse(readFileSync(file, "utf8")) as {
      issues: Array<{
        ruleId: string;
        siteResourceFixGroups?: Array<{
          resourceKeys: string[];
          affectedPageCount: number;
          rendered: boolean;
          kind: string;
        }>;
      }>;
    };
    const issue = report.issues.find((i) => i.ruleId === "perf/source-maps");
    expect(issue).toBeDefined();

    const rendered = (issue!.siteResourceFixGroups ?? []).filter(
      (group) => group.rendered
    );
    expect(rendered).toHaveLength(2);

    const site = rendered.find((group) => group.affectedPageCount === 4)!;
    expect(site.kind).toBe("source-map");
    expect(site.resourceKeys.map((key) => key.split("/").pop())).toEqual([
      "app.js.map",
      "vendor.js.map",
    ]);

    const section = rendered.find((group) => group.affectedPageCount === 2)!;
    expect(section.resourceKeys.map((key) => key.split("/").pop())).toEqual([
      "blog.js.map",
    ]);
  }, 120_000);

  // `squirrel report` is a SEPARATE process that rebuilds the report from
  // SQLite. The units below can only exist if the store persisted the evidence,
  // so this doubles as the persistence assertion the v31 column exists for.
  test("llm renders exactly those two units and drops the per-page lines", async () => {
    const llm = await cli(["report", "-f", "llm"]);
    // The sample is bounded at 3 and says so; the COUNT is the exact 4.
    expect(llm).toContain(
      '<fix-once scope="site-resource" pages="4" resources="2">Fix once in the build: 2 source maps exposed by shared bundles (app.js.map, vendor.js.map), 4 pages: /, /about, /blog/one (+1 more)</fix-once>'
    );
    expect(llm).toContain(
      '<fix-once scope="site-resource" pages="2" resources="1">Fix once in the build: 1 source map exposed by shared bundles (blog.js.map), 2 pages: /blog/one, /blog/two</fix-once>'
    );
    // Exactly two units for the whole rule, not one per page.
    expect(llm.split('scope="site-resource"')).toHaveLength(3);
    // The units REPLACED the legacy per-page lines rather than joining them.
    const ruleBlock = llm.slice(llm.indexOf('id="perf/source-maps"'));
    const ruleEnd = ruleBlock.indexOf("</rule>");
    expect(ruleBlock.slice(0, ruleEnd)).not.toContain("Pages (");
  }, 120_000);

  // `report -i` goes through convertSlimReport, a DIFFERENT rebuild from the
  // SQLite one above: it reads the packed evidence back out of the JSON file and
  // re-derives the units. The serialized `siteResourceFixGroups` are derived and
  // deliberately not read back, so a unit here proves the raw evidence survived.
  test("the units survive a re-import of the JSON file", async () => {
    const file = join(out, "report.json");
    const llm = await cli(["report", "-i", file, "-f", "llm"]);
    expect(llm).toContain(
      '<fix-once scope="site-resource" pages="4" resources="2">Fix once in the build: 2 source maps exposed by shared bundles (app.js.map, vendor.js.map), 4 pages: /, /about, /blog/one (+1 more)</fix-once>'
    );
    expect(llm).toContain(
      '<fix-once scope="site-resource" pages="2" resources="1">Fix once in the build: 1 source map exposed by shared bundles (blog.js.map), 2 pages: /blog/one, /blog/two</fix-once>'
    );
    expect(llm.split('scope="site-resource"')).toHaveLength(3);
  }, 120_000);

  test("markdown and text say it in the same words", async () => {
    const markdown = await cli(["report", "-f", "markdown"]);
    expect(markdown).toContain(
      "**Fix once in the build: 2 source maps exposed by shared bundles (app.js.map, vendor.js.map), 4 pages: /, /about, /blog/one (+1 more)**"
    );
    const text = await cli(["report", "-f", "text"]);
    expect(text).toContain(
      "Fix once in the build: 1 source map exposed by shared bundles (blog.js.map), 2 pages: /blog/one, /blog/two"
    );
  }, 120_000);
});
