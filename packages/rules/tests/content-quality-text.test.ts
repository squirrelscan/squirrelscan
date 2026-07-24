import { describe, expect, test } from "bun:test";

import { extractTextFromHtml } from "../src/content/quality";

describe("content quality text extraction", () => {
  test("decodes source entities once and collapses whitespace", () => {
    const html = "<main>A &amp; B &lt; C &amp;lt; D\n\tE</main>";
    expect(extractTextFromHtml(html)).toBe("A & B < C &lt; D E");
  });

  test("drops excluded element bodies", () => {
    expect(extractTextFromHtml("<main>Keep<script>drop()</script> this</main>")).toBe(
      "Keep this",
    );
  });
});
