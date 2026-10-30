// #858 end to end: a page and its query-string variant that declares it canonical are
// one page in the report; a variant with its own canonical stays separate; a site with
// no variants reports exactly as before.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-canonical-858-"));
let homes = 0;

const page = (title: string, canonical: string | null, links: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title>${canonical ? `<link rel="canonical" href="${canonical}">` : ""}</head><body><main><h1>${title}</h1><p>${title} page body text for the audit to read.</p>${links}</main></body></html>`;

// /contact and /contact?subject=Billing both declare /contact as canonical; /blog?page=2 declares itself.
const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    const origin = url.origin;
    const html = { headers: { "content-type": "text/html; charset=utf-8" } };
    if (url.pathname === "/")
      return new Response(
        page(
          "Home",
          `${origin}/`,
          `<a href="/contact">Contact</a> <a href="/about">About</a> <a href="/contact?subject=Billing">Billing</a> <a href="/blog">Blog</a> <a href="/blog?page=2">Page two</a>`
        ),
        html
      );
    if (url.pathname === "/contact") {
      // Both the page and its prefilled variant declare /contact as canonical.
      return new Response(
        page("Contact", `${origin}/contact`, `<a href="/">Home</a>`),
        html
      );
    }
    if (url.pathname === "/blog") {
      // Pagination keeps its own canonical.
      return new Response(
        page(
          url.search ? "Blog page two" : "Blog",
          `${origin}/blog${url.search}`,
          `<a href="/">Home</a>`
        ),
        html
      );
    }
    if (url.pathname === "/about")
      return new Response(
        page("About", `${origin}/about`, `<a href="/">Home</a>`),
        html
      );
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  void site.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
      continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: join(scratch, `home-${++homes}`),
    SQUIRREL_NO_UPDATE: "1",
    NO_TELEMETRY: "1",
    NO_COLOR: "1",
  };
}

async function audit(...args: string[]) {
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      entry,
      "audit",
      `http://127.0.0.1:${site.port}/`,
      "--offline",
      "--http",
      "--rule-include",
      "core/meta-description",
      "-m",
      "20",
      ...args,
    ],
    { env: cleanEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  const [out] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return out;
}

interface Json {
  meta: { totalPages: number; canonicalVariants?: number };
  issues: Array<{
    ruleId?: string;
    id?: string;
    checks: Array<{ name: string; pages?: string[]; pageCount?: number }>;
  }>;
}

describe("query-string variants counted with their canonical (#858)", () => {
  test("the contact variant folds into /contact; a paginated blog page with its own canonical stays separate", async () => {
    const json = JSON.parse(await audit("-f", "json")) as Json;
    // Pages: /, /contact, /about, /blog, /blog?page=2 (own canonical) = 5; /contact?subject=Billing is a variant.
    expect(json.meta.canonicalVariants).toBe(1);
    expect(json.meta.totalPages).toBe(5);
    // The finding counts the variant under /contact, so the affected pages are the five.
    const issues = JSON.stringify(json.issues);
    expect(issues).not.toContain("subject=Billing");
    expect(issues).toContain("page=2");
    expect(issues).toContain('"affectedPagesCount":5');
  }, 120_000);

  test("every text-like format says it once and the scan line agrees with the total", async () => {
    const text = await audit("-f", "text");
    expect(text).toContain("5 pages crawled");
    expect(text).toContain(
      "1 query-string variant counted with its canonical."
    );
    const llm = await audit("-f", "llm");
    expect(llm).toContain('canonical-variants="1"');
    expect(llm).toContain('crawled="5"');
  }, 180_000);
});
