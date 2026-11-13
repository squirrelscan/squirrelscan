// The urls file of a batch audit (#1231): untrusted input, read within bounds. Synthetic hosts only.

import { describe, expect, test } from "bun:test";

import { parseUrlsFile, urlKey } from "../../src/batch/urls-file";
import {
  BATCH_MAX_REJECTED_KEPT,
  BATCH_MAX_URLS,
  BATCH_URL_MAX_LENGTH,
  BATCH_URLS_FILE_MAX_BYTES,
} from "../../src/constants";

/** Hostile-file tests read 8 MiB, under an explicit cap: the default cap is 64 MiB and would cost 8x the memory per case. */
const EIGHT_MIB = 8 * 1024 * 1024;

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
    expect(r.rejected[0]!.text.length).toBeLessThanOrEqual(
      BATCH_URL_MAX_LENGTH
    );
    expect(r.urls).toHaveLength(1);
    // exactly the cap is kept
    const exact = `https://a.example.com/${"x".repeat(BATCH_URL_MAX_LENGTH - "https://a.example.com/".length)}`;
    expect(exact.length).toBe(BATCH_URL_MAX_LENGTH);
    expect(ok(exact).urls).toHaveLength(1);
  });

  test("more distinct URLs than the cap is an error before anything is audited, not a cut", () => {
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => `https://h${i}.example.com/`).join(
        "\n"
      );
    expect(parseUrlsFile(lines(BATCH_MAX_URLS + 1))).toEqual({
      ok: false,
      reason: "too-many-urls",
      max: BATCH_MAX_URLS,
    });
    expect(ok(lines(BATCH_MAX_URLS)).urls).toHaveLength(BATCH_MAX_URLS);
    // the cap is a parameter, and duplicates and refused lines do not count toward it
    expect(
      parseUrlsFile(
        "https://a.example.com/\nhttps://b.example.com/\nhttps://c.example.com/",
        { maxUrls: 2 }
      ).ok
    ).toBe(false);
    expect(
      ok(
        "https://a.example.com/\nhttps://a.example.com/\nnot a url\nhttps://b.example.com/",
        { maxUrls: 2 }
      ).urls
    ).toHaveLength(2);
  });

  test("a file over the byte cap is refused whole; the default cap is the spec's 64 MiB", () => {
    expect(BATCH_URLS_FILE_MAX_BYTES).toBe(64 * 1024 * 1024);
    const cap = 1_000;
    expect(parseUrlsFile("#".repeat(cap), { maxBytes: cap }).ok).toBe(true); // exactly the cap is read
    expect(
      parseUrlsFile(`${"#".repeat(cap)}\n`, { maxBytes: cap })
    ).toMatchObject({
      ok: false,
      reason: "too-large",
      bytes: cap + 1,
      max: cap,
    });
    // multi-byte text counts in bytes
    expect(parseUrlsFile("é".repeat(cap / 2 + 1), { maxBytes: cap }).ok).toBe(
      false
    );
  });

  test("an empty file and a file of comments have no URLs and are not an error", () => {
    expect(ok("").urls).toEqual([]);
    expect(ok("# nothing\n\n").urls).toEqual([]);
  });
});

describe("special-use hosts are refused as non-public (the policy classifier)", () => {
  const specialUse = [
    "http://192.0.0.8/",
    "http://192.0.2.1/",
    "http://198.18.0.1/",
    "http://198.51.100.7/",
    "http://203.0.113.9/",
    "http://192.88.99.1/",
    "http://224.0.0.1/",
    "http://240.0.0.1/",
    "http://255.255.255.255/",
    "http://4294967295/",
    "http://[64:ff9b::7f00:1]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[64:ff9b:1::1]/",
    "http://[2002:7f00:1::]/",
    "http://[2002:a9fe:a9fe::]/",
    "http://[2001::1]/",
    "http://[::127.0.0.1]/",
    "http://[::2]/",
    "http://[fec0::1]/",
    "http://[2001:db8::1]/",
    "http://[ff02::1]/",
    "http://[100::1]/",
  ];
  test("each one is rejected, and kept when private hosts are allowed", () => {
    const refused = ok(specialUse.join("\n"));
    expect(refused.urls).toEqual([]);
    expect(refused.rejected.map((x) => x.reason)).toEqual(
      Array(specialUse.length).fill("non-public-host")
    );
    expect(
      ok(specialUse.join("\n"), { allowPrivateHosts: true }).rejected
    ).toEqual([]);
  });
  test("public addresses beside them are kept", () => {
    const r = ok(
      "http://198.17.255.255/\nhttp://203.0.114.1/\nhttp://[2606:4700::1111]/\n"
    );
    expect(r.urls).toHaveLength(3);
  });
  test("NAT64 and 6to4 are judged by prefix, as every policy caller does (#1572), whatever IPv4 they embed", () => {
    const r = ok("http://[64:ff9b::808:808]/\nhttp://[2002:808:808::]/\n");
    expect(r.urls).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      "non-public-host",
      "non-public-host",
    ]);
  });
});

