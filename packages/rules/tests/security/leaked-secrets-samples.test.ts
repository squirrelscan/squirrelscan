// security/leaked-secrets: documentation samples, placeholders, binary
// payloads and prefix collisions are not credentials (#1283, #1227).
//
// Every block pairs the negatives a fix silences with the real-shaped control
// it must not silence. Every value is synthetic and assembled at runtime so no
// line is a whole token-shaped literal.

import { createHmac } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { decodePercentRun } from "../../src/security/secrets/decode";
import { isShippedServerSecret, pemWork, scanContent, type SecretLocation } from "../../src/security/leaked-secrets";
import { githubToken, issuerJwt, mixedRun, runOf, seededRng } from "./leaked-secrets/generators";

const HEX = "0123456789abcdef";
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // pragma: allowlist secret
const PAGE = "https://app.acme.test/";

/** `[type, confidence, public]` for every finding in `text`. */
function found(text: string, location: SecretLocation = "inline-script") { // pragma: allowlist secret
  return scanContent(text, location, PAGE).map((f) => [f.type, f.confidence, f.publicByDesign]);
}

const b64u = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const unsigned = (header: object, payload: object) =>
  `${b64u(header)}.${b64u(payload)}.${runOf(seededRng(9), ALNUM, 43)}`;

/** An HS256 token signed with `secret`, the way a decoder page's editor signs its sample. */
const signed = (payload: object, secret: string) => {
  const head = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u(payload)}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
};

describe("jwt.io sample tokens (#1283)", () => {
  const SAMPLE = { sub: "1234567890", name: "John Doe", admin: true, iat: 1516239022 };

  test("the published payload, signed with a published secret, is not reported", () => {
    const tokens = [
      signed(SAMPLE, "your-256-bit-secret"),
      signed({ sub: "1234567890", name: "John Doe", iat: 1516239022 }, "secret"),
      // The published token itself.
      ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"].join("."), // pragma: allowlist secret
    ];
    for (const token of tokens) expect(found(`var t="${token}";`)).toEqual([]);
  });

  test("any other claim or value is a different token, even signed with a published secret", () => {
    for (const payload of [
      { ...SAMPLE, iss: "https://example.com" },
      { ...SAMPLE, exp: 4102444800 },
      { ...SAMPLE, iat: 1700000000 },
      { sub: "1234567890", iat: 1516239022 },
      { sub: "1234567890", name: "John Doe" },
      { ...SAMPLE, admin: false },
    ]) {
      expect([JSON.stringify(payload), found(`var t="${signed(payload, "your-256-bit-secret")}";`).length > 0]).toEqual([JSON.stringify(payload), true]);
    }
  });

  test("the sample's claims signed with a real secret are an attacker's token, not the sample", () => {
    const minted = signed({ ...SAMPLE, scope: "admin" }, "K8#mZ2!qX7vP-not-a-published-secret"); // pragma: allowlist secret
    expect(found(`var t="${minted}";`)).toEqual([["JSON Web Token (admin scope)", "high", false]]);
    expect(found(`var t="${unsigned({ alg: "HS256", typ: "JWT" }, SAMPLE)}";`).map((f) => f[0])).toEqual(["JSON Web Token"]);
  });

  test("the sample's subject with a granted scope or role is reported even when signed with a published secret", () => {
    for (const grant of [{ scope: "admin" }, { role: "admin" }, { permissions: ["*"] }]) {
      const token = signed({ ...SAMPLE, ...grant }, "secret");
      expect(found(`var t="${token}";`).map((f) => f[2])).toEqual([false]);
    }
  });

  test("a token with the sample's subject but neither its name nor its iat still reports", () => {
    const token = unsigned({ alg: "HS256" }, { sub: "1234567890", name: "Ada Lovelace", iat: 1700000000, scope: "admin" });
    expect(found(`var t="${token}";`)).toEqual([["JSON Web Token (admin scope)", "high", false]]);
  });

  test("an admin token with a different subject still reports", () => {
    const token = issuerJwt(seededRng(1283), { sub: "user_8841", name: "John Doe", iat: 1516239022, scope: "admin" });
    expect(found(`var t="${token}";`)).toEqual([["JSON Web Token (admin scope)", "high", false]]);
  });
});

