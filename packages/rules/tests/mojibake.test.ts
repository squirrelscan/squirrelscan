// content/mojibake: encoding corruption a reader can actually see.
//
// The rule's whole risk is false positives on legitimate non-English copy, so the
// clean-accents fixture matters more than any of the detection cases.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { declaredCharset, findMojibake, mojibakeRule } from "../src/content/mojibake";
import type { ParsedPage, RuleContext } from "../src/types";

function run(html: string) {
  const { document } = parseHTML(html);
  const ctx: RuleContext = {
    page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document } as unknown as ParsedPage,
    options: {},
  };
  return mojibakeRule.run(ctx).checks;
}

const page = (body: string, head = '<meta charset="utf-8">') =>
  `<html><head>${head}</head><body>${body}</body></html>`;

describe("findMojibake", () => {
  test("detects the utf8-as-latin1 family", () => {
    const found = findMojibake("Itâ€™s a â€œquoteâ€ and a cafÃ©");
    expect(found.find((f) => f.kind === "utf8-as-latin1")).toBeDefined();
  });

  // The prefix trap: `â€` is a prefix of `â€™`/`â€œ`/`â€“`/`â€”`/`â€¦`, so counting each
  // sequence independently counts every long one twice. Longest-first alternation fixes it.
  test("a long sequence is counted once, not also as its own prefix", () => {
    const one = findMojibake("Itâ€™s").find((f) => f.kind === "utf8-as-latin1");
    expect(one?.count).toBe(1);
    const three = findMojibake("aâ€™b â€œc â€“d").find((f) => f.kind === "utf8-as-latin1");
    expect(three?.count).toBe(3);
  });

  test("detects the replacement character", () => {
    const found = findMojibake("caf�");
    expect(found.find((f) => f.kind === "replacement-char")?.count).toBe(1);
  });

  test("detects literally-rendered double-encoded entities", () => {
    const found = findMojibake("hello&amp;nbsp;world and &amp;quot;quoted&amp;quot;");
    expect(found.find((f) => f.kind === "double-encoded-entity")?.count).toBe(3);
  });

  test("clean text of every kind yields nothing", () => {
    expect(findMojibake("Perfectly ordinary copy.")).toEqual([]);
    // Correctly-decoded accents, curly quotes and symbols: the false positive that matters.
    expect(findMojibake("Un café à Paris — “élan”, naïve, jalapeño, 25° © 2026")).toEqual([]);
  });
});

describe("declaredCharset", () => {
  test("reads <meta charset> and the http-equiv form", () => {
    const a = parseHTML('<html><head><meta charset="UTF-8"></head><body></body></html>').document;
    expect(declaredCharset(a)).toBe("utf-8");
    const b = parseHTML(
      '<html><head><meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1"></head><body></body></html>',
    ).document;
    expect(declaredCharset(b)).toBe("iso-8859-1");
  });
  test("absent when nothing is declared", () => {
    const doc = parseHTML("<html><head></head><body></body></html>").document;
    expect(declaredCharset(doc)).toBeUndefined();
  });
});

