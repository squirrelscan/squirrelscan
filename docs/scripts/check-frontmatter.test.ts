import { describe, expect, test } from "bun:test";
import { checkFrontmatter, readFrontmatter } from "./check-frontmatter";

const okTitle = "Empty headings: what counts and how to fix";
const okDesc = "How squirrelscan finds headings with no text and what to change so screen readers get an outline.";
const page = (file: string, title: unknown, description: unknown) => ({ file, title, description });

describe("checkFrontmatter", () => {
  test("accepts a page inside the bounds", () => {
    expect(checkFrontmatter([page("a.mdx", okTitle, okDesc)])).toEqual([]);
  });
  test("flags short and long titles", () => {
    expect(checkFrontmatter([page("a.mdx", "Short", okDesc)])).toHaveLength(1);
    expect(checkFrontmatter([page("a.mdx", "x".repeat(61), okDesc)])).toHaveLength(1);
  });
  test("flags descriptions outside 70-155 and em dashes", () => {
    expect(checkFrontmatter([page("a.mdx", okTitle, "Too short.")])).toHaveLength(1);
    expect(checkFrontmatter([page("a.mdx", okTitle, `${okDesc} ${"y".repeat(80)}`)])).toHaveLength(1);

    expect(checkFrontmatter([page("a.mdx", okTitle, okDesc.replace("and what", "— and what"))])).toHaveLength(1);
  });
  test("flags a lowercase description start", () => {
    expect(checkFrontmatter([page("a.mdx", okTitle, okDesc.toLowerCase())])).toHaveLength(1);
  });
  test("flags duplicate titles case-insensitively", () => {
    const out = checkFrontmatter([page("a.mdx", okTitle, okDesc), page("b.mdx", okTitle.toUpperCase(), okDesc)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("duplicates a.mdx");
  });
  test("flags missing fields", () => {
    expect(checkFrontmatter([page("a.mdx", undefined, undefined)])).toHaveLength(2);
  });
});

describe("readFrontmatter", () => {
  test("reads quoted and block scalar values", () => {
    const src = `---\ntitle: "A: b"\ndescription: >-\n  one\n  two\n---\nbody`;
    const p = readFrontmatter("a.mdx", src);
    expect(p.title).toBe("A: b");
    expect(p.description).toBe("one two");
  });
});
