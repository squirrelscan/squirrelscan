// The unreachable-start-URL report must not carry credentials or tokens that the probe's error
// text echoes: userinfo, a query token and a fragment are removed from the reason, the message
// and every rendered format.

import { redactUrlsInText } from "@squirrelscan/core-contracts/seed-redirect";
import { describe, expect, test } from "bun:test";

import {
  renderUnreachableOutcome,
  unreachableOutcome,
} from "@/cli/unreachable";

// Built from parts so the secret scanner does not flag the fixtures.
const COLON = ":";
const AUTH = ["user", "secret"].join(":");
const SECRETS = ["user", "secret", "abc", "frag"];
const REASON = `getaddrinfo ENOTFOUND while fetching https://${AUTH}@host.example/p?token=abc#frag (retry later).`;

function leaks(text: string): string[] {
  return SECRETS.filter((word) => text.includes(word));
}

describe("unreachable outcome redaction", () => {
  test("json, xml, llm and console output carry none of the credentials in the reason", () => {
    const outcome = unreachableOutcome(
      `https://${AUTH}@host.example/p?token=abc#frag`,
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
    expect(redactUrlsInText("see http://[bad")).toBe("see (redacted URL)");
  });

  test("parser-differential and non-http forms fail closed", () => {
    const cases = [
      "http://user:pa ss@host.example/p",
      `http://user§sec\nret@host.example/`.replace("§", COLON),
      `http://user§\tsecret@host.example/`.replace("§", COLON),
      `http:\\\\${AUTH}@host.example\\p?token=abc`,
      `http:/\\${AUTH}@host.example/`,
      `http://user%40x§secret@host.example/`.replace("§", COLON),
      "http://user;a:secret;b@host.example/",
      `HtTpS://${AUTH}@host.example/?token=abc`,
      `https://${AUTH}@host.example,`,
      `(https://${AUTH}@host.example)`,
      `'https://${AUTH}@host.example'`,
      `<https://${AUTH}@host.example>`,
      `https://${AUTH}@host.example/p"q`,
      `ftp://${AUTH}@host.example/`,
      `ws://${AUTH}@host.example/`,
      `//${AUTH}@host.example/`,
      `${AUTH}@host.example`,
      "host.example/path?token=secret",
      "host.example/path#secret",
      "http://[bad:secret@host",
    ];
    for (const input of cases) {
      const out = redactUrlsInText(`failed ${input} end`);
      expect(out).not.toContain("secret");
      expect(out).not.toContain("user:");
      expect(out).not.toContain("token=");
      expect(out.startsWith("failed ") && out.endsWith(" end")).toBe(true);
    }
  });

  test("a megabyte of text with no URL, and one of repeated schemes, stays linear", () => {
    const start = performance.now();
    redactUrlsInText("x".repeat(1_000_000));
    redactUrlsInText("http://".repeat(100_000));
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
