import { describe, expect, test } from "bun:test";

import { stripHtmlForText } from "../src/html-text";

describe("stripHtmlForText", () => {
  test("drops comments, tags, and excluded element bodies", () => {
    const html =
      "<main>Hello<!-- hidden --><script>bad()</script ><style>nope</style><p>world</p></main>";
    expect(
      stripHtmlForText(html, { exclude: ["script", "style"] })
        .replace(/\s+/g, " ")
        .trim(),
    ).toBe("Hello world");
  });

  test("handles malformed repeated opening tags without backtracking", () => {
    const html = `<script>${"<script>".repeat(20_000)}`;
    expect(stripHtmlForText(html, { exclude: ["script"] }).trim()).toBe("");
  });
});