describe("Twitter bearer tokens are not base64 payloads (#1283)", () => {
  const r = seededRng(1284);
  const tail = () => `${mixedRun(r, 40)}%2B${mixedRun(r, 20)}%3D${mixedRun(r, 40)}`;

  test("a real-shaped bearer in a value position reports, at both ends of the shape", () => {
    const token = "A".repeat(21) + tail();
    expect(found(`var c={bearer:"${token}"};`)).toEqual([["Twitter Bearer Token", "high", false]]);
    expect(found(`fetch(u,{headers:{Authorization:"Bearer ${token}"}})`).map((f) => f[0])).toContain("Twitter Bearer Token");
  });

  test("a percent-encoded token (22 A, then %2B, %2F, %3D: about 118 characters) reports in every context a token is handed over in", () => {
    const encoded = (count: number) =>
      `${"A".repeat(count)}${mixedRun(r, 12)}%2B${mixedRun(r, 40)}%2F${mixedRun(r, 30)}%3D`;
    for (const count of [19, 21, 22, 24]) {
      const token = encoded(count);
      const contexts: Array<[string, SecretLocation, string]> = [
        ["assignment", "inline-script", `var o={token:"${token}"};`],
        ["bare string", "inline-script", `var s="${token}";`],
        ["URL parameter", "inline-script", `var u="https://api.acme.test/x?bearer_token=${token}&y=1";`],
        ["attribute", "html", `<div data-token="${token}"></div>`],
        ["Bearer header", "inline-script", `var h="Bearer ${token}";`],
        ["Authorization header", "inline-script", `var h={Authorization:"Bearer ${token}"};`],
      ];
      for (const [context, location, text] of contexts) {
        expect([count, context, found(text, location).map((f) => f[0])]).toEqual([count, context, ["Twitter Bearer Token"]]);
      }
    }
  });

  test("an unencoded token of 19 A and real characters reports; 19 A with a short tail does not", () => {
    expect(found(`var c={bearer:"${"A".repeat(19)}${mixedRun(r, 60)}"};`)).toEqual([["Twitter Bearer Token", "high", false]]);
    expect(found(`var c={bearer:"${"A".repeat(19)}${mixedRun(r, 10)}"};`)).toEqual([]);
    expect(found(`var c={bearer:"${"A".repeat(19)}${mixedRun(r, 10)}%2B${mixedRun(r, 8)}"};`)).toEqual([]);
  });

  test("a secret in the same URL-encoded run as a Twitter-shaped token is still found, and so is the token", () => {
    const token = `${"A".repeat(22)}${mixedRun(r, 12)}%2B${mixedRun(r, 40)}%2F${mixedRun(r, 30)}%3D`;
    const secret = mixedRun(r, 40);
    const settings = encodeURIComponent(JSON.stringify({ secret, mode: "x" }));
    // the document's escapes are decoded (the secret is readable), the token's are kept as written
    for (const text of [`var u="https://x.acme.test/c?cfg=${settings}&bearer_token=${token}&y=1";`, `var u="https://x.acme.test/c?bearer_token=${token}&cfg=${settings}";`]) {
      expect(found(text).map((f) => f[0]).sort()).toEqual(["Generic Secret Assignment", "Twitter Bearer Token"]);
    }
    // an embedded secret cannot hide behind the shape: the run before the token is decoded as well
    const hidden = `${encodeURIComponent(JSON.stringify({ apiKey: mixedRun(r, 32) }))}AAAAAAAAAAAAAAAAAAAAAA${mixedRun(r, 12)}%2B${mixedRun(r, 30)}`;
    expect(found(`var u="https://x.acme.test/c?${hidden}";`).map((f) => f[0])).toContain("Generic API Key Assignment");
  });

  test("only the token's own escapes are kept: a key name written after it in the same run is decoded and matched", () => {
    const token = `${"A".repeat(22)}${mixedRun(r, 12)}%2B${mixedRun(r, 40)}%2F${mixedRun(r, 30)}%3D`;
    const text = `var u="https://x.acme.test/c?t=${token}%26aws_secret_access_key%3D${mixedRun(r, 40)}";`;
    expect(found(text).map((f) => f[0]).sort()).toEqual(["AWS Secret Access Key", "Twitter Bearer Token"]);
    // an escape that is not one of the token's own (`%26`, `%20`, `%22`) ends it
    for (const stop of ["%26", "%20", "%22", "%23"]) {
      expect(decodePercentRun(`t=${token}${stop}x%3Dy%3Dz`)).toContain(`${token}${decodeURIComponent(stop)}x=y=z`);
    }
  });

  test("another secret written after the token in the same run is decoded and still found, with the token", () => {
    const token = `${"A".repeat(22)}${mixedRun(r, 12)}%2B${mixedRun(r, 40)}%2F${mixedRun(r, 30)}%3D`;
    const stripe = "sk_" + "live_" + runOf(r, ALNUM, 24);
    const github = githubToken(r, "gh" + "p_");
    expect(found(`var u="https://x.acme.test/c?t=${token}%26k%3D${stripe}";`).map((f) => f[0]).sort()).toEqual(["Stripe Live Key", "Twitter Bearer Token"]);
    expect(found(`var u="https://x.acme.test/c?t=${token}%26k%3D${github}";`).map((f) => f[0]).sort()).toEqual(["GitHub Personal Access Token", "Twitter Bearer Token"]);
    expect(found(`var u="https://x.acme.test/c?t=${token}%22%2C%22k%22%3A%22${stripe}%22";`).map((f) => f[0]).sort()).toEqual(["Stripe Live Key", "Twitter Bearer Token"]);
  });

  test("the token's bounds: 19 `A` is the floor, and the kept region ends 300 characters in", () => {
    const tail = (n: number) => runOf(seededRng(n), ALNUM, 40);
    // 18 A is no token shape: its escapes are decoded; 19 is
    expect(decodePercentRun(`x=${"A".repeat(18)}${tail(1)}%2B${tail(2)}%2F${tail(3)}%3D&z%3D1`)?.includes("%2B")).toBe(false);
    expect(decodePercentRun(`x=${"A".repeat(19)}${tail(1)}%2B${tail(2)}%2F${tail(3)}%3D&z%3D1`)?.includes("%2B")).toBe(true);
    // an escape inside the 300 characters is kept, one past them is decoded
    const near = `${"A".repeat(22)}${tail(4)}%2B${tail(5)}`;
    const far = `${"A".repeat(22)}${runOf(seededRng(6), ALNUM, 320)}%2B${tail(7)}`;
    const out = decodePercentRun(`x=${near}&y%3D1%26z%3D2&w=${far}`) ?? "";
    expect(out).toContain("%2B");
    expect(decodePercentRun(`x=${far}&y%3D1%26z%3D2`)?.includes("%2B")).toBe(false);
    const mid = `${"A".repeat(22)}${runOf(seededRng(8), ALNUM, 250)}%2B${tail(9)}`;
    expect(decodePercentRun(`x=${mid}&y%3D1%26z%3D2`)?.includes("%2B")).toBe(true);
  });

  test("a token after `%3D` (an `=` once decoded: key=token) is found; one in the middle of a payload is not", () => {
    const token = `${"A".repeat(22)}${mixedRun(r, 12)}%2B${mixedRun(r, 40)}%2F${mixedRun(r, 30)}%3D`;
    expect(found(`var u="https://x.acme.test/c?bearer_token%3D${token}&y=1";`).map((f) => f[0])).toContain("Twitter Bearer Token");
    expect(found(`var u="https://x.acme.test/c?cfg%3D${token}%26y%3D1";`).map((f) => f[0])).toContain("Twitter Bearer Token");
    // after a letter or digit, or `+` or `/`, it is a payload's interior
    for (const lead of ["Q", "7", "+", "/"]) {
      expect([lead, found(`var u="${mixedRun(r, 20)}${lead}${token}";`).map((f) => f[0]).includes("Twitter Bearer Token")]).toEqual([lead, false]);
      // (read at the decode: a payload's escapes are decoded like any other run's, the token's are kept only when it starts a token)
      const run = `x=${lead}${token}%26y%3Dz`;
      expect([lead, decodePercentRun(run)?.includes("%2B")]).toEqual([lead, false]);
    }
    // the escape before the token decides: a delimiter (`=`, `"`, `'`, `&`, `:`) starts a token, `%2C` (a data: URL's comma), `%2B`, `%2F` do not
    for (const lead of ["%2C", "%2B", "%2F"]) {
      const run = `x${lead}${token}%26y%3Dz`;
      expect([lead, decodePercentRun(run)?.includes("%2B")]).toEqual([lead, false]);
    }
    expect(found(`var u="data:text/plain,${mixedRun(r, 10)}%2C${token}%26y%3D1";`).map((f) => f[0])).not.toContain("Twitter Bearer Token");
    for (const lead of ["=", "&", "%3D", "%22", "%27", "%26", "%3A"]) {
      const run = `x${lead}${token}%26y%3Dz`;
      expect([lead, decodePercentRun(run)?.includes("%2B")]).toEqual([lead, true]);
    }
  });

  test("a literal private-use character in the run can neither hide the token nor turn into a percent sign", () => {
    const token = `${"A".repeat(22)}${mixedRun(r, 12)}%2B${mixedRun(r, 40)}%2F${mixedRun(r, 30)}%3D`;
    const withLiteral = `\uE000x\uE001${token}\uE000&cfg=%7B%22a%22%3A1%7D`;
    const decoded = decodePercentRun(withLiteral) ?? "";
    expect(decoded).toContain(token);
    expect(decoded.split("\uE000").length - 1).toBe(2);
    expect(decoded).toContain("\uE001");
    expect(found(`var u="https://x.acme.test/c?q=\uE000&t=${token}";`).map((f) => f[0])).toContain("Twitter Bearer Token");
    // with no token in the run, a literal stays a literal
    expect(decodePercentRun("a%20\uE000%20b%20c")).toBe("a \uE000 b c");
  });

  test("an encoded document with a base64 blob in it is still decoded, and what is inside it reports", () => {
    // the secret is only readable once the document is decoded (its quotes and colons are escapes)
    const doc = encodeURIComponent(JSON.stringify({ image: `data:image/png;base64,${"A".repeat(60)}${mixedRun(r, 30)}`, secret: mixedRun(r, 40) }));
    expect(found(`var d="${doc}";`).map((f) => f[0])).toContain("Generic Secret Assignment");
  });

  test("a run of A in base64 image, font and wasm payloads is not", () => {
    const payloads = [
      `var i="data:image/png;base64,${"A".repeat(60)}${mixedRun(r, 30)}";`,
      `var f="data:font/woff2;base64,${"A".repeat(300)}";`,
      `var w="${"A".repeat(120)}";`,
      `var u="/fonts/${mixedRun(r, 30)}/${"A".repeat(40)}%2Fx";`,
      `var p="${mixedRun(r, 20)}+${"A".repeat(30)}${mixedRun(r, 40)}";`,
      `var p="${"A".repeat(30)}${mixedRun(r, 40)}/${mixedRun(r, 20)}";`,
    ];
    for (const js of payloads) expect(found(js).filter((f) => f[0] === "Twitter Bearer Token")).toEqual([]);
  });

  test("a bearer that is a run of A with a short tail is not", () => {
    expect(found(`var c={bearer:"${"A".repeat(30)}%3Dabc"};`)).toEqual([]);
  });
});

