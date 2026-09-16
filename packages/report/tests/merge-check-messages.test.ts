// The exported merged-message API (#2231, #2246).
//
// `packages/report` and the cloud API group the same findings from different
// stores. The API had its own copy of the old `\d+ -> N` rule, so one finding
// printed two different sentences depending on which surface you read. These
// tests pin the exported contract both surfaces now call.

import { describe, expect, test } from "bun:test";

import { mergeCheckMessages, messageMergeKey } from "../src/message-merge";
import { groupIssuesByCategory } from "../src/grouping";
import type { ReportRuleResult } from "../src/types";

const thin = (words: number) => `Thin content: ${words} words (min 300)`;

describe("mergeCheckMessages", () => {
  test("no messages have no merged text", () => {
    expect(mergeCheckMessages([])).toBeNull();
  });

  test("one message is its own merged text", () => {
    expect(mergeCheckMessages([thin(197)])).toBe(thin(197));
  });

  test("messages that agree print exactly what they said", () => {
    expect(mergeCheckMessages([thin(197), thin(197), thin(197)])).toBe(thin(197));
  });

  test("a count they disagree on becomes the range it covers", () => {
    expect(mergeCheckMessages([thin(197), thin(233)])).toBe(
      "Thin content: 197 to 233 words (min 300)"
    );
  });

  test("the range spans every message, not just the first and last", () => {
    expect(mergeCheckMessages([thin(233), thin(197), thin(400)])).toBe(
      "Thin content: 197 to 400 words (min 300)"
    );
  });

  // The property the cloud API's `min(message)`/`max(message)` pair cannot
  // give it: sorted as TEXT, "10000 words" precedes "197 words", so the two
  // lexicographic extremes are 10000 and 400, and a range built from that pair
  // would exclude 197 while reading as though it covered everything.
  test("the range is numeric, not lexicographic, across digit lengths", () => {
    expect(mergeCheckMessages([thin(10000), thin(197), thin(400)])).toBe(
      "Thin content: 197 to 10000 words (min 300)"
    );
    // The pair a lexicographic min/max hands it, on its own, is a range that
    // does not cover 197. The input matters, not just the helper.
    expect(mergeCheckMessages([thin(10000), thin(400)])).toBe(
      "Thin content: 400 to 10000 words (min 300)"
    );
  });

  // A four-digit value between 1000 and 2999 is indistinguishable from a year,
  // so it is never treated as a count. A real consequence for callers: a group
  // whose word counts straddle that band does not merge at all, and each
  // message keeps its own text rather than becoming a range that might be a
  // date. Pinned because it surprises, not because it is wrong.
  test("a count that lands in the year band stops the group merging", () => {
    expect(mergeCheckMessages([thin(197), thin(1200)])).toBeNull();
    expect(messageMergeKey(thin(197))).not.toBe(messageMergeKey(thin(1200)));
    // Either side of the band is a count again.
    expect(mergeCheckMessages([thin(197), thin(3200)])).toBe(
      "Thin content: 197 to 3200 words (min 300)"
    );
  });

  test("the merge does not depend on the order it is given", () => {
    const forward = mergeCheckMessages([thin(197), thin(233), thin(400)]);
    const backward = mergeCheckMessages([thin(400), thin(233), thin(197)]);
    expect(forward).toBe(backward);
    expect(forward).toBe("Thin content: 197 to 400 words (min 300)");
  });

  test("counts they agree on stay literal while one they disagree on widens", () => {
    expect(
      mergeCheckMessages([
        "Title too long (65 chars, max 60)",
        "Title too long (114 chars, max 60)",
      ])
    ).toBe("Title too long (65 to 114 chars, max 60)");
  });

  test("a count that agrees keeps the digits it was written with", () => {
    // Not re-rendered through Number: a leading-zero or padded form that every
    // page agrees on comes back byte-identical.
    expect(mergeCheckMessages(["Code 007 seen 3 times", "Code 007 seen 5 times"])).toBe(
      "Code 007 seen 3 to 5 times"
    );
  });

  describe("messages that must not merge come back null", () => {
    test("a year is not a count", () => {
      expect(
        mergeCheckMessages(["The URL says 2019", "The URL says 2024"])
      ).toBeNull();
    });

    test("a digit inside a word is not a count", () => {
      expect(
        mergeCheckMessages(["Multiple H1 tags found", "Multiple H2 tags found"])
      ).toBeNull();
    });

    test("a decimal is not a count", () => {
      expect(
        mergeCheckMessages(["HTML is 4.3MB", "HTML is 7.1MB"])
      ).toBeNull();
    });

    test("a ratio is not a count", () => {
      expect(
        mergeCheckMessages(["4/10 pages blocked", "7/10 pages blocked"])
      ).toBeNull();
    });

    test("different wording is not a disagreement about a count", () => {
      expect(
        mergeCheckMessages(["Thin content: 197 words", "Sparse content: 197 words"])
      ).toBeNull();
    });

    test("one message out of many is enough to refuse", () => {
      expect(
        mergeCheckMessages([thin(197), thin(233), "The URL says 2019"])
      ).toBeNull();
    });
  });
});

