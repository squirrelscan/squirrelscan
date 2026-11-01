// security/leaked-secrets: a `JSON Web Token` match is reported only when it decodes to a JWT (#1283): a header and a
// payload that are JSON objects. A part within the read bound that is not a JSON object is dropped; a part too long to read, nested too deeply to parse or empty is undecided and reported. Synthetic values.

import { describe, expect, test } from "bun:test";

import { scanContent, type SecretLocation } from "../../src/security/leaked-secrets";
import { runOf, seededRng } from "./leaked-secrets/generators";

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const URLSAFE = `${LOWER}${LOWER.toUpperCase()}0123456789_-`;
const PAGE = "https://app.acme.test/";
const r = seededRng(1283);

const types = (text: string, location: SecretLocation = "inline-script") => scanContent(text, location, PAGE).map((f) => f.type); // pragma: allowlist secret
const b64u = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const sig = () => runOf(r, URLSAFE, 43);

describe("eyJ-shaped runs that are not JWTs are dropped", () => {
  test("an eyJ run with two dots whose parts are not JSON", () => {
    for (const text of [
      `var t="eyJ${runOf(r, URLSAFE, 30)}.eyJ${runOf(r, URLSAFE, 60)}.${sig()}";`,
      `var t="eyJ${runOf(r, URLSAFE, 40)}.${runOf(r, URLSAFE, 60)}.${sig()}";`,
      `var t='eyJ${runOf(r, URLSAFE, 36)}.eyJ${runOf(r, URLSAFE, 36)}.${sig()}';`,
    ]) {
      expect([text.slice(0, 30), types(text)]).toEqual([text.slice(0, 30), []]);
    }
  });

  test("a header or payload that is JSON but not an object, a header with no alg over a payload that is not JSON", () => {
    const payload = b64u({ sub: "u1", pad: "p".repeat(60) });
    const header = b64u({ alg: "HS256", typ: "JWT" });
    for (const value of [
      `${b64u(["alg", "HS256"])}.${payload}.${sig()}`,
      `${b64u({ typ: "JWT" })}.${"x".repeat(60)}.${sig()}`,
      `${header}.${b64u([1, 2, 3])}.${sig()}`,
      `${header}.${b64u("text")}.${sig()}`,
      `${header}.${b64u(null)}.${sig()}`,
    ]) {
      expect([value.slice(0, 24), types(`var t="${value}";`)]).toEqual([value.slice(0, 24), []]);
    }
  });

  test("in markup, an attribute and a script, the same shapes are dropped", () => {
    const value = `eyJ${runOf(r, URLSAFE, 36)}.eyJ${runOf(r, URLSAFE, 60)}.${sig()}`;
    expect(types(`<div data-token="${value}"></div>`, "html")).toEqual([]);
    expect(types(`<script>window.__S={"session":"${value}"}</script>`, "html")).toEqual([]);
  });
});

describe("a token that cannot be read in full is reported, never dropped (fail closed)", () => {
  const header = b64u({ alg: "HS256", typ: "JWT" });

  test("a real token with a payload or header past what is decoded (8,192 characters per part)", () => {
    const wide = b64u({ sub: "u1", pad: "p".repeat(7_000) });
    const huge = b64u({ sub: "u1", pad: "p".repeat(20_000) });
    const longHeader = b64u({ alg: "HS256", kid: "k".repeat(9_000) });
    for (const [name, value] of Object.entries({
      wide: `${header}.${wide}.${sig()}`,
      huge: `${header}.${huge}.${sig()}`,
      longHeader: `${longHeader}.${b64u({ sub: "u1" })}.${sig()}`,
    })) {
      expect([name, types(`var t="${value}";`)]).toEqual([name, ["JSON Web Token"]]);
    }
  });

  test("a good header over a payload within the bound that is not JSON is proof, so it drops", () => {
    expect(types(`var t="${header}.eyJ${runOf(r, URLSAFE, 60)}.${sig()}";`)).toEqual([]);
  });
});

describe("real JWTs still report", () => {
  const payload = (extra: Record<string, unknown> = {}) => b64u({ sub: "u1", pad: "p".repeat(60), ...extra });

  test("any string alg, alg none, an expired token, extra header fields, an admin scope", () => {
    for (const alg of ["HS256", "RS256", "ES384", "none", "EdDSA"]) {
      expect([alg, types(`var t="${b64u({ alg, typ: "JWT" })}.${payload()}.${sig()}";`)]).toEqual([alg, ["JSON Web Token"]]);
    }
    expect(types(`var t="${b64u({ alg: "HS256", kid: "k1", x5t: "abc" })}.${payload()}.${sig()}";`)).toEqual(["JSON Web Token"]);
    expect(types(`var t="${b64u({ alg: "HS256" })}.${payload({ exp: 1_000_000_000 })}.${sig()}";`)).toEqual(["JSON Web Token (expired)"]);
    expect(types(`var t="${b64u({ alg: "HS256" })}.${payload({ scope: "admin" })}.${sig()}";`)).toEqual(["JSON Web Token (admin scope)"]);
  });
});