describe("prefixed tokens inside asset file names (#1283)", () => {
  const r = seededRng(1285);

  test("a hashed file name is not a credential", () => {
    const names = [
      `<img src="/img/neon_${mixedRun(r, 40)}.png">`,
      `<img src="/icons/sk-${mixedRun(r, 40)}.svg">`,
      `<img src="/img/key-${mixedRun(r, 32)}.webp">`,
      `@font-face{src:url(/fonts/re_${mixedRun(r, 40)}.woff2)}`,
    ];
    for (const html of names) expect(found(html, "html")).toEqual([]);
  });

  test("the same tokens outside a file name still report", () => {
    expect(found(`var a="neon_${mixedRun(r, 40)}";`).map((f) => f[0])).toEqual(["Neon Database Token"]);
    expect(found(`var a="key-${mixedRun(r, 32)}";`).map((f) => f[0])).toEqual(["Mailgun API Key"]);
    // An extension-like tail that is not one of the asset extensions.
    expect(found(`var a="neon_${mixedRun(r, 40)}.pngx";`).map((f) => f[0])).toEqual(["Neon Database Token"]);
  });

  test("an IBAN is not a DigitalOcean Spaces key; a key-shaped string that fails the IBAN check is", () => {
    expect(found(`var f={placeholder:"DO28BAGR00000001212453611324"};`)).toEqual([]);
    expect(found(`var f={placeholder:"DO28BAGR00000001212453611325"};`).map((f) => f[0])).toEqual(["DigitalOcean Spaces Key"]);
    expect(found(`var k="DO${runOf(seededRng(5), UPPER, 20)}";`).map((f) => f[0])).toEqual(["DigitalOcean Spaces Key"]);
  });

  test("a lowercase slug after a vendor name is not a token; a mixed-case token is", () => {
    const slug = "step-1-create-your-cloudflare-bucket-nam";
    expect(found(`<div id="cloudflare-${slug}"></div>`, "html")).toEqual([]);
    // Under a credential key it is a value: a passphrase-style secret still reports.
    expect(found(`var c={cloudflareToken:"correct-horse-battery-staple-token-value"};`).length).toBeGreaterThan(0);
    expect(found(`var c={cloudflareToken:"${slug}"};`).length).toBeGreaterThan(0);
    expect(found(`var c={cloudflareToken:"${mixedRun(seededRng(7), 40)}"};`).map((f) => f[0])).toEqual(["Cloudflare API Token"]);
  });
});

describe("sk_live_ is Stripe's prefix and other vendors' (#1283)", () => {
  const r = seededRng(1286);
  const LIVE = "sk_" + "live_";
  const TEST = "sk_" + "test_";

  test("a Paystack key is 40 hex and is labelled Paystack", () => {
    const live = `${LIVE}${runOf(r, HEX, 40)}`;
    const test_ = `${TEST}${runOf(r, HEX, 40)}`;
    expect(found(`var k="${live}";`)).toEqual([["Paystack Live Secret Key", "high", false]]);
    expect(found(`var k="${test_}";`)).toEqual([["Paystack Test Secret Key", "high", false]]);
    expect(scanContent(`var k="${live}";`, "inline-script", PAGE)[0]?.extra).toMatchObject({ provider: "Paystack", mode: "live" });
  });

  test("a Stripe key keeps its label", () => {
    expect(found(`var k="${LIVE}${mixedRun(r, 24)}";`)).toEqual([["Stripe Live Key", "high", false]]);
    expect(found(`var k="${TEST}51${mixedRun(r, 97)}";`)).toEqual([["Stripe Test Key", "high", false]]);
  });

  test("a widget key in a data-*-key attribute is reviewable, with the widget hint and no provider", () => {
    const key = `${LIVE}${runOf(r, HEX, 48)}`;
    const attribute = scanContent(`<div data-deployment-key="${key}"></div>`, "html", PAGE);
    expect(attribute.map((f) => [f.type, f.confidence])).toEqual([["Secret Key (sk_live_ prefix, provider unknown)", "medium"]]);
    expect(attribute[0]?.extra).toMatchObject({ provider: "unknown", hint: "embeddable widget key (data-*-key attribute)" });
    // Anywhere else the label is the same and the hint is not claimed.
    const script = scanContent(`var k="${key}";`, "inline-script", PAGE);
    expect(script[0]?.type).toBe("Secret Key (sk_live_ prefix, provider unknown)");
    // Outside a widget attribute it is some vendor's secret and stays high.
    expect(script[0]?.confidence).toBe("high");
    expect(script[0]?.extra).not.toHaveProperty("hint");
  });
});

