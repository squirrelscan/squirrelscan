// The unreachable-start-URL report must not carry credentials or tokens that the probe's error
// text echoes: userinfo, a query token and a fragment are removed from the reason, the message
// and every rendered format.

import { redactUrlsInText } from "@squirrelscan/core-contracts/seed-redirect";
import { describe, expect, test } from "bun:test";

import {
  renderUnreachableOutcome,
  unreachableOutcome,
} from "@/cli/unreachable";

const SECRETS = ["user", "secret", "abc", "frag"];
const REASON =
  "getaddrinfo ENOTFOUND while fetching https://user:secret@host.example/p?token=abc#frag (retry later).";

function leaks(text: string): string[] {
  return SECRETS.filter((word) => text.includes(word));
}

describe("unreachable outcome redaction", () => {
  test("json, xml, llm and console output carry none of the credentials in the reason", () => {
    const outcome = unreachableOutcome(
      "https://user:secret@host.example/p?token=abc#frag",
      REASON
    );
    for (const format of ["json", "xml", "llm", "console", undefined]) {
      const text = renderUnreachableOutcome(outcome, format);
      expect(leaks(text)).toEqual([]);
    }
    expect(outcome.statusReason).toContain("https://host.example/p");
    expect(outcome.message).toContain("https://host.example/p");
  });

  test("redactUrlsInText handles several URLs, quotes, brackets, case and trailing punctuation", () => {
    expect(
      redactUrlsInText(
        'a "HTTP://u:p@x.example/a?k=v" b (https://y.example/b?t=1), https://z.example/c#h.'
      )
    ).toBe(
      'a "http://x.example/a" b (https://y.example/b), https://z.example/c.'
    );
    expect(redactUrlsInText("no url here, only text: 127.0.0.1:80")).toBe(
      "no url here, only text: 127.0.0.1:80"
    );
    // A token that is not a URL becomes the fixed placeholder, never the raw text.
    expect(redactUrlsInText("see http://[bad")).toBe("see (unprintable URL)");
  });

  test("a megabyte of text with no URL, and one of repeated schemes, stays linear", () => {
    const start = performance.now();
    redactUrlsInText("x".repeat(1_000_000));
    redactUrlsInText("http://".repeat(100_000));
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