describe("a bare host is read as https", () => {
  test("example.com, a port and a path", () => {
    const r = ok(
      "a.example.com\nb.example.com:8443/x?y=1\n  c.example.com  \n"
    );
    expect(r.urls.map((u) => u.url)).toEqual([
      "https://a.example.com/",
      "https://b.example.com:8443/x?y=1",
      "https://c.example.com/",
    ]);
  });
  test("localhost:3000 is non-public, and kept as https only when private hosts are allowed", () => {
    expect(ok("localhost:3000").rejected[0]!.reason).toBe("non-public-host");
    expect(ok("localhost:3000", { allowPrivateHosts: true }).urls[0]!.url).toBe(
      "https://localhost:3000/"
    );
  });
  test("another scheme and a path are still not read as a host", () => {
    const r = ok(
      "javascript:alert(1)\nmailto:a@b.example.com\n/relative\nnot a url\n"
    );
    expect(r.rejected.map((x) => x.reason)).toEqual([
      "not-http",
      "not-http",
      "invalid",
      "invalid",
    ]);
  });
});

describe("the echo of a refused line never holds a credential", () => {
  // built from parts so no line of this file is a whole credential URL
  const pw = ["p", "w", "secret"].join("");
  const echoes = (content: string) =>
    ok(content, {}).rejected.map((x) => x.text);

  test("userinfo, a password alone, and an @ inside the userinfo are masked", () => {
    const r = ok(
      `https://user:${pw}@a.example.com/x\nhttp://:${pw}@b.example.com/\nhttps://us@er:${pw}@c.example.com/\n${["user", pw].join(":")}@d.example.com\n`
    );
    expect(r.rejected.map((x) => x.reason)).toEqual([
      "userinfo",
      "userinfo",
      "userinfo",
      "not-http",
    ]);
    expect(JSON.stringify(r.rejected)).not.toContain(pw);
    expect(r.rejected[0]!.text).toBe("https://***@a.example.com/x");
    expect(r.rejected[1]!.text).toBe("http://***@b.example.com/");
  });

  test("query values and a fragment of a refused private host are masked, their names kept", () => {
    const t = ["tok", pw].join("-");
    const r = ok(
      `http://10.0.0.5/admin?token=${t}&page=2&flag#access_token=${t}\n`
    );
    expect(r.rejected[0]!.reason).toBe("non-public-host");
    expect(r.rejected[0]!.text).toBe(
      "http://10.0.0.5/admin?token=***&page=***&***#***"
    );
    expect(JSON.stringify(r.rejected)).not.toContain(t);
  });

  test("a line of an unrelated shape is masked the same way, and control characters are shown as U+FFFD", () => {
    expect(echoes(`ftp://u:${pw}@h.example.com/?k=${pw}\n`)).toEqual([
      "ftp://***@h.example.com/?k=***",
    ]);
    expect(echoes("https://a.example.com/\u0001x\n")).toEqual([
      "https://a.example.com/\uFFFDx",
    ]);
  });
});

describe("what is stored is bounded", () => {
  test("the rejected list is capped and counted: 8 MiB of one-character lines", () => {
    const content = "a\n".repeat(EIGHT_MIB / 2 - 1);
    const started = performance.now();
    const r = ok(content, { maxBytes: EIGHT_MIB });
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(r.rejected).toHaveLength(BATCH_MAX_REJECTED_KEPT);
    expect(r.rejectedCount).toBe(EIGHT_MIB / 2 - 1);
    expect(r.rejected[0]).toMatchObject({ line: 1, reason: "non-public-host" });
  });

  test("the cap is a parameter, and every refused line is counted", () => {
    const r = ok("a\nb\nc\nhttps://ok.example.com/\n", { maxRejected: 2 });
    expect(r.rejected.map((x) => x.line)).toEqual([1, 2]);
    expect(r.rejectedCount).toBe(3);
    expect(r.urls).toHaveLength(1);
  });

  test("the line cap boundary: 2,048 characters is kept, 2,049 is refused", () => {
    const base = "https://a.example.com/";
    const at = (n: number) => `${base}${"x".repeat(n - base.length)}`;
    expect(at(BATCH_URL_MAX_LENGTH).length).toBe(2048);
    expect(ok(at(BATCH_URL_MAX_LENGTH)).urls).toHaveLength(1);
    const over = ok(at(BATCH_URL_MAX_LENGTH + 1));
    expect(over.urls).toEqual([]);
    expect(over.rejected[0]!.reason).toBe("too-long");
  });

  test("a URL that grows when parsed is refused: 2,000 multi-byte characters are 18,020 once encoded", () => {
    const line = `https://a.example.com/${"日".repeat(2_000)}`;
    expect(line.length).toBeLessThan(BATCH_URL_MAX_LENGTH);
    const r = ok(`${line}\n`);
    expect(r.urls).toEqual([]);
    expect(r.rejected[0]!.reason).toBe("too-long");
  });
});