describe("placeholders and documentation examples (#1227)", () => {
  const r = seededRng(1227);

  test("the four reported snippets produce no finding", () => {
    const snippets = [
      `var u = "postgres://user:s3cret@localhost:5432/app";`, // pragma: allowlist secret
      `var s = "curl https://api.example.com/v1/charges -u ${"sk_" + "test_"}${"4eC39HqLyjWDarjtT1zdp7dc"}:";`, // pragma: allowlist secret
      `var h = "Paste your key, it starts with -----BEGIN OPENSSH PRIVATE KEY-----";`, // pragma: allowlist secret
      `var o = { password: 'example-password' };`, // pragma: allowlist secret
    ];
    for (const js of snippets) expect(found(js)).toEqual([]);
  });

  describe("PEM keys need a body", () => {
    const body = (lines: number) => Array.from({ length: lines }, () => mixedRun(r, 64, ALNUM + "+/")).join("\n");
    const header = (kind: string) => `-----BEGIN ${kind} PRIVATE KEY-----`;
    const footer = (kind: string) => `-----END ${kind} PRIVATE KEY-----`;

    test("a header with no body, an elided body or a short body is not a key", () => {
      for (const kind of ["RSA", "DSA", "EC", "OPENSSH"]) {
        for (const tail of ["", "\nMIIE...\n", "\nMIIEowIBAAKCAQEA\n", " and paste the rest of it here", "\n" + footer(kind)]) {
          expect(found(`var d = "${header(kind)}${tail}";`)).toEqual([]);
        }
      }
      expect(found(`var d = "-----BEGIN PGP PRIVATE KEY BLOCK-----\\nVersion: x\\n\\n${"AAAA"}\\n-----END PGP PRIVATE KEY BLOCK-----";`)).toEqual([]); // pragma: allowlist secret
    });

    test("a header in prose is not made a key by a real key further down the page", () => {
      const real = `${header("RSA")}\n${body(2)}\n${footer("RSA")}`;
      const js = `var h = "it starts with ${header("OPENSSH")}";\nvar n = 1;\nvar k = \`${real}\`;`;
      expect(found(js)).toEqual([["Private Key (RSA)", "high", false]]);
    });

    test("a key written as an array of quoted lines still reports", () => {
      const lines = [header("RSA"), ...body(2).split("\n"), footer("RSA")];
      expect(found(`var k = [${lines.map((l) => JSON.stringify(l)).join(", ")}].join("\\n");`).map((f) => f[0])).toEqual(["Private Key (RSA)"]);
    });

    test("a real-shaped block still reports, however the newlines are written", () => {
      const key = body(3);
      const real = `${header("RSA")}\n${key}\n${footer("RSA")}`;
      expect(found(`var k = \`${real}\`;`)).toEqual([["Private Key (RSA)", "high", false]]);
      // A JSON string carries newlines as the two characters backslash, n.
      expect(found(`var k = "${real.replace(/\n/g, "\\n")}";`)).toEqual([["Private Key (RSA)", "high", false]]);
      // A double-escaped newline (JSON inside a JSON string) and 40-character lines.
      expect(found(`var k = "${real.replace(/\n/g, "\\\\n")}";`).map((f) => f[0])).toEqual(["Private Key (RSA)"]);
      const short = [header("RSA"), mixedRun(r, 40), mixedRun(r, 40), footer("RSA")].join("\n");
      expect(found(`var k = \`${short}\`;`).map((f) => f[0])).toEqual(["Private Key (RSA)"]);
      // A joined string literal.
      const joined = [header("EC"), ...key.split("\n").map((l) => `${l}`)].map((l) => JSON.stringify(l + "\n")).join(" + ");
      expect(found(`var k = ${joined};`).map((f) => f[0])).toEqual(["Private Key (EC)"]);
      // An armored block with its header lines.
      const pgp = `-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\n${key}\n-----END PGP PRIVATE KEY BLOCK-----`; // pragma: allowlist secret
      expect(found(`var k = \`${pgp}\`;`).map((f) => f[0])).toEqual(["Private Key (PGP)"]);
    });
  });

  describe("connection strings", () => {
    const strong = "Xk9" + "mQ2vL8" + "zPq4"; // pragma: allowlist secret

    test("a word a person chose, on a machine nobody can reach, is a docs example", () => {
      const hosts = ["localhost:5432", "127.0.0.1:5432", "db.test", "x.example", "[::1]:5432", "pg.invalid"];
      for (const host of hosts) {
        for (const pw of ["s3cret", "changeme", "password123", "example-password", "Secret1", "root"]) {
          expect(found(`var u = "postgres://app:${pw}@${host}/app";`)).toEqual([]);
        }
      }
    });

    test(".internal and .local are real private networks: a docs-looking password there still reports", () => {
      for (const host of ["db.internal:5432", "pg.local", "db.svc.cluster.local"]) {
        expect(found(`var u = "postgres://app:s3cret@${host}/app";`).map((f) => f[0])).toEqual(["PostgreSQL Connection String"]); // pragma: allowlist secret
      }
    });

    test("only whole stems are documentation words: a password that merely contains one is not", () => {
      for (const pw of ["CompassRoseAtlas", "Bypassing", "Tester" + "Bob", "Roots" + "alt"]) {
        expect([pw, found(`var u = "postgres://app:${pw}@localhost/app";`).length]).toEqual([pw, 1]);
      }
      expect(found(`var u = "postgres://app:examplepassword@localhost/app";`)).toEqual([]); // pragma: allowlist secret
    });

    test("a random password on the same hosts is a development credential and stays", () => {
      expect(found(`var u = "postgres://app:${strong}@localhost:5432/app";`).map((f) => f[0])).toEqual(["PostgreSQL Connection String"]);
      expect(found(`var u = "postgres://app:${strong}@db.internal:5432/app";`).map((f) => f[0])).toEqual(["PostgreSQL Connection String"]);
    });

    test("a placeholder-word password on a routable host stays", () => {
      expect(found(`var u = "postgres://app:s3cret@db.acme-prod.net:5432/app";`).map((f) => f[0])).toEqual(["PostgreSQL Connection String"]); // pragma: allowlist secret
    });

    test("a password that is itself a template placeholder is a driver's own builder", () => {
      const templates = [
        "postgres://${user}:${pass}@${host}:5432/app",
        "postgres://{{ user }}:{{ pass }}@db.acme-prod.net/app",
        "postgres://%s:%s@%s/app", // pragma: allowlist secret
        "mysql://{user}:{password}@{host}/app",
        "postgres://app:%(pw)s@db.acme-prod.net/app",
      ];
      for (const url of templates) expect(found(`var u = "${url}";`)).toEqual([]);
    });

    test("a hard-coded password beside a templated host or user, or containing a marker, still reports", () => {
      const real = "Xk9mQ2" + "vL8zPq4"; // pragma: allowlist secret
      for (const url of [
        `postgres://app:${real}@\${DB_HOST}:5432/app`,
        `postgres://app:${real}@{host}:5432/app`,
        `postgres://\${user}:${real}@db.acme-prod.net/app`,
        `postgres://app:${real}%s@db.acme-prod.net/app`,
        `postgres://app:${real}%D0x@db.acme-prod.net/app`,
        `postgres://app:${real}{abc}@db.acme-prod.net/app`,
      ]) {
        expect([url, found(`var u = "${url}";`).map((f) => f[0])]).toEqual([url, ["PostgreSQL Connection String"]]);
      }
    });

    test("a random password that merely sits in braces is not a template placeholder", () => {
      const braced = "{" + "Xk9mQ2" + "vL8zPq4" + "}"; // pragma: allowlist secret
      expect(found(`var u = "postgres://app:${braced}@db.acme-prod.net/app";`).map((f) => f[0])).toEqual(["PostgreSQL Connection String"]);
    });

    test("a password-less redis URL is not a secret", () => {
      expect(found(`var u = "redis://cache.acme-prod.net:6379/0";`)).toEqual([]);
    });
  });

  describe("Stripe's published sample key", () => {
    const TAIL = "4eC39HqLyjWDarjtT1zdp7dc"; // pragma: allowlist secret
    const prefixes = ["sk_" + "test_", "sk_" + "live_", "rk_" + "test_", "rk_" + "live_"];

    test("is suppressed under every secret prefix", () => {
      for (const prefix of prefixes) expect(found(`var k = "${prefix}${TAIL}";`)).toEqual([]);
    });

    test("another key of the same length is not", () => {
      expect(found(`var k = "${"sk_" + "test_"}${mixedRun(seededRng(3), 24)}";`).map((f) => f[0])).toEqual(["Stripe Test Key"]);
      // The sample's tail with one character changed is somebody else's key.
      const altered = `${TAIL.slice(0, -1)}x`;
      expect(found(`var k = "${"sk_" + "live_"}${altered}";`).map((f) => f[0])).toEqual(["Stripe Live Key"]);
    });
  });

  describe("placeholder words", () => {
    test("example-* is a placeholder; a token that merely contains the word is not", () => {
      for (const word of ["example-password", "example_secret", "examplepassword", "example-api-key", "example-password1"]) {
        expect(found(`var o = { password: '${word}' };`)).toEqual([]);
      }
      // `changeme` is as often a real default credential as a placeholder: still reviewable.
      expect(found(`var o = { password: 'changeme' };`).map((f) => f[0])).toEqual(["Generic Secret Assignment"]); // pragma: allowlist secret
      const real = `K8#m${"Z2!qX7vP"}`; // pragma: allowlist secret
      expect(found(`var o = { password: '${real}' };`).map((f) => f[0])).toEqual(["Generic Secret Assignment"]);
      expect(found(`var o = { apiKey: '${mixedRun(seededRng(11), 16)}example${mixedRun(seededRng(12), 8)}' };`).map((f) => f[0])).toEqual(["Generic API Key Assignment"]);
      // A password that starts with the word but is not one of its forms is not the placeholder.
      for (const word of ["Example1234", "ExampleKey", "example123", "Example-Corp"]) {
        expect([word, found(`var o = { password: '${word}' };`).length]).toEqual([word, 1]);
      }
      expect(found(`var o = { password: 'Example${"Corp#2024" + "!xQ9"}' };`).map((f) => f[0])).toEqual(["Generic Secret Assignment"]); // pragma: allowlist secret
    });

    test("the existing placeholder fixtures still pass", () => {
      for (const js of [`var o={API_KEY:"YOUR_API_KEY"};`, `var o={apiKey:"your-api-key-here"};`]) { // pragma: allowlist secret
        expect(found(js)).toEqual([]);
      }
    });
  });
});

