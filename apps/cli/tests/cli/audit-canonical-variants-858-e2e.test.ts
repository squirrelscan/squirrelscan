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
  `<!doctype html><html lang="en"><head><title>${title}</title>${canonical ? `<link rel="canonical" href="${canonical}">` : ""}<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"${title}"}</script></head><body><main><h1>${title}</h1><p>${title} page body text for the audit to read.</p>${links}</main></body></html>`;

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
  entities?: { summary: { pagesTotal: number }; pages: Array<{ url: string }> };
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
    // The entity map counts pages the way the report does (#1350): the variant is not listed.
    expect(json.entities?.summary.pagesTotal).toBe(5);
    expect(JSON.stringify(json.entities?.pages)).not.toContain(
      "subject=Billing"
    );
    // The finding counts the variant under /contact, so the affected pages are the five.
    const issues = JSON.stringify(json.issues);
    expect(issues).not.toContain("subject=Billing");
    expect(issues).toContain("page=2");
    expect(issues).toContain('"affectedPagesCount":5');
    // No variant URL is lost: the report lists each folded variant with the page it is counted with.
    expect(
      JSON.stringify(
        (json.meta as { canonicalVariantPages?: unknown }).canonicalVariantPages
      )
    ).toContain("subject=Billing");
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

describe("entity map page counts when a variant redirected (#1350)", () => {
  // /Contact/?subject=Billing redirects to another URL, so the entity map lists it under its final URL.
  const redirecting = Bun.serve({
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
            `<a href="/Contact/">c</a> <a href="/Contact/?subject=Billing">v</a>`
          ),
          html
        );
      if (url.pathname === "/Contact/" && url.search === "?subject=Billing")
        return new Response(null, {
          status: 302,
          headers: { location: "/Contact/?subject=Billing&x=1" },
        });
      if (url.pathname === "/Contact/")
        return new Response(
          page("Contact", `${origin}/Contact/`, `<a href="/">Home</a>`),
          html
        );
      return new Response("not found", { status: 404 });
    },
  });
  afterAll(() => void redirecting.stop(true));

  test("pagesTotal agrees with the report's page total", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "run",
        entry,
        "audit",
        `http://127.0.0.1:${redirecting.port}/`,
        "--offline",
        "--http",
        "-m",
        "10",
        "-f",
        "json",
      ],
      { env: cleanEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" }
    );
    const [out] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const json = JSON.parse(out) as Json;
    expect(json.entities?.summary.pagesTotal).toBe(json.meta.totalPages);
    expect(JSON.stringify(json.entities?.pages)).not.toContain(
      "subject=Billing"
    );
  });
});
