// The unreachable-start-URL report must not carry credentials or tokens that the probe's error
// text echoes: userinfo, a query token and a fragment are removed from the reason, the message
// and every rendered format.

import {
  redactUrlsInText,
  redirectedOutcome,
} from "@squirrelscan/core-contracts/seed-redirect";
import { describe, expect, test } from "bun:test";

import {
  renderUnreachableOutcome,
  unreachableOutcome,
} from "@/cli/unreachable";
import { redactStartUrl } from "@/utils/url";

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
      "http://user§ secret@host.example/".replace("§", COLON),
      "http://user§pa ss@host.example/".replace("§", COLON),
      "(http://user§) secret@host.example".replace("§", COLON),
    ];
    for (const input of cases) {
      const out = redactUrlsInText(`failed ${input} end`);
      expect(out).not.toContain("secret");
      expect(out).not.toContain("user:");
      expect(out).not.toContain("//user");
      expect(out).not.toContain("token=");
      expect(out.startsWith("failed ") && out.endsWith(" end")).toBe(true);
    }
  });

  test("review findings: path-@ reads, long split userinfo, redirect outcome, rerun command", () => {
    const cases = [
      "https://usrx\\pwdy@host.example/",
      `https://usrx§123/pwdy@host.example/`.replace("§", COLON),
      `https://usrx§pwdy pwdy pwdy@host.example/`.replace("§", COLON),
      `https://usrx§pwdy a b c d e f g h@host.example/`.replace("§", COLON),
    ];
    for (const input of cases) {
      const out = redactUrlsInText(`failed ${input} end`);
      expect(out).not.toContain("pwdy");
      expect(out).not.toContain("usrx");
      expect(out.endsWith(" end")).toBe(true);
    }
    // A plain host:port URL stays readable.
    expect(redactUrlsInText("https://host.example:8080/p ok")).toBe(
      "https://host.example:8080/p ok"
    );
    const outcome = redirectedOutcome({
      kind: "cross-domain",
      originalUrl: `https://${AUTH}@a.example/p?t=tokz#frgw`,
      finalUrl: "https://b.example/",
      chain: [],
      refusal: `refused https://${AUTH}@a.example/p?t=tokz`,
    });
    const text = JSON.stringify(outcome);
    for (const word of ["user", "secret", "tokz", "frgw"]) {
      expect(text).not.toContain(word);
    }
    const refused = redirectedOutcome({
      kind: "refused",
      originalUrl: "https://a.example/",
      finalUrl: "https://a.example/",
      chain: [],
      refusal: `blocked https://${AUTH}@a.example/p?t=tokz`,
    });
    expect(JSON.stringify(refused)).not.toContain("tokz");
    expect(JSON.stringify(refused)).not.toContain("secret");
  });

  test("redactStartUrl strips userinfo, query and fragment and normalises a bare host", () => {
    expect(redactStartUrl(`https://${AUTH}@host.example/p?t=tokz#frgw`)).toBe(
      "https://host.example/p"
    );
    expect(redactStartUrl("https://usrx@host.example/")).toBe(
      "https://host.example/"
    );
    expect(redactStartUrl("example.com")).toBe("https://example.com/");
  });

  test("a megabyte of text with no URL, and one of repeated schemes, stays linear", () => {
    const start = performance.now();
    redactUrlsInText("x".repeat(1_000_000));
    redactUrlsInText("http://".repeat(100_000));
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