describe("mojibakeRule", () => {
  test("clean page passes", () => {
    expect(run(page("<p>Ordinary copy.</p>"))[0]?.status).toBe("pass");
  });

  test("legitimate accented copy declared as utf-8 stays clean", () => {
    // A rule that flagged this would be unusable on any non-English site.
    const [check] = run(
      page("<p>Un café à Paris. Grüße aus Köln. El niño jugó. 25° © 2026 “élan”</p>"),
    );
    expect(check?.status).toBe("pass");
  });

  test("mojibake warns", () => {
    const [check] = run(page("<p>Itâ€™s a cafÃ©</p>"));
    expect(check?.status).toBe("warn");
    expect(check?.value).toBe(2);
  });

  test("the replacement character escalates to fail", () => {
    // U+FFFD is not arguable: the decoder already gave up.
    const [check] = run(page("<p>caf�</p>"));
    expect(check?.status).toBe("fail");
  });

  test("cause is attributed: missing charset names the declaration fix", () => {
    const [check] = run(page("<p>Itâ€™s</p>", ""));
    expect(check?.message).toMatch(/no charset is declared/i);
    expect(check?.message).toMatch(/meta charset/i);
    expect((check?.details as { charset: string | null } | undefined)?.charset).toBeNull();
  });

  test("cause is attributed: correct utf-8 points at a double-encoded source", () => {
    const [check] = run(page("<p>Itâ€™s</p>"));
    expect(check?.message).toMatch(/double-encoded/i);
    expect(check?.message).toMatch(/re-import/i);
  });

  test("cause is attributed: a wrong charset names the declaration", () => {
    const [check] = run(page("<p>Itâ€™s</p>", '<meta charset="iso-8859-1">'));
    expect(check?.message).toMatch(/iso-8859-1/);
    expect(check?.message).toMatch(/not utf-8/i);
  });

  test("script and style contents are not visible text", () => {
    const [check] = run(
      page('<script>var s = "Itâ€™s";</script><style>/* cafÃ© */</style><p>Clean.</p>'),
    );
    expect(check?.status).toBe("pass");
  });

  // The rule fired on the release note that ANNOUNCED it, because that note quotes
  // the sequences it detects inside <code>. A code span is markup for "this is a
  // literal": the page is documenting the corruption, not suffering from it.
  describe("code-like elements are quoted literals, not prose", () => {
    test("mojibake only inside <code> passes", () => {
      const [check] = run(page("<p>Catches garbled sequences like <code>â€™</code>.</p>"));
      expect(check?.status).toBe("pass");
    });

    test("mojibake only inside <pre> passes", () => {
      const [check] = run(page("<pre>Itâ€™s a cafÃ©</pre>"));
      expect(check?.status).toBe("pass");
    });

    test("<samp> and <kbd> are excluded too", () => {
      const [check] = run(page("<p><samp>cafÃ©</samp> then <kbd>â€œ</kbd></p>"));
      expect(check?.status).toBe("pass");
    });

    test("a <code> span nested mid-sentence does not leak into the prose scan", () => {
      const [check] = run(page("<p>text <code>Ã©</code> more</p>"));
      expect(check?.status).toBe("pass");
    });

    test("a quoted <code> sample plus one real prose hit counts exactly one", () => {
      const [check] = run(page("<p>Quotes <code>â€™</code> but Itâ€™s broken here.</p>"));
      expect(check?.status).toBe("warn");
      expect(check?.value).toBe(1);
    });

    test("code exclusion applies to the whole subtree, not just direct text", () => {
      const [check] = run(page("<pre><span><em>Itâ€™s</em></span></pre><p>Clean.</p>"));
      expect(check?.status).toBe("pass");
    });

    test("prose siblings of a code block are still read", () => {
      const [check] = run(page("<pre>clean sample</pre><p>Itâ€™s broken</p>"));
      expect(check?.status).toBe("warn");
      expect(check?.value).toBe(1);
    });

    test("the replacement character inside code does not escalate to fail", () => {
      const [check] = run(page("<p>Renders as <code>caf�</code>.</p>"));
      expect(check?.status).toBe("pass");
    });

    // Skipping a subtree GLUES its neighbours: without a boundary, the `Ã` before
    // the code span and the `©` after it concatenate into `Ã©` — a sequence present
    // in neither fragment. Excluding code must not invent corruption.
    test("skipping a code span does not glue its neighbours into a sequence", () => {
      const [check] = run(page("<p>Ã<code>literal</code>©</p>"));
      expect(check?.status).toBe("pass");
    });

    // The boundary must be a newline, NOT a space: `Ã ` (à) and `Â ` (nbsp) are
    // themselves mojibake sequences, so a space boundary would trade one false
    // positive for another. This fixture fails if anyone "simplifies" it to " ".
    test("the boundary itself cannot form a sequence with the text before it", () => {
      expect(run(page("<p>Ã<code>sample</code></p>"))[0]?.status).toBe("pass");
      expect(run(page("<p>Â<pre>sample</pre></p>"))[0]?.status).toBe("pass");
    });

    test("reading a code block does not mutate the shared DOM", () => {
      const { document } = parseHTML(page("<p>a <code>Ã©</code> b</p>"));
      const before = document.querySelectorAll("code").length;
      mojibakeRule.run({
        page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
        parsed: { document } as unknown as ParsedPage,
        options: {},
      } as RuleContext);
      expect(document.querySelectorAll("code").length).toBe(before);
    });
  });

  // Reachable: linkedom does NOT synthesize a <body>, so a head-only document really
  // does reach the rule with nothing to read. Skipped, not passed — "we could not look"
  // must never be recorded as "we looked and it was fine".
  test("no body is skipped, not passed", () => {
    const [check] = run("<html><head><meta charset='utf-8'></head></html>");
    expect(check?.status).toBe("skipped");
    expect(check?.skipReason).toBe("no-body");
  });

  test("no document is skipped", () => {
    const ctx = {
      page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: { document: null } as unknown as ParsedPage,
      options: {},
    } as RuleContext;
    const [check] = mojibakeRule.run(ctx).checks;
    expect(check?.status).toBe("skipped");
  });
});
