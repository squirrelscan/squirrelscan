// #322, #649, #319: the docs check fails on a dead internal link, a dead
// #anchor, a missing required anchor and a broken Options row, and passes the
// same pages once they are fixed. Each test writes a small docs tree to a temp
// dir, so no fixture page ends up in the published site.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { anchorsOf, checkDocs, renderedText, slugify } from "./check-links";

let root = "";

function docs(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), "docs-links-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

const GUIDE = [
  "---",
  'title: "Guide"',
  "---",
  "",
  "## Getting started",
  "",
  "## Getting started",
  "",
  "### `max_pages`",
  "",
  "## Fresh crawl (--refresh)",
  "",
  "## Service tiers \\{#tiers\\}",
  "",
  '<div id="custom-target" />',
  "",
].join("\n");

const messages = (root: string, required: string[] = []) =>
  checkDocs(root, required).map((p) => `${p.file}:${p.line}: ${p.message}`);

describe("anchors a page renders", () => {
  test("headings slug like the site: repeats, code spans, smartypants dashes, explicit ids", () => {
    const ids = anchorsOf(GUIDE);
    expect([...ids].sort()).toEqual(
      [
        "custom-target",
        "fresh-crawl-refresh",
        "getting-started",
        "getting-started-1",
        "max_pages",
        "tiers",
      ].sort()
    );
  });

  test("slugify and renderedText match github-slugger over the rendered text", () => {
    expect(
      slugify(renderedText("Option 1: a secret request header (recommended)"))
    ).toBe("option-1-a-secret-request-header-recommended");
    expect(
      slugify(
        renderedText("[Links](/rules/links) and **bold** `per_host_delay_ms`")
      )
    ).toBe("links-and-bold-per_host_delay_ms");
    expect(slugify(renderedText("E-E-A-T signals"))).toBe("e-e-a-t-signals");
  });

  test("headings inside a code fence are not anchors", () => {
    expect(
      anchorsOf("```bash\n# not a heading\n```\n## Real\n").has("not-a-heading")
    ).toBe(false);
  });

  test("a longer fence only closes on a fence at least as long", () => {
    const ids = anchorsOf("````md\n```\n## Inside\n```\n````\n## Outside\n");
    expect([...ids]).toEqual(["outside"]);
  });

  test("repeats follow github-slugger, entities decode, a heading in JSX counts", () => {
    const ids = anchorsOf(
      "## x\n## x\n## x-1\n## Fish &amp; Chips\n<Note>\n  ### Inside a note\n</Note>\n"
    );
    expect([...ids]).toEqual([
      "x",
      "x-1",
      "x-1-1",
      "fish--chips",
      "inside-a-note",
    ]);
  });

  test("reference links, other entities and longer code spans render as the site does", () => {
    expect(slugify(renderedText("[Install][setup] guide"))).toBe(
      "install-guide"
    );
    expect(slugify(renderedText("Fish &copy; Chips"))).toBe("fish--chips");
    expect(() => renderedText("Sample &#x110000;")).not.toThrow();
    expect(slugify(renderedText("The ``a `b` c`` span"))).toBe(
      "the-a-b-c-span"
    );
    expect(slugify(renderedText("Tags <kbd>Ctrl</kbd> here"))).toBe(
      "tags-ctrl-here"
    );
    expect(renderedText("a <b<i>> c")).not.toMatch(/[<>]/);
  });

  test("a marker only becomes the id at the end of the heading", () => {
    const ids = anchorsOf("## Label \\{#old\\} more\n## Code `{#code}`\n");
    expect(ids.has("old")).toBe(false);
    expect(ids.has("code")).toBe(false);
    expect(ids.has("label-old-more")).toBe(true);
  });

  test("id attributes and <a name> are anchors, data-id is not", () => {
    const ids = anchorsOf(
      '<a name="legacy"></a>\n<div data-id="fake" />\n<div id = "spaced" />\n'
    );
    expect([...ids].sort()).toEqual(["legacy", "spaced"]);
  });
});