describe("bypass attempts: a real secret placed where an allowlist looks", () => {
  const r = seededRng(99);
  const real = mixedRun(r, 32);

  test("a real value beside a placeholder word, in a docs-looking comment or a sample-named variable", () => {
    expect(found(`/* example: your-api-key-here */ var o={apiKey:"${real}"};`).map((f) => f[0])).toEqual(["Generic API Key Assignment"]);
    expect(found(`var sample={apiKey:"${real}"}; // sample config`).map((f) => f[0])).toEqual(["Generic API Key Assignment"]);
    expect(found(`var u="postgres://example:${"Xk9mQ2" + "vL8zPq4"}@db.acme-prod.net/app";`).map((f) => f[0])).toEqual(["PostgreSQL Connection String"]); // pragma: allowlist secret
  });

  test("a real key right after a prose header, a doc sample on the same line, or an asset-looking path", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${mixedRun(r, 64, ALNUM + "+/")}\n-----END RSA PRIVATE KEY-----`; // pragma: allowlist secret
    expect(found(`var d="it starts with -----BEGIN RSA PRIVATE KEY-----"; var k="${pem}";`).map((f) => f[0])).toEqual(["Private Key (RSA)"]); // pragma: allowlist secret
    expect(found(`var u="https://cdn.acme.test/img/a.png?k=${"sk_" + "live_"}${mixedRun(r, 24)}";`).map((f) => f[0])).toEqual(["Stripe Live Key"]);
  });

  test("a live-shaped key with a sample prefix or tail is not hidden by the sample list", () => {
    expect(found(`var k="${"sk_" + "live_"}${mixedRun(r, 24)}"; var s="${"sk_" + "test_"}4eC39HqLyjWDarjtT1zdp7dc";`).map((f) => f[0])).toEqual(["Stripe Live Key"]); // pragma: allowlist secret
  });
});

describe("PEM bodies in every form a page writes them (#1227)", () => {
  const r = seededRng(4242);
  const head = "-----BEGIN RSA PRIVATE KEY-----"; // pragma: allowlist secret
  const foot = "-----END RSA PRIVATE KEY-----";
  const l1 = mixedRun(r, 64, ALNUM + "+/");
  const l2 = mixedRun(r, 64, ALNUM + "+/");
  const reports = (text: string) => found(text).map((f) => f[0]);
  const forms: Record<string, string> = {
    "real newline in a template literal": `var k=\`${head}\n${l1}\n${l2}\n${foot}\`;`,
    "escaped \\n": `var k="${head}\\n${l1}\\n${l2}\\n${foot}";`,
    "escaped \\r\\n": `var k="${head}\\r\\n${l1}\\r\\n${l2}";`,
    "escaped \\u000a": `var k="${head}\\u000a${l1}\\u000a${l2}";`,
    "percent-encoded %0A": `var k="${head}%0A${l1}%0A${l2}";`,
    "entity &#10;": `var k="${head}&#10;${l1}&#10;${l2}";`,
    "entity &#13;&#10;": `var k="${head}&#13;&#10;${l1}&#13;&#10;${l2}";`,
    "spaces": `var k="${head} ${l1} ${l2} ${foot}";`,
    "one-line blob": `var k="${head}${l1}${l2}${foot}";`,
    "joined literals": `var k="${head}\\n" + "${l1}\\n" + "${l2}";`,
    "array joined, double quotes": `var k=["${head}","${l1}","${l2}","${foot}"].join("\\n");`,
    "array joined, single quotes": `var k=['${head}','${l1}','${l2}','${foot}'].join('\\n');`,
    "array joined, no spaces": `var k=["${head}",\n"${l1}",\n"${l2}"].join("\\n");`,
    "concat": `var k="${head}\\n".concat("${l1}\\n").concat("${l2}");`,
    "html br": `<p>${head}<br>${l1}<br>${l2}<br>${foot}</p>`,
    "html br slash": `<pre>${head}<br />${l1}<br />${l2}</pre>`,
    "html p and div per line": `<div>${head}</div><div>${l1}</div><p>${l2}</p>`,
    "html td, b, i and tt per line": `<td>${head}</td><b>${l1}</b><i>${l2}</i><tt>x</tt>`.replace("<tt>x</tt>", ""),
    "highlighted spans with long attributes": `<span class="line" data-line="1" style="color:#abb2bf;background:transparent;font-style:normal">${head}</span><span class="line" data-line="2" style="color:#abb2bf;background:transparent;font-style:normal">${l1}</span>`,
    "armor headers": `var k="${head}\\nProc-Type: 4,ENCRYPTED\\nDEK-Info: AES-128-CBC,${"ABCDEF0123456789".repeat(2)}\\n\\n${l1}";`,
  };

  for (const [form, text] of Object.entries(forms)) {
    test(`a real key reports: ${form}`, () => {
      expect(reports(text)).toEqual(["Private Key (RSA)"]);
    });
  }

  test("a header with nothing but prose or code before the next base64 run is not a key", () => {
    const run = mixedRun(r, 40, ALNUM);
    for (const text of [
      `var h="paste it: ${head}"; var id="${run}";`,
      `var h="${head}"; var n = 1; var id = "${run}";`,
      `var h="${head}\\nMIIE...\\n"; var id="${run}";`,
      `var h="${head}"+"${foot}"; var id="${run}";`,
      `<p>${head}</p><p>Copy it now</p><p>${run}</p>`,
      `var h="${head} Note: keep it safe ${run}";`,
    ]) {
      expect([text.slice(0, 50), reports(text)]).toEqual([text.slice(0, 50), []]);
    }
  });
});

