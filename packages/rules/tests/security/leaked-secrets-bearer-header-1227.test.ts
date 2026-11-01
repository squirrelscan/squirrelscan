// security/leaked-secrets: a Bearer value that is only the header segment of a JWT is not a credential (#1227).
// A full `Bearer <JWT>` and an opaque bearer token still report. Synthetic values, built at runtime.

import { describe, expect, test } from "bun:test";

import { scanContent, type SecretLocation } from "../../src/security/leaked-secrets";
import { mixedRun, runOf, seededRng } from "./leaked-secrets/generators";

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PAGE = "https://app.acme.test/";
const r = seededRng(1227);

const found = (text: string, location: SecretLocation = "inline-script") => scanContent(text, location, PAGE).map((f) => [f.type, f.confidence]); // pragma: allowlist secret
const b64u = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const HEADER = b64u({ alg: "HS256", typ: "JWT" });
const TYP_FIRST = b64u({ typ: "JWT", alg: "HS256" });

describe("a header-only JWT after Bearer", () => {
  test("is not reported, whole or truncated, with either first key, in any wording around it", () => {
    for (const header of [HEADER, HEADER.slice(0, 20), HEADER.slice(0, 28), TYP_FIRST, TYP_FIRST.slice(0, 24), b64u({ kid: "k1", alg: "RS256" }), b64u({ cty: "JWT", alg: "HS256" })]) {
      for (const [text, location] of [
        [`var h="Authorization: Bearer ${header}";`, "inline-script"],
        [`curl -H 'Authorization: Bearer ${header}' https://api.acme.test/v1`, "inline-script"],
        [`<code>Authorization: Bearer ${header}</code>`, "html"],
        [`var h={Authorization:"Bearer ${header}"};`, "inline-script"],
        [`var h="Bearer ${header}.";`, "inline-script"],
      ] as const) {
        expect([header.length, text.slice(0, 40), found(text, location)]).toEqual([header.length, text.slice(0, 40), []]);
      }
    }
  });

  test("a full Bearer JWT still reports, once", () => {
    const token = `${HEADER}.${b64u({ sub: "u1", iat: 1761000000 })}.${runOf(r, ALNUM, 43)}`;
    const reported = found(`var h="Authorization: Bearer ${token}";`).map((f) => f[0]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("JSON Web Token");
    // a head followed by a payload but no signature is still a token
    const unsigned = `${HEADER}.${b64u({ sub: "u1", iat: 1761000000, scope: "read" })}`;
    expect(found(`var h="Authorization: Bearer ${unsigned}";`).length).toBeGreaterThan(0);
  });

  test("an opaque bearer token still reports, including one that starts like a JWT head without being one", () => {
    expect(found(`var h="Authorization: Bearer ${mixedRun(r, 40)}";`)).toEqual([["Bearer Token", "medium"]]);
    // base64 of another JSON object, and of a header whose first key is not a JWT one
    const other = b64u({ token: runOf(r, ALNUM, 32), user: "u1" });
    expect(other.startsWith("eyJ")).toBe(true);
    expect(found(`var h="Authorization: Bearer ${other}";`)).toEqual([["Bearer Token", "medium"]]);
    const noAlg = b64u({ foo: runOf(r, ALNUM, 24), bar: 1 });
    expect(found(`var h="Authorization: Bearer ${noAlg}";`)).toEqual([["Bearer Token", "medium"]]);
    // eyJ followed by characters that do not decode to JSON at all
    expect(found(`var h="Authorization: Bearer eyJ${runOf(r, ALNUM, 40)}";`)).toEqual([["Bearer Token", "medium"]]);
  });

  test("the alg or typ key has to open the decoded header: a header that merely contains one is an opaque value", () => {
    const later = b64u({ foo: "bar", alg: "HS256" });
    expect(found(`var h="Authorization: Bearer ${later}";`)).toEqual([["Bearer Token", "medium"]]);
    const nested = b64u({ cfg: { alg: "HS256", note: runOf(r, ALNUM, 20) } });
    expect(found(`var h="Authorization: Bearer ${nested}";`)).toEqual([["Bearer Token", "medium"]]);
  });
});

describe("only a complete or short truncated JOSE header is dropped", () => {
  test("an opaque JSON bearer value that merely opens with alg, typ, kid or cty reports, at any length", () => {
    for (const pad of [120, 1_000]) {
      for (const value of [
        b64u({ typ: "access", sub: "u1", pad: runOf(r, ALNUM, pad) }),
        b64u({ alg: "x", sub: "u", token: runOf(r, ALNUM, pad) }),
        b64u({ kid: "k1", user: "u1", pad: runOf(r, ALNUM, pad) }),
        b64u({ cty: "x", pad: runOf(r, ALNUM, pad) }),
      ]) {
        expect([value.length, found(`var h="Authorization: Bearer ${value}";`)]).toEqual([value.length, [["Bearer Token", "medium"]]]);
      }
    }
  });

  test("a complete header is dropped with any JOSE key and needs an alg; a long truncated one is not a header", () => {
    for (const header of [{ alg: "ES256", typ: "JWT", kid: "k1" }, { alg: "RS256", x5t: "abc", "x5t#S256": "def" }, { alg: "dir", enc: "A128GCM", zip: "DEF" }]) {
      expect([JSON.stringify(header), found(`var h="Authorization: Bearer ${b64u(header)}";`)]).toEqual([JSON.stringify(header), []]);
    }
    // a JOSE-only object with no alg is not a complete header
    expect(found(`var h="Authorization: Bearer ${b64u({ typ: "JWT", kid: "k1" })}";`)).toEqual([["Bearer Token", "medium"]]);
    // cut mid-JSON but past 64 characters: opaque
    const long = b64u({ alg: "HS256", typ: "JWT", kid: runOf(r, ALNUM, 80) }).slice(0, 100);
    expect(found(`var h="Authorization: Bearer ${long}";`)).toEqual([["Bearer Token", "medium"]]);
    // a complete JOSE header past 2,048 characters is not read as one
    expect(found(`var h="Authorization: Bearer ${b64u({ alg: "HS256", kid: runOf(r, ALNUM, 2_100) })}";`)).toEqual([["Bearer Token", "medium"]]);
    // cut mid-JSON and short, but not opening like a header
    expect(found(`var h="Authorization: Bearer ${b64u({ sub: "u1", alg: "HS256", pad: "pppppp" }).slice(0, 36)}";`)).toEqual([["Bearer Token", "medium"]]);
    // cut mid-JSON, short, opening like a header
    expect(found(`var h="Authorization: Bearer ${b64u({ alg: "HS256", typ: "JWT" }).slice(0, 40)}";`)).toEqual([]);
  });
});

describe("a real JWT after Bearer is not dropped when its separator is not a plain dot", () => {
  const payload = b64u({ sub: "u1", iat: 1761000000, pad: runOf(r, ALNUM, 30) });
  const sig = runOf(r, ALNUM, 43);
  test("%2E, a space, a comma, an escaped newline and a dot with a dash behind it", () => {
    for (const [label, token] of [
      ["%2E", `${HEADER}%2E${payload}%2E${sig}`],
      ["space", `${HEADER} ${payload} ${sig}`],
      ["comma", `${HEADER},${payload},${sig}`],
      ["escaped newline", `${HEADER}\\n.${payload}\\n.${sig}`],
      ["newline", `${HEADER}\n.${payload}.${sig}`],
      ["dot dash", `${HEADER}.-${payload}.${sig}`],
      ["comma then eyJ", `${HEADER}, ${payload}`],
    ] as Array<[string, string]>) {
      expect([label, found(`var h="Authorization: Bearer ${token}";`).length > 0]).toEqual([label, true]);
    }
  });

  test("the end of the text, a quote, a bracket, a sentence period and a space before other text still drop a header", () => {
    for (const tail of ['"', "'", ")", "]", "}", ">", ".", ". Next", " and more", ", then text", "\n", ""]) {
      expect([tail, found(`curl -H Bearer ${HEADER}${tail}`)]).toEqual([tail, []]);
    }
  });
});