describe("checkDocs", () => {
  test("passes a page whose links all resolve", () => {
    const root = docs({
      "guides/setup.mdx": GUIDE,
      "guides/index.mdx": "# Guides\n",
      "images/logo.png": "png",
      "docs.json": JSON.stringify({
        redirects: [{ source: "/old-guide", destination: "/guides/setup" }],
      }),
      "index.mdx": [
        "[setup](/guides/setup) [repeat](/guides/setup#getting-started-1)",
        "[code](/guides/setup#max_pages) [dashes](/guides/setup#fresh-crawl-refresh)",
        "[explicit](/guides/setup#tiers) [attribute](/guides/setup#custom-target)",
        "[index form](/guides/index) [md form](/guides/setup.md) [dir](/guides/)",
        "[redirect](/old-guide) ![logo](/images/logo.png) [external](https://example.com/nope)",
        '<Card title="Setup" href="/guides/setup#tiers">Setup</Card>',
        "[mail](mailto:hi@example.com) [self](#here)",
        "",
        "## Here",
      ].join("\n"),
    });
    expect(messages(root)).toEqual([]);
  });

  test("fails on a link to a page that does not exist, absolute or relative", () => {
    const root = docs({
      "rules/perf/lcp.mdx":
        "# LCP\n\n[cls](./cls) [perf](/rules/performance/lcp)\n",
    });
    expect(messages(root)).toEqual([
      "rules/perf/lcp.mdx:3: dead link ./cls",
      "rules/perf/lcp.mdx:3: dead link /rules/performance/lcp",
    ]);
  });

  test("checks a nested section named scripts, and matches redirect patterns", () => {
    const root = docs({
      "guides/scripts/index.mdx": "# Scripts\n\n[gone](/nowhere)\n",
      _redirects:
        "/old/* /new/:splat 301\n/blog/:slug/amp /blog/:slug 301\n/v*/notes /notes 301\n",
      "index.mdx":
        "[a](/old/x/y) [b](/blog/hello/amp) [c](/v2/notes) [d](/blog/a/b/amp)\n",
    });
    expect(messages(root)).toEqual([
      "index.mdx:1: dead link /blog/a/b/amp",
      "guides/scripts/index.mdx:3: dead link /nowhere",
    ]);
  });

  test("fails on an anchor the target page does not render, cross-page and same-page", () => {
    const root = docs({
      "guides/setup.mdx": GUIDE,
      "index.mdx":
        '[old](/guides/setup#service-tiers)\n\n[top](#nowhere)\n\n<Link href="/guides/setup#gone">x</Link>\n',
    });
    expect(messages(root)).toEqual([
      "index.mdx:1: dead anchor /guides/setup#service-tiers: /guides/setup has no #service-tiers",
      "index.mdx:3: dead anchor #nowhere: / has no #nowhere",
      "index.mdx:5: dead anchor /guides/setup#gone: /guides/setup has no #gone",
    ]);
  });

  test("checks reference definitions and spaced JSX href", () => {
    const root = docs({
      "index.mdx":
        '[dead][ref]\n\n[ref]: /missing\n\n<Card href = "/also-missing" />\n',
    });
    expect(messages(root)).toEqual([
      "index.mdx:3: dead link /missing",
      "index.mdx:5: dead link /also-missing",
    ]);
  });

  test("ignores links in code fences, inline code, MDX comments and frontmatter", () => {
    const root = docs({
      "index.mdx": [
        "---",
        "description: see [x](/missing)",
        "---",
        "Use `[text](/missing)` in markdown.",
        "Or ``Use `x` and [example](/missing)`` with backticks inside.",
        "```md",
        "[text](/missing#anchor)",
        "```",
        "````md",
        "```",
        "[nested](/missing)",
        "```",
        "````",
        "{/* [hidden](/missing) */}",
        "{/*",
        "[hidden too](/missing)",
        "*/}",
        "[after](#here)",
        "## Here",
      ].join("\n"),
    });
    expect(messages(root)).toEqual([]);
  });

  test("a long run of brackets does not stall the link scan", () => {
    const started = performance.now();
    docs({ "index.mdx": `${"[".repeat(50_000)}\n` });
    expect(messages(root)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("fails when a required anchor disappears", () => {
    const root = docs({
      "guides/failed-audits.mdx": "## DNS lookup failed \\{#dns\\}\n",
    });
    expect(messages(root, ["/guides/failed-audits#dns"])).toEqual([]);
    expect(
      messages(root, [
        "/guides/failed-audits#tls",
        "/cloud/firewall#cloudflare-access",
      ])
    ).toEqual([
      "scripts/required-anchors.json:1: required anchor /guides/failed-audits#tls is missing (linked from outside the docs)",
      "scripts/required-anchors.json:1: required anchor /cloud/firewall#cloudflare-access is missing (linked from outside the docs)",
    ]);
  });

  test("fails on a rule page Options row that prints unknown or undefined (#319)", () => {
    const table = (type: string, value: string) =>
      `# Rule\n\n## Options\n\n| Option | Type | Default |\n|---|---|---|\n| \`limit\` | ${type} | ${value} |\n\n## Other\n`;
    expect(
      messages(docs({ "rules/x/y.mdx": table("number", "`10`") }))
    ).toEqual([]);
    expect(
      messages(docs({ "rules/x/y.mdx": table("unknown", "`undefined`") }))
    ).toEqual([
      "rules/x/y.mdx:7: Options row prints `unknown` (Type) or `undefined` (Default): write its type and default from the rule's schema",
    ]);
  });

  test("reads only the Type and Default columns of an Options table", () => {
    const page = [
      "# Rule",
      "",
      "## Options",
      "",
      "| Option | Default | Type | Description |",
      "| --- | --- | --- | --- |",
      "| `mode` | `unknown` | string | unknown |",
      "| `when` | `undefined` | boolean | Set it |",
    ].join("\n");
    expect(messages(docs({ "rules/x/y.mdx": page }))).toEqual([
      "rules/x/y.mdx:8: Options row prints `unknown` (Type) or `undefined` (Default): write its type and default from the rule's schema",
    ]);
  });
});