describe("control characters", () => {
  test("a lone carriage return does not join two URLs into one wrong host", () => {
    const r = ok("https://a.example.com/\rhttps://b.example.com/\n");
    expect(r.urls).toEqual([]);
    expect(r.rejected[0]!.reason).toBe("control-char");
  });
  test("NUL, tab inside a line, a C1 control and DEL are refused; CRLF and a trailing tab are not", () => {
    for (const c of ["\u0000", "\t", "\u0085", "\u007f", "\u001b"]) {
      expect(
        ok(`https://a.example.com/${c}x\n`).rejected[0]!.reason,
        JSON.stringify(c)
      ).toBe("control-char");
    }
    expect(
      ok("https://a.example.com/\r\nhttps://b.example.com/\t\n").urls
    ).toHaveLength(2);
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
      const content = unit.repeat(Math.floor((EIGHT_MIB - 1) / unit.length));
      expect(
        time(() => parseUrlsFile(content, { maxBytes: EIGHT_MIB })),
        JSON.stringify(unit)
      ).toBeLessThan(20_000);
    }
  });

  test("8 MB without a line break, and 8 MB of 2 KB lines", () => {
    expect(
      time(() =>
        parseUrlsFile("h".repeat(EIGHT_MIB - 1), { maxBytes: EIGHT_MIB })
      )
    ).toBeLessThan(20_000);
    const line = `https://a.example.com/${"x".repeat(2_000)}\n`;
    expect(
      time(() =>
        parseUrlsFile(line.repeat(Math.floor((EIGHT_MIB - 1) / line.length)), {
          maxBytes: EIGHT_MIB,
        })
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

describe("the echo of a refused line never holds a credential, whatever the slashes (#1547 round 2)", () => {
  // each secret is built from parts and numbered, so a leak names the line that leaked it
  const secret = (n: number): string => ["sec", "ret", String(n)].join("");
  const echoOf = (line: string): string => {
    const r = ok(`${line}\n`, { maxRejected: 10 });
    return JSON.stringify(r.rejected) + JSON.stringify(r.urls);
  };

  test("every mix of `/` and `\\` after the scheme, any case of the scheme", () => {
    const shapes = [
      (u: string, h: string) => `https:/${u}@${h}/`,
      (u: string, h: string) => `https:///${u}@${h}`,
      (u: string, h: string) => `https:////${u}@${h}`,
      (u: string, h: string) => `https:/\\${u}@${h}`,
      (u: string, h: string) => `https:\\/${u}@${h}`,
      (u: string, h: string) => `https:\\\\${u}@${h}/x`,
      (u: string, h: string) => `HTTPS:////${u}@${h}`,
      (u: string, h: string) => `ftp:///${u}@${h}`,
      (u: string, h: string) => `ftp://${u}@${h}/`,
      (u: string, h: string) => `http://${u}@${h}:8080/p?q=1#f`,
    ];
    for (const [i, shape] of shapes.entries()) {
      const s1 = secret(i);
      const user = `${s1}:${s1}`;
      expect(
        echoOf(shape(user, "h.example.com")),
        shape(user, "h.example.com").replaceAll(s1, "S")
      ).not.toContain(s1);
    }
  });

  test("a line the parser refuses outright still shows no credential-shaped text", () => {
    const s1 = secret(50);
    for (const line of [
      `//${s1}:${s1}@h.example.com`,
      `/${s1}:${s1}@h.example.com`,
      `https://${s1}\uFF20h.example.com/`,
      `https://${s1}\uFE6Bh.example.com/`,
      `https://${s1}%40h.example.com/`,
      `https://${s1}%3a${s1}@h.example.com/`,
      `${s1}:${s1}@h.example.com`,
      `https://${s1}:${s1}@/x`,
    ]) {
      expect(echoOf(line), line.replaceAll(s1, "S")).not.toContain(s1);
    }
  });

  test("a refused line of 2,049 to 4,096 characters whose `@` is past 2,048 echoes only its size", () => {
    const s1 = secret(90);
    for (const total of [2_049, 3_000, 4_096, 4_097, 9_000]) {
      const tail = "@h.example.com";
      const userinfo = s1
        .repeat(Math.ceil((total - 2 - tail.length) / s1.length))
        .slice(0, total - 2 - tail.length);
      const line = `//${userinfo}${tail}`; // starts with `/`: the parser refuses it
      expect(line).toHaveLength(total);
      const r = ok(`${line}\n`);
      expect(r.rejected[0]!.text, String(total)).toMatch(
        /^\[line of \d+\+ characters\]$/
      );
      expect(echoOf(line), String(total)).not.toContain(s1.slice(0, 8));
    }
  });

  test("a userinfo that holds an `@` is masked up to the LAST one when the parser refuses the line", () => {
    const [s1, s2] = [secret(80), secret(81)];
    const echo = echoOf(`//${s1}@${s2}@h.example.com`);
    expect(echo).not.toContain(s1);
    expect(echo).not.toContain(s2);
  });

  test("a userinfo longer than the line cap is not echoed, cut or whole", () => {
    const s1 = secret(60);
    const long = `https://${s1.repeat(400)}@h.example.com/`; // 3,600 characters
    expect(echoOf(long)).not.toContain(s1);
    const huge = `https://${s1.repeat(1_500)}@h.example.com/`; // far past twice the cap
    expect(echoOf(huge)).not.toContain(s1);
    const rejected = ok(`${huge}\n`).rejected[0]!;
    expect(rejected.reason).toBe("too-long");
    expect(rejected.text).toMatch(/^\[line of \d+\+ characters\]$/);
    // under the cap it is parsed and rebuilt, whatever its length
    const near = `https://${s1.repeat(150)}@h.example.com/`;
    expect(near.length).toBeLessThan(BATCH_URL_MAX_LENGTH);
    expect(echoOf(near)).not.toContain(s1);
  });

  test("a randomized differential: 3,000 lines of drawn scheme, separators, userinfo and host", () => {
    let state = 1547;
    const next = (n: number): number => {
      state = (state * 48271) % 2147483647; // Park-Miller
      return state % n;
    };
    const pick = <T>(items: readonly T[]): T => items[next(items.length)]!;
    const lines: string[] = [];
    const secrets: string[] = [];
    for (let i = 0; i < 3_000; i++) {
      const s1 = secret(1_000 + i);
      secrets.push(s1);
      const scheme = pick([
        "http",
        "https",
        "HTTPS",
        "Http",
        "ftp",
        "ws",
        "javascript",
        "x-y",
      ]);
      const sep = pick([
        "//",
        "/",
        "///",
        "////",
        "/\\",
        "\\/",
        "\\\\",
        "",
        ":",
        "//\\",
      ]);
      const user = pick([`${s1}:${s1}`, s1, `:${s1}`, `${s1}%3a${s1}`]);
      const at = pick(["@", "@", "@", "\uFF20", "\uFE6B", "%40"]);
      const host = pick([
        "h.example.com",
        "10.0.0.1",
        "[::1]",
        "h.example.com:8080",
        "",
        "localhost",
      ]);
      const tail = pick(["", "/", "/p", `/p?k=${s1}`, `?k=${s1}#${s1}`, "#f"]);
      lines.push(`${scheme}:${sep}${user}${at}${host}${tail}`);
    }
    const r = ok(`${lines.join("\n")}\n`, { maxRejected: 5_000 });
    const out = JSON.stringify(r.rejected) + JSON.stringify(r.urls);
    for (const [i, s1] of secrets.entries()) {
      if (out.includes(s1))
        throw new Error(
          `leak of line ${i + 1}: ${lines[i]!.replaceAll(s1, "S")}`
        );
    }
    expect(r.rejectedCount).toBeGreaterThan(2_000);
  });

  test("the parse that finds userinfo rebuilds the line from its parts: scheme, host, path and masked query", () => {
    const s1 = secret(70);
    expect(
      ok(`https:////${s1}:${s1}@h.example.com:8443/a/b?k=${s1}#${s1}\n`)
        .rejected[0]!.text
    ).toBe("https://***@h.example.com:8443/a/b?k=***#***");
  });
});

describe("the href cap is on what is audited (#1547 round 2)", () => {
  test("2,048 characters once parsed is kept, 2,049 is refused, whatever the line's own length", () => {
    const at = (pad: number) =>
      `https://a.example.com/${"日".repeat(100)}${"x".repeat(pad)}`; // each 日 is 9 characters once encoded
    const exact = ok(`${at(1_126)}\n`);
    expect(exact.urls).toHaveLength(1);
    expect(exact.urls[0]!.url).toHaveLength(BATCH_URL_MAX_LENGTH);
    const over = ok(`${at(1_127)}\n`);
    expect(over.urls).toEqual([]);
    expect(over.rejected[0]!.reason).toBe("too-long");
  });
});
