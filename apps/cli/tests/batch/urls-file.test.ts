// The urls file of a batch audit (#1231): untrusted input, read within bounds. Synthetic hosts only.

import { describe, expect, test } from "bun:test";

import { parseUrlsFile, urlKey } from "../../src/batch/urls-file";
import {
  BATCH_MAX_URLS,
  BATCH_URL_MAX_LENGTH,
  BATCH_URLS_FILE_MAX_BYTES,
} from "../../src/constants";

const ok = (content: string, options?: Parameters<typeof parseUrlsFile>[1]) => {
  const result = parseUrlsFile(content, options);
  if (!result.ok) throw new Error("refused");
  return result;
};

describe("parseUrlsFile", () => {
  test("one URL per line; blanks and comments are ignored; the line numbers are the file's", () => {
    const r = ok(
      "# the sites\nhttps://a.example.com/\n\n   \n# more\nhttps://b.example.com/page\n"
    );
    expect(r.urls.map((u) => [u.url, u.line])).toEqual([
      ["https://a.example.com/", 2],
      ["https://b.example.com/page", 6],
    ]);
    expect(r.rejected).toEqual([]);
  });

  test("a byte-order mark, CRLF line ends and surrounding spaces are not part of a URL", () => {
    const r = ok("﻿https://a.example.com/\r\n  https://b.example.com/  \r\n");
    expect(r.urls.map((u) => u.url)).toEqual([
      "https://a.example.com/",
      "https://b.example.com/",
    ]);
  });

  test("only http and https: another scheme, and text that is not a URL, are rejected with their line", () => {
    const r = ok(
      "ftp://a.example.com/\nfile:///etc/hosts\njavascript:alert(1)\nnot a url\n/relative/path\nhttps://ok.example.com/\n"
    );
    expect(r.urls.map((u) => u.url)).toEqual(["https://ok.example.com/"]);
    expect(r.rejected.map((x) => [x.line, x.reason])).toEqual([
      [1, "not-http"],
      [2, "not-http"],
      [3, "not-http"],
      [4, "invalid"],
      [5, "invalid"],
    ]);
  });

  test("a URL with userinfo is rejected: a credential must not reach a results file or an argument list", () => {
    // built from parts so no line of this file is a whole credential URL
    const withPassword = `https://${["user", "pw"].join(":")}@a.example.com/`;
    const r = ok(
      `https://user@a.example.com/\n${withPassword}\nhttps://a.example.com/\n`
    );
    expect(r.urls.map((u) => u.url)).toEqual(["https://a.example.com/"]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["userinfo", "userinfo"]);
  });

  test("a host that is not public is rejected unless private hosts are allowed", () => {
    const lines = [
      "http://localhost:3000/",
      "http://127.0.0.1/",
      "http://10.0.0.5/admin",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/",
      "http://intranet/",
      "http://router.home.arpa/",
      "http://0x7f.1/",
      "http://2130706433/",
    ].join("\n");
    const refused = ok(lines);
    expect(refused.urls).toEqual([]);
    expect(refused.rejected.map((x) => x.reason)).toEqual(
      Array(12).fill("non-public-host")
    );
    const allowed = ok(lines, { allowPrivateHosts: true });
    // the hex and decimal spellings of 127.0.0.1 are the same URL once parsed: kept once
    expect(allowed.urls).toHaveLength(10);
    expect(allowed.duplicates).toBe(2);
    expect(allowed.rejected).toEqual([]);
  });

  test("public hosts, an IPv6 literal and a port are kept", () => {
    const r = ok(
      "https://a.example.com:8443/x\nhttp://[2606:4700::1111]/\nhttps://sub.b.example.com/\n"
    );
    expect(r.urls).toHaveLength(3);
  });

  test("the fragment is removed and a URL listed twice is audited once, counted as a duplicate", () => {
    const r = ok(
      "https://a.example.com/p#top\nhttps://a.example.com/p\nhttps://a.example.com/p#other\nhttps://a.example.com/q\n"
    );
    expect(r.urls.map((u) => [u.url, u.line])).toEqual([
      ["https://a.example.com/p", 1],
      ["https://a.example.com/q", 4],
    ]);
    expect(r.duplicates).toBe(2);
  });

  test("a line longer than the cap is rejected and echoed cut, never whole", () => {
    const long = `https://a.example.com/${"x".repeat(BATCH_URL_MAX_LENGTH)}`;
    const r = ok(`${long}\nhttps://b.example.com/\n`);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]).toMatchObject({ line: 1, reason: "too-long" });
    expect(r.rejected[0]!.text.length).toBe(BATCH_URL_MAX_LENGTH);
    expect(r.urls).toHaveLength(1);
    // exactly the cap is kept
    const exact = `https://a.example.com/${"x".repeat(BATCH_URL_MAX_LENGTH - "https://a.example.com/".length)}`;
    expect(exact.length).toBe(BATCH_URL_MAX_LENGTH);
    expect(ok(exact).urls).toHaveLength(1);
  });

  test("more URLs than the cap: the first are kept and the result says it was cut", () => {
    const lines = Array.from(
      { length: BATCH_MAX_URLS + 5 },
      (_, i) => `https://h${i}.example.com/`
    ).join("\n");
    const r = ok(lines);
    expect(r.urls).toHaveLength(BATCH_MAX_URLS);
    expect(r.truncated).toBe(true);
    expect(r.urls[0]!.url).toBe("https://h0.example.com/");
    expect(
      ok(
        Array.from(
          { length: BATCH_MAX_URLS },
          (_, i) => `https://h${i}.example.com/`
        ).join("\n")
      ).truncated
    ).toBe(false);
  });

  test("a file over the byte cap is refused whole", () => {
    expect(parseUrlsFile("#".repeat(BATCH_URLS_FILE_MAX_BYTES)).ok).toBe(true); // exactly the cap is read
    const r = parseUrlsFile(`${"#".repeat(BATCH_URLS_FILE_MAX_BYTES)}\n`);
    expect(r).toMatchObject({ ok: false, reason: "too-large" });
    // multi-byte text counts in bytes
    expect(
      parseUrlsFile("é".repeat(BATCH_URLS_FILE_MAX_BYTES / 2 + 1)).ok
    ).toBe(false);
  });

  test("an empty file and a file of comments have no URLs and are not an error", () => {
    expect(ok("").urls).toEqual([]);
    expect(ok("# nothing\n\n").urls).toEqual([]);
  });
});