describe("messageMergeKey", () => {
  test("messages differing only in counts share a key", () => {
    expect(messageMergeKey(thin(197))).toBe(messageMergeKey(thin(233)));
  });

  test("messages that differ in anything else do not", () => {
    expect(messageMergeKey("Multiple H1 tags found")).not.toBe(
      messageMergeKey("Multiple H2 tags found")
    );
    expect(messageMergeKey("The URL says 2019")).not.toBe(
      messageMergeKey("The URL says 2024")
    );
    expect(messageMergeKey("Thin content: 197 words")).not.toBe(
      messageMergeKey("Sparse content: 197 words")
    );
  });

  // The two exports are one decision seen twice: the key says whether a merge
  // is possible, the merge says what it produces. A caller keying on one and
  // merging with the other must never get a contradiction.
  test("the key agrees with the merge on every pair", () => {
    const corpus = [
      thin(197),
      thin(233),
      thin(1000),
      "Title too long (65 chars, max 60)",
      "Title too long (114 chars, max 60)",
      "Multiple H1 tags found",
      "Multiple H2 tags found",
      "The URL says 2019",
      "The URL says 2024",
      "HTML is 4.3MB",
      "Code 007 seen 3 times",
      "4/10 pages blocked",
    ];
    for (const a of corpus) {
      for (const b of corpus) {
        const sameKey = messageMergeKey(a) === messageMergeKey(b);
        const merged = mergeCheckMessages([a, b]);
        expect(merged === null).toBe(!sameKey);
      }
    }
  });
});

describe("the export is what the report itself uses", () => {
  const ruleResults = (messages: string[]): Record<string, ReportRuleResult> => ({
    "content/thin": {
      ruleId: "content/thin",
      meta: { id: "content/thin", name: "Thin", category: "content", severity: "warning" },
      checks: messages.map((message, i) => ({
        name: "thin-content",
        status: "warn" as const,
        message,
        pageUrl: `https://example.com/p${i}`,
      })),
    } as unknown as ReportRuleResult,
  });

  const reportMessages = (messages: string[]): string[] =>
    groupIssuesByCategory(ruleResults(messages))
      .flatMap((c) => c.rules)
      .flatMap((r) => r.checks)
      .map((c) => c.message);

  test("a mergeable set renders one check, with the export's text", () => {
    const messages = [thin(197), thin(233), thin(400)];
    expect(reportMessages(messages)).toEqual([mergeCheckMessages(messages)!]);
  });

  test("an unmergeable set stays split, which is what null means", () => {
    const messages = ["Multiple H1 tags found", "Multiple H2 tags found"];
    expect(mergeCheckMessages(messages)).toBeNull();
    // The report keeps both, each with its own true text.
    expect(reportMessages(messages).sort()).toEqual([...messages].sort());
  });
});