describe("the PEM body check does bounded work per header (#1227)", () => {
  const head = "-----BEGIN RSA PRIVATE KEY-----"; // pragma: allowlist secret
  const MB5 = 5_000_000;

  test("headers repeated across 5 MB examine a bounded window each, not the rest of the page", () => {
    for (const unit of [`${head} `, `${head}${"A".repeat(31)} `, `${head}<br><br><p>`, `${head}\\n${"A".repeat(31)}`]) {
      const count = Math.floor(MB5 / unit.length);
      pemWork.examined = 0;
      scanContent(unit.repeat(count), "external-script", PAGE);
      // 600 characters is the most any one header reads.
      expect([unit.slice(0, 40), pemWork.examined <= count * 600]).toEqual([unit.slice(0, 40), true]);
    }
  });

  test("a header followed by hundreds of newlines before a short run stays linear (the armor-line check does not rescan whitespace)", () => {
    const unit = `${head}${"\n".repeat(399)}${"A".repeat(32)} `;
    const text = unit.repeat(Math.floor(MB5 / unit.length));
    const start = performance.now();
    scanContent(text, "external-script", PAGE);
    // 2.3 s before the lead class excluded newlines; well under a second after.
    expect(performance.now() - start).toBeLessThan(1500);
  });

  test("a header followed by a footer or another header reads only up to it", () => {
    pemWork.examined = 0;
    scanContent(`${head} ${head} ${head} `.repeat(1000), "external-script", PAGE);
    expect(pemWork.examined).toBeLessThanOrEqual(3000 * 2);
  });
});

describe("narrower allowlists after review (#1283, #1227)", () => {
  const r = seededRng(4343);

  test("a bearer handed over after a URL-encoded space or an equals sign still reports", () => {
    const token = "A".repeat(21) + `${mixedRun(r, 40)}%2B${mixedRun(r, 20)}%3D${mixedRun(r, 40)}`;
    for (const text of [`var u="/api?Authorization=Bearer+${token}";`, `var u="/api?access_token=${token}=";`, `var h="Authorization: Bearer ${token}";`]) {
      expect([text.slice(0, 40), found(text).map((f) => f[0]).includes("Twitter Bearer Token")]).toEqual([text.slice(0, 40), true]);
    }
  });

  test("a legacy OpenAI-style token followed by .map or .css, or by an image extension in running text, still reports", () => {
    const token = "sk-" + mixedRun(r, 48, ALNUM);
    for (const text of [`var u="/a/${token}.map";`, `var u="/a/${token}.css";`, `// the key is ${token}.png in the docs`]) {
      expect([text.slice(0, 30), found(text).map((f) => f[0])]).toEqual([text.slice(0, 30), ["OpenAI API Key (legacy)"]]);
    }
  });

  test("distinctive provider tokens followed by an asset-looking extension still report", () => {
    const tokens = [
      "sk-" + "ant-" + mixedRun(r, 90, ALNUM + "_-"),
      "AI" + "za" + mixedRun(r, 35, ALNUM + "_-"),
      "S" + "G." + mixedRun(r, 22, ALNUM) + "." + mixedRun(r, 43, ALNUM),
    ];
    for (const token of tokens) {
      for (const ext of ["css", "map", "png", "svg", "woff2"]) {
        expect([token.slice(0, 6), ext, found(`var u="/a/${token}.${ext}";`).length > 0]).toEqual([token.slice(0, 6), ext, true]);
      }
    }
  });

  test("data-secret-key and similar attributes are not a widget's client key", () => {
    const key = "sk_" + "live_" + runOf(r, "0123456789abcdef", 48);
    for (const attr of ["data-secret-key", "data-private-key", "data-server-token", "data-admin-key"]) {
      const reported = scanContent(`<div ${attr}="${key}"></div>`, "html", PAGE);
      expect([attr, reported[0]?.confidence, reported[0]?.extra?.hint]).toEqual([attr, "high", undefined]);
    }
  });
});

describe("differential probes: the classifier reads the same text the matcher matched", () => {
  const r = seededRng(2026);
  const ghp = () => githubToken(r, "ghp_");

  test("a structurally valid token followed by an asset extension still reports", () => {
    expect(found(`var u="/img/${ghp()}.svg";`).map((f) => f[0])).toEqual(["GitHub Personal Access Token"]);
    expect(found(`var k="${"sk_" + "live_"}${mixedRun(r, 24)}.png";`).map((f) => f[0])).toEqual(["Stripe Live Key"]);
  });

  test("a connection string cannot name a local host and connect elsewhere", () => {
    const url = (rest: string) => `var u="postgres://app:s3cret@${rest}";`; // pragma: allowlist secret
    expect(found(url("localhost/db?host=db.acme-prod.net")).map((f) => f[0])).toEqual(["PostgreSQL Connection String"]);
    expect(found(url("localhost/db?hostaddr=10.1.2.3")).map((f) => f[0])).toEqual(["PostgreSQL Connection String"]);
    // The last @ separates the host, whatever precedes it.
    expect(found(`var u="postgres://app:s3cret@localhost@db.acme-prod.net/db";`).map((f) => f[0])).toEqual(["PostgreSQL Connection String"]); // pragma: allowlist secret
    expect(found(url("localhost.acme-prod.net/db")).map((f) => f[0])).toEqual(["PostgreSQL Connection String"]);
  });

  test("zero-width characters, string joins and escapes do not hide a key body or a token", () => {
    const body = mixedRun(r, 64, ALNUM + "+/");
    const head = "-----BEGIN RSA PRIVATE KEY-----"; // pragma: allowlist secret
    expect(found(`var k="${head}\n\u200b${body}";`).map((f) => f[0])).toEqual(["Private Key (RSA)"]);
    expect(found(`var k="${head}\n"+\n"${body}";`).map((f) => f[0])).toEqual(["Private Key (RSA)"]);
    expect(found(`var k="${head}\n\u004d${body.slice(1)}";`).map((f) => f[0])).toEqual(["Private Key (RSA)"]);
    // A bearer written as \u0041 escapes is decoded once, for the matcher and the shape check alike.
    const escaped = "\\u0041".repeat(21) + `${mixedRun(r, 40)}%2B${mixedRun(r, 20)}%3D${mixedRun(r, 40)}`;
    expect(found(`var c={bearer:"${escaped}"};`).map((f) => f[0])).toEqual(["Twitter Bearer Token"]);
  });

  test("a key percent-encoded or inside a base64 blob next to a sample marker still reports", () => {
    const key = "sk_" + "live_" + mixedRun(r, 24);
    const cfg = `{"apiKey":"${key}","note":"example-password"}`;
    expect(found(`<div data-cfg="${encodeURIComponent(cfg)}"></div>`, "html").map((f) => f[0])).toEqual(["Stripe Live Key"]);
    expect(found(`window.__C__="${Buffer.from(`/* sample */ ${cfg}`).toString("base64")}";`).map((f) => f[0])).toEqual(["Stripe Live Key"]);
  });

  test("a sample marker in another case or script does not change what is a placeholder", () => {
    expect(found(`var o={PASSWORD:'EXAMPLE-PASSWORD'};`)).toEqual([]); // pragma: allowlist secret
    expect(found(`var o={password:'exa\u200bmple-password'};`).map((f) => f[0])).toEqual(["Generic Secret Assignment"]); // pragma: allowlist secret
  });
});