describe("urlKey", () => {
  test("is stable, 16 hex characters, differs per URL, and carries nothing of the URL", () => {
    const a = urlKey("https://a.example.com/");
    expect(a).toBe(urlKey("https://a.example.com/"));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(urlKey("https://a.example.com/x")).not.toBe(a);
    expect(a).not.toContain("example");
    expect(ok("https://a.example.com/").urls[0]!.key).toBe(a);
  });
});

describe("hostile files are read in linear time", () => {
  const time = (run: () => unknown): number => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };

  test("8 MB of comment lines, of blank lines and of one-character lines", () => {
    for (const unit of ["#\n", "\n", "a\n", "\r\n", " \t \n"]) {
      const content = unit.repeat(
        Math.floor((BATCH_URLS_FILE_MAX_BYTES - 1) / unit.length)
      );
      expect(
        time(() => parseUrlsFile(content)),
        JSON.stringify(unit)
      ).toBeLessThan(20_000);
    }
  });

  test("8 MB without a line break, and 8 MB of 2 KB lines", () => {
    expect(
      time(() => parseUrlsFile("h".repeat(BATCH_URLS_FILE_MAX_BYTES - 1)))
    ).toBeLessThan(20_000);
    const line = `https://a.example.com/${"x".repeat(2_000)}\n`;
    expect(
      time(() =>
        parseUrlsFile(
          line.repeat(Math.floor((BATCH_URLS_FILE_MAX_BYTES - 1) / line.length))
        )
      )
    ).toBeLessThan(20_000);
  });

  test("the largest allowed count of distinct URLs", () => {
    const content = Array.from(
      { length: BATCH_MAX_URLS },
      (_, i) => `https://h${i}.example.com/p${i}`
    ).join("\n");
    expect(time(() => parseUrlsFile(content))).toBeLessThan(20_000);
  });
});
