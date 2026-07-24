// Visible byline / date extraction — org-noise suppression.
//
// Covers issue #138: a bare "Editor"/"Editorial" byline (a WP Editor-role user
// with no full name) is org-noise like "Admin" and must be suppressed, while a
// byline that merely contains the word ("Jane Smith, Editor", "Jane (Editor)")
// is a real attribution and must be kept. Also guards that the existing
// ORG_AUTHOR_NOISE entries (admin/webmaster/etc.) still behave unchanged.

import { describe, expect, test } from "bun:test";

import { extractVisibleMeta, parseDocument } from "../src/index";

// Wrap a byline value in a genuine article/entry container so it clears the
// isInArticleContext guard — the suppression logic is what's under test here.
function articleWithAuthor(author: string): string {
  return `<html><body>
    <article class="post type-post">
      <header class="entry-header">
        <span class="author vcard"><span class="fn">${author}</span></span>
      </header>
      <div class="entry-content"><p>Body.</p></div>
    </article>
  </body></html>`;
}

function visibleAuthor(author: string): string | null {
  return extractVisibleMeta(parseDocument(articleWithAuthor(author))).visibleAuthor;
}

describe("extractVisibleMeta — bare Editor byline suppression (#138)", () => {
  test("bare 'Editor' is suppressed", () => {
    expect(visibleAuthor("Editor")).toBeNull();
  });

  test("'Editorial' is suppressed", () => {
    expect(visibleAuthor("Editorial")).toBeNull();
  });

  test("case-insensitive: 'EDITOR' / 'editor' suppressed", () => {
    expect(visibleAuthor("EDITOR")).toBeNull();
    expect(visibleAuthor("editor")).toBeNull();
  });

  test("surrounding whitespace still suppressed (cleaned before match)", () => {
    expect(visibleAuthor("  Editor  ")).toBeNull();
  });

  test("'Jane Smith, Editor' is retained", () => {
    expect(visibleAuthor("Jane Smith, Editor")).toBe("Jane Smith, Editor");
  });

  test("'Jane (Editor)' is retained", () => {
    expect(visibleAuthor("Jane (Editor)")).toBe("Jane (Editor)");
  });

  test("'Edited by the Editor' is retained", () => {
    expect(visibleAuthor("Edited by the Editor")).toBe("Edited by the Editor");
  });
});

describe("extractVisibleMeta — existing ORG_AUTHOR_NOISE unchanged", () => {
  test("'Admin' still suppressed", () => {
    expect(visibleAuthor("Admin")).toBeNull();
  });

  test("'Webmaster' still suppressed", () => {
    expect(visibleAuthor("Webmaster")).toBeNull();
  });

  test("'Editorial Team' still suppressed", () => {
    expect(visibleAuthor("Editorial Team")).toBeNull();
  });

  test("a real name is retained", () => {
    expect(visibleAuthor("Jane Doe")).toBe("Jane Doe");
  });
});