describe("bypass attempts: a real secret placed where an allowlist looks", () => {
  const MB = 1_000_000;
  const time = (text: string) => {
    const start = performance.now();
    scanContent(text, "external-script", PAGE);
    return performance.now() - start;
  };

  test("a megabyte of A, of PEM headers, of asset-extension look-alikes and of connection templates", () => {
    const inputs = [
      "A".repeat(MB),
      "var x=" + '"-----BEGIN RSA PRIVATE KEY-----"+'.repeat(MB / 40) + '"";', // pragma: allowlist secret
      "-----BEGIN RSA PRIVATE KEY-----\n".repeat(MB / 32), // pragma: allowlist secret
      `"neon_${"a".repeat(40)}.p" `.repeat(MB / 50),
      "postgres://" + "{{".repeat(MB / 4) + "@h/x",
      "AAAAAAAAAAAAAAAAAAAAAAAA%2F".repeat(MB / 27),
    ];
    for (const text of inputs) expect(time(text)).toBeLessThan(4000);
  });
});

describe("review follow-ups (#1283, #1227)", () => {
  const rng = seededRng(2026);
  const head = ["-----BEGIN ", "RSA PRIVATE KEY", "-----"].join("");
  const types = (text: string, location: SecretLocation = "inline-script") => found(text, location).map((f) => f[0]); // pragma: allowlist secret
  /** A body of `lines` base64 lines of `width` characters, mixed case with digits. */
  const wrapped = (width: number, lines: number) => Array.from({ length: lines }, () => mixedRun(rng, width, ALNUM + "+/"));

  describe("PEM bodies wrapped narrowly", () => {
    for (const width of [16, 20, 24, 30, 31, 32, 64]) {
      test(`a key wrapped at ${width} characters reports, however the lines are joined`, () => {
        const lines = wrapped(width, Math.ceil(300 / width));
        expect(types(`var k=\`${head}\n${lines.join("\n")}\n-----END RSA PRIVATE KEY-----\`;`)).toEqual(["Private Key (RSA)"]);
        expect(types(`var k="${head}\\n${lines.join("\\n")}";`)).toEqual(["Private Key (RSA)"]);
        expect(types(`var k="${head}%0A${lines.join("%0A")}";`)).toEqual(["Private Key (RSA)"]);
        expect(types(`var k="${head}%0a${lines.join("%0d%0a")}";`)).toEqual(["Private Key (RSA)"]);
        expect(types(`var k=${[head, ...lines].map((l) => JSON.stringify(`${l}\n`)).join(" + ")};`)).toEqual(["Private Key (RSA)"]);
        expect(types(`var k=[${[head, ...lines].map((l) => JSON.stringify(l)).join(",")}].join("\\n");`)).toEqual(["Private Key (RSA)"]);
        expect(types(`<pre>${head}<br>${lines.join("<br>")}</pre>`)).toEqual(["Private Key (RSA)"]);
      });
    }

    test("a run of 32 or more characters is a key even with code stuck to its end", () => {
      const run = wrapped(64, 1)[0];
      expect(types(`var k = ${head}${run}.trim();`)).toEqual(["Private Key (RSA)"]);
      expect(types(`var k = ${head}${run.slice(0, 31)}.trim();`)).toEqual([]);
    });

    test("a first line shorter than 32 characters before 64-character lines is a key", () => {
      for (const first of [16, 20, 27]) {
        const text = `var k="${head}\\n${wrapped(first, 1)[0]}\\n${wrapped(64, 2).join("\\n")}";`;
        expect(types(text)).toEqual(["Private Key (RSA)"]);
      }
    });

    test("narrow lines of words, a single short line, an elided body and prose stay silent", () => {
      for (const tail of [
        "\\nMIIEowIBAAKCAQEA\\n",
        "\\nMIIEowIBAAKCAQEA\\nMIIE...\\n",
        "\\nthe quick brown fox jumps over the lazy dog and keeps going",
        "\\ninternationalization characterization\\n",
        "\\nabcdefghijklmnop\\nabcdefghijklmnop\\n",
        "\\nMIIEowIBAAKCAQEA\\n\\u2026\\n",
        "\\nMIIEowIBAAKCAQEA, then more text here\\nAAAAAAAAAAAAAAAA",
      ]) {
        expect([tail, types(`var k="${head}${tail}";`)]).toEqual([tail, []]);
      }
    });

    test("the gap before the body is bounded at 400 characters", () => {
      const body = wrapped(64, 2).join("\n");
      expect(types(`var k=\`${head}${"\n".repeat(399)}${body}\`;`)).toEqual(["Private Key (RSA)"]);
      expect(types(`var k=\`${head}${"\n".repeat(401)}${body}\`;`)).toEqual([]);
      expect(types(`var k="${head}${"\\n".repeat(150)}${body.replace(/\n/g, "\\n")}";`)).toEqual(["Private Key (RSA)"]);
      expect(types(`var k="${head}${"\\n".repeat(250)}${body.replace(/\n/g, "\\n")}";`)).toEqual([]);
    });
  });

  describe("the narrow-wrap rule's own bounds", () => {
    const line = (n: number, alphabet = ALNUM + "+/") => mixedRun(rng, n, alphabet);
    const pem = (...lines: string[]) => types(`var k="${head}\\n${lines.join("\\n")}";`);
    const UPPER_DIGIT = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"; // pragma: allowlist secret
    const LOWER_DIGIT = "abcdefghjkmnpqrstuvwxyz0123456789"; // pragma: allowlist secret

    test("chunks under 16 characters are not lines of key: a body wrapped at 8, 12 or 15 is not matched", () => {
      for (const width of [8, 12, 15]) expect([width, pem(...Array.from({ length: 12 }, () => line(width)))]).toEqual([width, []]);
      expect(pem(...Array.from({ length: 12 }, () => line(16)))).toEqual(["Private Key (RSA)"]);
    });

    test("32 characters in all are needed: 16 + 15 is not a key, 16 + 16 and a lone run of 32 are", () => {
      expect(pem(line(16), line(15))).toEqual([]);
      expect(pem(line(16), line(16))).toEqual(["Private Key (RSA)"]);
      expect(pem(line(31))).toEqual([]);
      expect(pem(line(32))).toEqual(["Private Key (RSA)"]);
    });

    test("several chunks must mix upper case, lower case and a digit or `+` or `/`", () => {
      const run = (alphabet: string) => runOf(rng, alphabet, 16);
      const two = (alphabet: string) => pem(run(alphabet), run(alphabet));
      // each part missing in turn
      expect(two(LOWER_DIGIT)).toEqual([]);
      expect(two(UPPER_DIGIT)).toEqual([]);
      expect(two("abcdefghijklmnopqrstuvwxyz" + "abcdefghijklmnopqrstuvwxyz".toUpperCase())).toEqual([]);
      // each way of satisfying the third part
      expect(pem("AbCdEfGhIjKlMnOp", "qRsTuVwXyZaBcDe" + "1")).toEqual(["Private Key (RSA)"]);
      expect(pem("AbCdEfGhIjKlMnOp", "qRsTuVwXyZaBcDe" + "+")).toEqual(["Private Key (RSA)"]);
      expect(pem("AbCdEfGhIjKlMnOp", "qRsTuVwXyZaBcDe" + "/")).toEqual(["Private Key (RSA)"]);
      // a single run of 32 is not subject to the mix check
      expect(pem("a".repeat(32))).toEqual(["Private Key (RSA)"]);
    });

    test("a word or any non-base64 token after the first chunk ends the body", () => {
      expect(pem(line(16), "and", line(16))).toEqual([]);
      expect(pem(line(16), "MIIE...", line(16))).toEqual([]);
      expect(pem(line(16), line(10), line(16))).toEqual([]);
      // a chunk with code stuck to it ends the body at the 16 characters read so far
      expect(pem(line(16), line(16) + ".map", line(16))).toEqual([]);
    });

    test("filler between chunks counts against the 600 characters read after the header", () => {
      const filler = (n: number) => "\\n".repeat(n);
      const spread = (n: number) => types(`var k="${head}\\n${line(16)}${filler(n)}${line(16)}";`);
      expect(spread(100)).toEqual(["Private Key (RSA)"]);
      // 500 characters of filler between the chunks is past the 400 allowed before the FIRST chunk, and still read
      expect(spread(250)).toEqual(["Private Key (RSA)"]);
      expect(spread(400)).toEqual([]);
    });
  });

  describe("Paystack and Stripe keys", () => {
    const live = `${"sk_" + "live_"}${runOf(rng, HEX, 40)}`;
    const test_ = `${"sk_" + "test_"}${runOf(rng, HEX, 40)}`;

    test("a Paystack live key is a shipped server secret in a browser-served script, and only there", () => {
      const inline = scanContent(`var k="${live}";`, "inline-script", PAGE);
      const external = scanContent(`var k="${live}";`, "external-script", PAGE);
      const markup = scanContent(`<div data-x="${live}"></div>`, "html", PAGE);
      expect([inline, external, markup].map((r) => r.map((f) => f.type))).toEqual([["Paystack Live Secret Key"], ["Paystack Live Secret Key"], ["Paystack Live Secret Key"]]);
      expect(inline.map(isShippedServerSecret)).toEqual([true]);
      expect(external.map(isShippedServerSecret)).toEqual([true]);
      expect(markup.map(isShippedServerSecret)).toEqual([false]);
      // A test-mode key is not a live secret.
      expect(scanContent(`var k="${test_}";`, "inline-script", PAGE).map(isShippedServerSecret)).toEqual([false]);
    });

    test("both of Stripe's published sample tails are suppressed under every secret prefix", () => {
      for (const tail of ["4eC39HqLyjWDarjtT1zdp7dc", "BQokikJOvBiI2HlWgH4olfQ2"]) { // pragma: allowlist secret
        for (const prefix of ["sk_" + "test_", "sk_" + "live_", "rk_" + "test_", "rk_" + "live_"]) {
          expect([tail, prefix, found(`var k="${prefix}${tail}";`)]).toEqual([tail, prefix, []]);
        }
        expect(types(`var k="${"sk_" + "live_"}${tail.slice(0, -1)}x";`)).toEqual(["Stripe Live Key"]);
      }
    });

    test("the hex tail needs 32 characters to be another vendor's: 31 stays Stripe's shape", () => {
      const prefix = "sk_" + "live_";
      expect(types(`var k="${prefix}${runOf(rng, HEX, 31)}";`)).toEqual(["Stripe Live Key"]);
      expect(types(`var k="${prefix}${runOf(rng, HEX, 40)}";`)).toEqual(["Paystack Live Secret Key"]);
      const widget = found(`var k="${prefix}${runOf(rng, HEX, 48)}";`);
      expect(widget.map((f) => f[0])).not.toEqual(["Stripe Live Key"]);
      expect(widget.map((f) => f[0])).not.toEqual(["Paystack Live Secret Key"]);
    });
  });

  describe("connection strings", () => {
    const pg = (userinfo: string, hosts: string, tail = "/app") => ["postgres", "://", userinfo, "@", hosts, tail].join("");

    test("a docs password on several hosts is dropped only when EVERY host is unreachable", () => {
      expect(types(`var u="${pg("app:s3cret", "localhost,127.0.0.1:5432")}";`)).toEqual([]);
      expect(types(`var u="${pg("app:s3cret", "localhost,db.acme-prod.net:5432")}";`)).toEqual(["PostgreSQL Connection String"]);
      expect(types(`var u="${pg("app:s3cret", "db.acme-prod.net,localhost")}";`)).toEqual(["PostgreSQL Connection String"]);
    });

    test("the docs-password length cap is 24 characters, the digit suffix is up to four", () => {
      const doc = (password: string) => types(`var u="${pg(`app:${password}`, "localhost")}";`);
      expect(doc("examplepassword")).toEqual([]);
      expect(doc("password1234")).toEqual([]);
      expect(doc("password12345")).toEqual(["PostgreSQL Connection String"]);
      expect(doc("passwordpasswordpasswordp")).toEqual(["PostgreSQL Connection String"]);
      expect(doc("passwordpasswordpassword")).toEqual([]);
    });

    test("a password in the query string is read like one in the authority", () => {
      const query = (password: string, host = "localhost") => types(`var u="${["postgres", "://app@", host, "/app?password=", password].join("")}";`);
      expect(query("s3cret")).toEqual([]);
      expect(query(mixedRun(rng, 16, ALNUM))).toEqual(["PostgreSQL Connection String"]);
      expect(query("s3cret", "db.acme-prod.net")).toEqual(["PostgreSQL Connection String"]);
    });
  });

  describe("placeholders and sample tokens", () => {
    test("example-* is a placeholder only with at most four digits and only as the whole value", () => {
      for (const word of ["example-password1234", "--example-password", "-example-password"]) {
        expect([word, found(`var o = { password: '${word}' };`)]).toEqual([word, []]);
      }
      for (const word of ["example-password12345", "ab-example-password", "example-password-x"]) {
        expect([word, found(`var o = { password: '${word}' };`).length]).toEqual([word, 1]);
      }
    });

    test("the jwt.io sample with another name is a different token, even signed with a published secret", () => {
      const sample = { sub: "1234567890", name: "John Doe", iat: 1516239022 };
      expect(found(`var t="${signed(sample, "your-256-bit-secret")}";`)).toEqual([]);
      for (const name of ["Jane Doe", "john doe", "John  Doe", ""]) {
        expect([name, found(`var t="${signed({ ...sample, name }, "your-256-bit-secret")}";`).length > 0]).toEqual([name, true]);
      }
    });
  });
});
