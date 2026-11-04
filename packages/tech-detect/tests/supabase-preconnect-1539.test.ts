// #1539 follow-up: #1539 stopped counting a `<link rel="alternate">` as vendor evidence, which also dropped the only signal a site
// had for supabase: a `preconnect` or `dns-prefetch` to its project origin (a bare origin, no /rest/v1 path). A link that opens a
// connection to a project origin is supabase again; a link that only describes the URL (canonical, alternate), an anchor, a
// placeholder ref and a repeated-character ref are not.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";

const page = (body: string): string => `<!doctype html><html><head><title>t</title>${body}</head><body></body></html>`;
const ids = (html: string): string[] => detectTechnologies({ url: "https://example.com/", headers: {}, html }).map((t) => t.id);
const REF = "abcdefghij0123456789";
const ORIGIN = `https://${REF}.supabase.co`;

describe("a connection hint to a project origin detects supabase", () => {
  test("preconnect and dns-prefetch, as written by a real site", () => {
    expect(ids(page(`<link rel="dns-prefetch" href="${ORIGIN}/"><link rel="preconnect" href="${ORIGIN}/" crossorigin>`))).toContain("supabase");
    expect(ids(page(`<link rel="preconnect" href="${ORIGIN}/" crossorigin>`))).toContain("supabase");
    expect(ids(page(`<link rel="dns-prefetch" href="${ORIGIN}/">`))).toContain("supabase");
  });
  test("with or without the trailing slash, in either attribute order, in any case", () => {
    for (const href of [ORIGIN, `${ORIGIN}/`]) {
      expect(ids(page(`<link rel="preconnect" href="${href}">`))).toContain("supabase");
      expect(ids(page(`<link href="${href}" rel="preconnect">`))).toContain("supabase");
      expect(ids(page(`<LINK REL="DNS-PREFETCH" HREF="${href}">`))).toContain("supabase");
    }
  });
  test("a preload of a project resource still detects", () => {
    expect(ids(page(`<link rel="preload" href="${ORIGIN}/storage/v1/object/public/a/b.png" as="image">`))).toContain("supabase");
  });
});

describe("what is not a connection to a project origin is not supabase", () => {
  test("an alternate or canonical link to a bare origin", () => {
    for (const rel of ["alternate", "canonical", "author", "manifest", ""]) {
      expect([rel, ids(page(`<link rel="${rel}" href="${ORIGIN}/">`))]).toEqual([rel, []]);
    }
    expect(ids(page(`<link rel="alternate" type="application/rss+xml" href="${ORIGIN}/functions/v1/feed">`))).not.toContain("supabase");
  });
  test("an anchor to the bare origin", () => {
    expect(ids(page(`<a href="${ORIGIN}/">x</a><a href="${ORIGIN}">y</a>`))).not.toContain("supabase");
  });
  test("a placeholder ref and a repeated-character ref", () => {
    for (const ref of ["your-project-ref-12345", "yourprojectref123456", `your${"a".repeat(16)}`, "a".repeat(20), "0".repeat(20), "AAAAAAAAAAAAAAAAAAAA"]) {
      expect([ref, ids(page(`<link rel="preconnect" href="https://${ref}.supabase.co/">`))]).toEqual([ref, []]);
    }
  });
  test("a ref of the wrong length, a longer host, another domain and a path", () => {
    for (const href of [
      "https://abcdefghij012345678.supabase.co/",
      "https://abcdefghij01234567890.supabase.co/",
      `https://x.${REF}.supabase.co/`,
      `https://${REF}.supabase.com/`,
      `https://${REF}.supabase.co.example.com/`,
      `http://${REF}.supabase.co/`,
      `${ORIGIN}/docs`,
      `${ORIGIN}?x=1`,
    ]) {
      expect([href, ids(page(`<link rel="preconnect" href="${href}">`))]).toEqual([href, []]);
    }
  });
});
