// security/leaked-secrets: a `JSON Web Token` match is reported only when it decodes to a JWT (#1283): a header and a
// payload that are JSON objects. A part within the read bound that is not a JSON object is dropped; a part too long to read, nested too deeply to parse or empty is undecided and reported. Synthetic values.

import { describe, expect, test } from "bun:test";

import { scanContent, scanContentBounded, type SecretLocation } from "../../src/security/leaked-secrets";
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

describe("a decoy segment before a real token", () => {
  const real = `${b64u({ alg: "HS256" })}.${b64u({ role: "service_role", iss: "supabase", ref: "abc", pad: "p".repeat(40) })}.${sig()}`;
  const decoy = (c: string) => `eyJ${c.repeat(30)}`;

  test("one decoy: the real token is classified, not dropped; a space between them is a plain token", () => {
    expect(types(`var t="${decoy("a")}.${real}";`)).toEqual(["Supabase Service Role JWT"]);
    expect(types(`var t="${decoy("a")} ${real}";`)).toEqual(["Supabase Service Role JWT"]);
  });

  const scan = (text: string) => scanContent(`var t="${text}";`, "inline-script", PAGE); // pragma: allowlist secret

  test("one decoy: the whole real token is the value, with its own classification (#1530)", () => {
    const found = scan(`${decoy("a")}.${real}`);
    expect(found.map((f) => [f.type, f.value])).toEqual([["Supabase Service Role JWT", real]]);
    expect(found[0]!.length).toBe(real.length);
  });

  test("two, three and many decoys in a row: the real token is reported the same way (#1530)", () => {
    for (const count of [2, 3, 5, 20]) {
      const decoys = Array.from({ length: count }, (_, i) => decoy("abcdefghijklmnopqrstuvwxyz"[i % 26]!));
      const found = scan(`${decoys.join(".")}.${real}`);
      expect([count, found.map((f) => [f.type, f.value])]).toEqual([count, [["Supabase Service Role JWT", real]]]);
    }
  });

  test("a crafted decoy that is valid JSON does not hide the real token", () => {
    const jsonDecoy = b64u({ a: "x".repeat(30) });
    const algDecoy = b64u({ alg: "HS256", pad: "p".repeat(30) });
    for (const d of [jsonDecoy, algDecoy]) {
      expect(scan(`${d}.${real}`).map((f) => [f.type, f.value])).toEqual([["Supabase Service Role JWT", real]]);
      expect(scan(`${d}.${d}.${real}`).map((f) => [f.type, f.value])).toEqual([["Supabase Service Role JWT", real]]);
    }
  });

  test("mixed valid decoys, with and without an alg, in either order, 2 and 3 deep: the real token is found and no decoy is reported", () => {
    const withAlg = (pad: string) => b64u({ alg: "HS256", pad: pad.repeat(30) });
    const noAlg = (pad: string) => b64u({ a: pad.repeat(30) });
    const orders: Array<[string, string[]]> = [
      ["alg then none", [withAlg("a"), noAlg("b")]],
      ["none then alg", [noAlg("a"), withAlg("b")]],
      ["alg, none, alg", [withAlg("a"), noAlg("b"), withAlg("c")]],
      ["none, alg, none", [noAlg("a"), withAlg("b"), noAlg("c")]],
      ["alg, none, none", [withAlg("a"), noAlg("b"), noAlg("c")]],
      ["alg, alg, none", [withAlg("a"), withAlg("b"), noAlg("c")]],
    ];
    for (const [name, decoys] of orders) {
      const found = scan(`${decoys.join(".")}.${real}`);
      expect([name, found.map((f) => [f.type, f.value])]).toEqual([name, [["Supabase Service Role JWT", real]]]);
    }
  });

  test("a real token with an unrelated token after it is not replaced", () => {
    const other = `${b64u({ alg: "HS256" })}.${b64u({ sub: "u2", pad: "p".repeat(40) })}.${sig()}`;
    expect(scan(`${real} ${other}`).map((f) => f.type)).toEqual(["Supabase Service Role JWT", "JSON Web Token"]);
    expect(scan(`${other} ${real}`).map((f) => f.type)).toEqual(["JSON Web Token", "Supabase Service Role JWT"]);
  });

  test("a run of eyJ segments that do not decode, with no real token, reports nothing", () => {
    expect(types(`var t="${[decoy("a"), decoy("b"), decoy("c"), decoy("d")].join(".")}";`)).toEqual([]);
    expect(types(`var t="${decoy("a")}.${decoy("b")}.${sig()}";`)).toEqual([]);
  });

  test("999 decoys in a row still find the real token (the retry cap is 1,000 steps a page)", () => {
    const decoys = Array.from({ length: 999 }, () => decoy("a")).join(".");
    const found = scanContentBounded(`var t="${decoys}.${real}";`, "inline-script", PAGE);
    expect(found.secrets.map((f) => [f.type, f.value])).toEqual([["Supabase Service Role JWT", real]]);
    expect(found.omitted).toBe(0);
  }, 30_000);

  test("10 MB of 13-character eyJ segments finishes fast and the page is reported as not fully read", () => {
    const text = `var t="${"eyJaaaaaaaaaa.".repeat(Math.ceil(10_000_000 / 14))}";`;
    const started = performance.now();
    const found = scanContentBounded(text, "inline-script", PAGE);
    const ms = performance.now() - started;
    expect(ms).toBeLessThan(1_000);
    expect(found.omitted).toBeGreaterThan(0);
  }, 30_000);

  test("a run of eyJ segments stays linear, with and without a real token at the end", () => {
    const time = (text: string) => {
      const started = performance.now();
      const found = types(text);
      return { found, ms: performance.now() - started };
    };
    // 100,000 characters of `eyJ.`: no segment is long enough to match
    const dots = time(`var t="${"eyJ.".repeat(25_000)}";`);
    expect(dots.found).toEqual([]);
    expect(dots.ms).toBeLessThan(2_000);
    // long segments: 100,000 characters of 13-character decoys, then the real token
    const run = `${decoy("a").slice(0, 13)}.`.repeat(8_000);
    const none = time(`var t="${run}";`);
    expect(none.found).toEqual([]);
    expect(none.ms).toBeLessThan(2_000);
    const withReal = time(`var t="${run}${real}";`);
    // past the retry cap (1,000 steps) the real token behind 8,000 decoys is not looked for: the page is reported as partial instead
    expect(withReal.found).toEqual([]);
    expect(scanContentBounded(`var t="${run}${real}";`, "inline-script", PAGE).omitted).toBeGreaterThan(0);
    expect(withReal.ms).toBeLessThan(2_000);
    // separate runs, each ending without a real token, many times over
    const many = time(`${`var t="${decoy("a")}.${decoy("b")}.${decoy("c")}";`}\n`.repeat(2_000));
    expect(many.found).toEqual([]);
    expect(many.ms).toBeLessThan(2_000);
    // doubling the run does not quadruple the time
    const small = Math.max(time(`var t="${run.repeat(2)}";`).ms, 5);
    const large = time(`var t="${run.repeat(8)}";`).ms;
    expect(large / small).toBeLessThan(12);
  }, 60_000);
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
