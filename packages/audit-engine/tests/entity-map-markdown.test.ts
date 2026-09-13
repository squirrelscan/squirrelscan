// The markdown view is what a coding agent reads, so it has to lead with the
// findings and stay a valid table when a site puts a pipe in an entity name.

import { describe, expect, test } from "bun:test";

import { buildEntityMap, renderEntityMapMarkdown } from "../src/entity-map";

const SITE = "https://example.com/";
const AT = "2026-01-01T00:00:00.000Z";

function render(pages: { url: string; raw: string | null }[]): string {
  return renderEntityMapMarkdown(buildEntityMap(pages, SITE, { generatedAt: AT }));
}

function page(url: string, jsonLd: unknown) {
  return { url, raw: JSON.stringify(jsonLd) };
}

describe("renderEntityMapMarkdown", () => {
  test("carries the summary and the largest entities", () => {
    const organization = {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": "https://example.com/#org",
      name: "Acme",
    };
    const markdown = render([
      page("https://example.com/", organization),
      page("https://example.com/about", organization),
    ]);

    expect(markdown).toContain("# Entity map");
    expect(markdown).toContain("https://example.com/");
    expect(markdown).toContain("squirrelscan/entity-map v1");
    expect(markdown).toContain("| Entities | 1 |");
    expect(markdown).toContain("| Pages crawled | 2 |");
    expect(markdown).toContain("| Entities with a stable @id | 1 (100%) |");
    expect(markdown).toContain("## Largest entities");
    expect(markdown).toContain("| Organization | Acme | https://example.com/#org | 2 | 2 |");
  });

  test("reports a conflict with its values and pages", () => {
    const organization = (logo: string) => ({
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": "https://example.com/#org",
      name: "Acme",
      logo,
    });
    const markdown = render([
      page("https://example.com/a", organization("https://example.com/a.png")),
      page("https://example.com/b", organization("https://example.com/b.png")),
    ]);

    expect(markdown).toContain("### Conflicting properties (1)");
    expect(markdown).toContain("`logo` has 2 values");
    expect(markdown).toContain("https://example.com/a.png");
    expect(markdown).toContain("https://example.com/b.png");
  });

  test("reports a dangling reference in its own table", () => {
    const markdown = render([
      page("https://example.com/post", {
        "@context": "https://schema.org",
        "@type": "Article",
        "@id": "https://example.com/post#article",
        headline: "A post",
        publisher: { "@id": "https://example.com/#organization" },
      }),
    ]);

    expect(markdown).toContain("### Dangling references (1)");
    expect(markdown).toContain("| publisher | https://example.com/#organization | 1 |");
  });

  test("names the entities declared on several pages with no @id", () => {
    const organization = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Acme Widgets",
    };
    const markdown = render([
      page("https://example.com/a", organization),
      page("https://example.com/b", organization),
      page("https://example.com/c", organization),
    ]);

    expect(markdown).toContain("### Entities without an @id (1)");
    expect(markdown).toContain("| Organization | Acme Widgets | 3 | 3 |");
    expect(markdown).toContain("https://your.site/#organization");
  });

  test("says so plainly when each findings section is clean", () => {
    const markdown = render([
      page("https://example.com/", {
        "@context": "https://schema.org",
        "@type": "Organization",
        "@id": "https://example.com/#org",
        name: "Acme",
      }),
    ]);

    expect(markdown).toContain("No entity disagrees with itself across pages.");
    expect(markdown).toContain("Every `@id` reference points at an entity some page declares.");
    expect(markdown).toContain("Every entity declared on more than one page carries an `@id`.");
  });

  test("a pipe or a newline in a name cannot break the table", () => {
    const markdown = render([
      page("https://example.com/", {
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "Ac|me\nWidgets | Inc",
      }),
    ]);

    expect(markdown).toContain("Ac\\|me Widgets \\| Inc");
    // The row keeps the five cells its header declared: only the escaped pipes
    // came from the site, and markdown does not treat those as separators.
    const row = markdown
      .split("\n")
      .find((line) => line.includes("Ac\\|me"));
    expect(row).toBeDefined();
    const separators = row!.replace(/\\\|/g, "").split("|");
    expect(separators.length).toBe(7);
  });

  test("a backslash before a pipe cannot smuggle a live separator through", () => {
    // Escaping the pipe without escaping the backslash first turns a site's
    // literal `\|` into `\\|`, which markdown reads as an escaped backslash
    // followed by a LIVE pipe, and the row gains a column.
    const markdown = render([
      page("https://example.com/", {
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "Acme \\| Inc",
      }),
    ]);

    const row = markdown.split("\n").find((line) => line.includes("Acme"));
    expect(row).toBeDefined();
    expect(row).toContain("Acme \\\\\\| Inc");
    const separators = row!.replace(/\\\\/g, "").replace(/\\\|/g, "").split("|");
    expect(separators.length).toBe(7);
  });

  test("a name that clips mid-escape cannot leave a trailing backslash", () => {
    const markdown = render([
      page("https://example.com/", {
        "@context": "https://schema.org",
        "@type": "Organization",
        name: `${"a".repeat(200)}\\`,
      }),
    ]);

    const row = markdown.split("\n").find((line) => line.includes("aaa"));
    expect(row).toBeDefined();
    // Whatever the clip did, every cell separator is still a bare pipe.
    const separators = row!.replace(/\\\\/g, "").replace(/\\\|/g, "").split("|");
    expect(separators.length).toBe(7);
  });

  test("an empty map says there is nothing to read instead of empty tables", () => {
    const markdown = render([{ url: "https://example.com/", raw: null }]);

    expect(markdown).toContain("declares no JSON-LD entities");
    expect(markdown).not.toContain("Largest entities");
    expect(markdown).not.toContain("Conflicting properties");
    expect(markdown).not.toContain("Dangling references");
    expect(markdown).not.toContain("| Metric | Value |");
  });

  test("is deterministic for a given map", () => {
    const pages = [
      page("https://example.com/b", {
        "@context": "https://schema.org",
        "@type": "Person",
        name: "Ada",
      }),
      page("https://example.com/a", {
        "@context": "https://schema.org",
        "@type": "Person",
        name: "Ada",
      }),
    ];
    expect(render(pages)).toBe(render(pages));
    expect(render([...pages].reverse())).toBe(render(pages));
  });
});
