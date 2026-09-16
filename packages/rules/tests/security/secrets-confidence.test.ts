// security/leaked-secrets — token decoders (#361).
//
// Every decoder is proven against a value built here, and where the format
// has an independent reference (CRC32, base32) the test computes it with its
// own code rather than the detector's. No test here or anywhere in the scan
// path may reach the network: the last block replaces `fetch` with a throw and
// runs every decoder through the scanner.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { scanContent } from "../../src/security/leaked-secrets";
import {
  base62,
  crc32,
  decodeAlgoliaSecuredKey,
  decodeAwsAccountId,
  decodeJwt,
  githubChecksum,
  githubChecksumValid,
  heldAsCredential,
  refineFinding,
} from "../../src/security/secrets/confidence";

const j = (parts: string[]) => parts.join("");
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // pragma: allowlist secret
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// A small seeded RNG so a failure reproduces.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const runOf = (r: () => number, alphabet: string, n: number) =>
  Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join("");

describe("GitHub token checksum", () => {
  test("crc32 agrees with Bun's implementation on random bodies", () => {
    const r = rng(1);
    for (let i = 0; i < 200; i++) {
      const body = runOf(r, ALNUM, 30);
      expect(crc32(body)).toBe(Bun.hash.crc32(body));
    }
    expect(crc32("")).toBe(0);
    expect(crc32("The quick brown fox jumps over the lazy dog")).toBe(0x414fa339);
  });

  test("base62 uses 0-9A-Za-z and pads on the left", () => {
    expect(base62(0, 6)).toBe("000000");
    expect(base62(61, 6)).toBe("00000z");
    expect(base62(62, 6)).toBe("000010");
    expect(base62(0xffffffff, 6)).toBe("4gfFC3");
  });

  test("the documented, expired ghp_ token checks out; one changed character does not", () => {
    // From the public reverse-engineering notes on the format, an expired
    // token: body `zQWBuTSOoRi4A9spHcVY5ncnsDkxkJ`, checksum `0mLq17`.
    const body = "zQWBuTSOoRi4A9spHcVY5ncnsDkxkJ"; // pragma: allowlist secret
    const token = j(["gh", "p_"]) + body + "0mLq17";
    expect(githubChecksum(body)).toBe("0mLq17");
    expect(githubChecksumValid(token)).toBe(true);
    expect(githubChecksumValid(token.slice(0, -1) + "8")).toBe(false);
    expect(githubChecksumValid(token.slice(0, 4) + "a" + token.slice(5))).toBe(false);
  });

  test("checksum computed independently: base62(crc32(body)) padded to 6", () => {
    const r = rng(2);
    // Written out here rather than imported: Bun's CRC32 and a plain base62
    // conversion over the documented alphabet, digits before letters.
    const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const independent = (n: number) => {
      let out = "";
      let x = n;
      while (x > 0) {
        out = B62[x % 62]! + out;
        x = Math.floor(x / 62);
      }
      return out.padStart(6, "0");
    };
    for (let i = 0; i < 50; i++) {
      const body = runOf(r, ALNUM, 30);
      expect(githubChecksum(body)).toBe(independent(Bun.hash.crc32(body)));
    }
  });

  test("a wrong checksum drops the finding; a right one is high with no provider call", () => {
    const r = rng(3);
    const body = runOf(r, ALNUM, 30);
    const good = j(["gh", "p_"]) + body + githubChecksum(body);
    const bad = j(["gh", "o_"]) + body + "zzzzzz";
    const found = scanContent(`var a="${good}",b="${bad}";`, "inline-script");
    expect(found.map((f) => [f.type, f.confidence, f.extra])).toEqual([
      ["GitHub Personal Access Token", "high", { checksum: "valid" }],
    ]);
  });
});

describe("AWS access key id", () => {
  // Independent base32 decode: 16 chars → 80 bits, big-endian; the first 6
  // bytes masked and shifted give the account id.
  function referenceAccountId(keyId: string): string | null {
    const suffix = keyId.slice(4);
    const bits: number[] = [];
    for (const ch of suffix) {
      const v = B32.indexOf(ch);
      if (v < 0) return null;
      for (let b = 4; b >= 0; b--) bits.push((v >> b) & 1);
    }
    let n = 0n;
    for (const bit of bits.slice(0, 48)) n = (n << 1n) | BigInt(bit);
    const id = (n & 0x7fffffffff80n) >> 7n;
    // 40 bits reach past 999 999 999 999; AWS account ids never do.
    return id > 999_999_999_999n ? null : id.toString().padStart(12, "0");
  }

  test("decodes the account id of the documented example id", () => {
    // AWS's own documentation example id (not a real key).
    expect(decodeAwsAccountId(j(["AK", "IA"]) + "IOSFODNN7EXAMPLE")).toBe("581039954779");
  });

  test("agrees with an independent decode on random base32 suffixes", () => {
    const r = rng(4);
    let decodable = 0;
    for (let i = 0; i < 200; i++) {
      const id = j(["AS", "IA"]) + runOf(r, B32, 16);
      const decoded = decodeAwsAccountId(id);
      expect(decoded).toBe(referenceAccountId(id));
      if (decoded !== null) {
        decodable++;
        expect(decoded).toMatch(/^\d{12}$/);
      }
    }
    // Most random suffixes decode; the ~9% above the largest id do not.
    expect(decodable).toBeGreaterThan(150);
    expect(decodable).toBeLessThan(200);
  });

  test("a suffix outside the base32 alphabet does not decode", () => {
    expect(decodeAwsAccountId(j(["AK", "IA"]) + "0123456789ABCDEF")).toBeNull();
    expect(decodeAwsAccountId(j(["AK", "IA"]) + "ABCDEFGHIJKLMNO1")).toBeNull();
    expect(decodeAwsAccountId(j(["AK", "IA"]) + "ABC")).toBeNull();
  });

  test("decodable ids report high with the account id; undecodable ones medium", () => {
    const r = rng(5);
    let good = "";
    do good = j(["AK", "IA"]) + runOf(r, B32, 16).replace(/DO/g, "DQ");
    while (decodeAwsAccountId(good) === null);
    const bad = j(["AK", "IA"]) + "8" + runOf(r, B32, 15).replace(/DO/g, "DQ");
    const found = scanContent(`var a="${good}",b="${bad}";`, "inline-script");
    expect(found.map((f) => [f.type, f.confidence, f.extra?.accountId])).toEqual([
      ["AWS Access Key ID", "high", decodeAwsAccountId(good)!],
      ["AWS Access Key ID", "medium", "undecodable"],
    ]);
  });
});

describe("JWT claims", () => {
  const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64u({ alg: "HS256", typ: "JWT" });
  const token = (claims: Record<string, unknown>) =>
    `${header}.${b64u({ iat: 1700000000, pad: "p".repeat(80), ...claims })}.c2ln`;
  const NOW = Date.UTC(2026, 8, 16);

  test("decodes header and payload, and rejects non-JSON parts", () => {
    const t = token({ iss: "supabase", role: "anon" });
    expect(decodeJwt(t)?.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(decodeJwt(t)?.payload.role).toBe("anon");
    expect(decodeJwt(`${header}.${Buffer.from("not json").toString("base64url")}`)).toBeNull();
    expect(decodeJwt(`${header}.${b64u([1, 2])}`)).toBeNull();
    expect(decodeJwt(`${header}.${b64u(null)}`)).toBeNull();
    expect(decodeJwt(header)).toBeNull();
  });

  test("Supabase service_role is high, anon is public, other roles medium", () => {
    const sr = refineFinding("Supabase Anon Key", token({ iss: "supabase", ref: "abcdefghij", role: "service_role", exp: 2000000000 }), NOW);
    expect(sr).toMatchObject({ type: "Supabase Service Role JWT", confidence: "high", publicByDesign: false });
    expect(sr?.extra).toMatchObject({ issuer: "supabase", role: "service_role", projectRef: "abcdefghij", expired: false });

    const anon = refineFinding("Supabase Anon Key", token({ iss: "supabase", ref: "abcdefghij", role: "anon", exp: 2000000000 }), NOW);
    expect(anon).toMatchObject({ type: "Supabase Anon Key", confidence: "medium", publicByDesign: true });

    const user = refineFinding("Supabase Anon Key", token({ iss: "supabase", ref: "abcdefghij", role: "authenticated", exp: 2000000000 }), NOW);
    expect(user).toMatchObject({ type: "Supabase JWT", confidence: "medium", publicByDesign: false });
  });

  test("an expired token is info whatever its role", () => {
    const expired = refineFinding("Supabase Anon Key", token({ iss: "supabase", ref: "abcdefghij", role: "service_role", exp: 1600000000 }), NOW);
    expect(expired).toMatchObject({ type: "Supabase JWT (expired)", confidence: "info", publicByDesign: false });
    expect(expired?.extra).toMatchObject({ expired: true, expiresAt: "2020-09-13T12:26:40.000Z" });
    // One second either side of now.
    const nowSec = Math.floor(NOW / 1000);
    expect(refineFinding("Supabase Anon Key", token({ exp: nowSec - 1 }), NOW)?.confidence).toBe("info");
    expect(refineFinding("Supabase Anon Key", token({ exp: nowSec + 1 }), NOW)?.confidence).toBe("medium");
  });

  test("an unknown issuer is medium at most and never labelled Supabase", () => {
    for (const claims of [
      { iss: "https://auth.acme.test", sub: "usr_1", exp: 2000000000 },
      { sub: "usr_1" },
      { iss: "supabase-lookalike.test", role: "authenticated", exp: 2000000000 },
    ]) {
      const r = refineFinding("Supabase Anon Key", token(claims), NOW);
      expect(r?.type).not.toContain("Supabase");
      expect(r?.confidence === "medium" || r?.confidence === "info").toBe(true);
      expect(r?.publicByDesign).toBe(false);
    }
    // An issuer that merely mentions supabase, with a `ref` claim alongside,
    // cannot reach the public anon tier or the Supabase names.
    for (const iss of ["https://evil.test/supabase", "supabase.evil.test", "https://abc.supabase.co.evil.test/auth/v1"]) {
      // With role anon it is still public, but under the generic anon-role
      // name; with any other role it is a plain medium JWT.
      expect(refineFinding("Supabase Anon Key", token({ iss, ref: "abcdefghij", role: "anon", exp: 2000000000 }), NOW)?.type).toBe("JSON Web Token (anon role)");
      const r = refineFinding("Supabase Anon Key", token({ iss, ref: "abcdefghij", role: "authenticated", exp: 2000000000 }), NOW);
      expect(r?.type).toBe("JSON Web Token");
      expect(r?.publicByDesign).toBe(false);
    }
    // A project's own auth issuer does count as Supabase.
    expect(refineFinding("Supabase Anon Key", token({ iss: "https://abcdefghijklmnopqrst.supabase.co/auth/v1", role: "authenticated", exp: 2000000000 }), NOW)?.type).toBe("Supabase JWT");
    // `service_role` means full access wherever it is used, so it is high
    // from any issuer, but still not called Supabase's.
    const sr = refineFinding("Supabase Anon Key", token({ iss: "supabase-lookalike.test", role: "service_role", exp: 2000000000 }), NOW);
    expect(sr).toMatchObject({ type: "JSON Web Token (admin scope)", confidence: "high" });
  });

  test("admin scopes are high, an anon role is public, on any issuer", () => {
    expect(refineFinding("Supabase Anon Key", token({ scope: "read admin", exp: 2000000000 }), NOW)).toMatchObject({
      type: "JSON Web Token (admin scope)",
      confidence: "high",
    });
    expect(refineFinding("Supabase Anon Key", token({ roles: ["viewer", "Admin"], exp: 2000000000 }), NOW)?.confidence).toBe("high");
    expect(refineFinding("Supabase Anon Key", token({ scope: "administer-nothing", exp: 2000000000 }), NOW)?.confidence).toBe("medium");
    expect(refineFinding("Supabase Anon Key", token({ iss: "hasura", role: "anon", exp: 2000000000 }), NOW)).toMatchObject({
      type: "JSON Web Token (anon role)",
      publicByDesign: true,
    });
  });

  test("a first-party session token is info: subject, short-lived, no third-party issuer, no admin scope", () => {
    const nowSec = Math.floor(NOW / 1000);
    const session = (claims: Record<string, unknown>) => refineFinding("Supabase Anon Key", token(claims), NOW);
    // sub + exp within 30 days of iat.
    expect(session({ iss: "https://auth.acme.test", sub: "usr_1", iat: nowSec - 60, exp: nowSec + 3600 })).toMatchObject({
      type: "Session Token (JWT)",
      confidence: "info",
      publicByDesign: false,
      extra: { kind: "session", issuer: "https://auth.acme.test" },
    });
    // sid, no iat: exp within 30 days of now qualifies.
    expect(session({ sid: "s_1", exp: nowSec + 86400 * 29 })?.type).toBe("Session Token (JWT)");
    expect(session({ session_id: 42, exp: nowSec + 86400 * 29 })?.type).toBe("Session Token (JWT)");
    for (const claims of [{ user_id: 123 }, { userId: "u_1" }, { uid: "abc" }, { email: "a@b.test" }]) {
      expect(session({ ...claims, iat: nowSec - 60, exp: nowSec + 86400 * 2 })?.type).toBe("Session Token (JWT)");
    }
    // exp within 30 days of iat but far from now (a token minted for later) still counts by iat.
    expect(session({ sub: "usr_1", iat: nowSec + 86400 * 100, exp: nowSec + 86400 * 100 + 3600 })?.type).toBe("Session Token (JWT)");
  });

  test("session shapes that stay medium: no exp, exp past 30 days, third-party issuer, no subject", () => {
    const nowSec = Math.floor(NOW / 1000);
    const session = (claims: Record<string, unknown>) => refineFinding("Supabase Anon Key", token(claims), NOW);
    expect(session({ sub: "usr_1" })).toMatchObject({ type: "JSON Web Token", confidence: "medium" });
    expect(session({ sub: "usr_1", iat: nowSec, exp: nowSec + 86400 * 31 })).toMatchObject({ type: "JSON Web Token", confidence: "medium" });
    expect(session({ sub: "usr_1", exp: nowSec + 86400 * 31 })).toMatchObject({ type: "JSON Web Token", confidence: "medium" });
    for (const iss of ["https://acme.eu.auth0.com/", "https://clerk.acme.test", "https://securetoken.google.com/acme", "https://cognito-idp.eu-west-1.amazonaws.com/x", "https://acme.okta.com", "https://abc.supabase.co/auth/v1"]) {
      const r = session({ iss, sub: "usr_1", iat: nowSec, exp: nowSec + 3600 });
      expect(r?.confidence).toBe("medium");
      expect(r?.type).not.toBe("Session Token (JWT)");
    }
    // No subject and no look-behind: nothing vouches for "standalone", so
    // the token stays medium. With a look-behind that says it stands alone,
    // a short-lived token needs no subject (a per-visitor feed token).
    expect(session({ aud: "acme-web", iat: nowSec, exp: nowSec + 3600 })?.type).toBe("JSON Web Token");
    expect(refineFinding("JSON Web Token", token({ aud: "river", iat: nowSec, exp: nowSec + 86400 * 7 }), NOW, { before: () => 'token:"' })?.type).toBe("Session Token (JWT)");
    expect(refineFinding("JSON Web Token", token({ aud: "river", iat: nowSec, exp: nowSec + 86400 * 7 }), NOW, { before: () => "Bearer " })).toMatchObject({ type: "JSON Web Token", confidence: "medium" });
    expect(refineFinding("JSON Web Token", token({ aud: "river", iat: nowSec, exp: nowSec + 86400 * 31 }), NOW, { before: () => 'token:"' })?.type).toBe("JSON Web Token");
    expect(refineFinding("JSON Web Token", token({ aud: "river" }), NOW, { before: () => 'token:"' })?.type).toBe("JSON Web Token");
    // An admin scope beats the session shape.
    expect(session({ sub: "usr_1", scope: "admin", iat: nowSec, exp: nowSec + 3600 })?.confidence).toBe("high");
    // Expired beats the session shape too.
    expect(session({ sub: "usr_1", iat: nowSec - 7200, exp: nowSec - 3600 })?.type).toBe("JSON Web Token (expired)");
  });

  test("the session downgrade does not apply inside an Authorization literal or under a credential key", () => {
    const nowSec = Math.floor(NOW / 1000);
    const claims = { iss: "https://auth.acme.test", sub: "usr_1", iat: nowSec - 60, exp: nowSec + 3600 };
    const t = token(claims);
    const withBefore = (before: string) => refineFinding("JSON Web Token", t, NOW, { before: () => before });
    // Standalone: a plain variable, a data attribute, a cookie, a token key.
    for (const before of ['var session = "', 'data-session="', 'document.cookie="session=', 'token:"', '"jwt":"', "x = "]) {
      expect(withBefore(before)?.type).toBe("Session Token (JWT)");
      expect(heldAsCredential(before)).toBe(false);
    }
    // Sent as a credential, in any quoting, or held under a credential key.
    for (const before of [
      'Authorization: "Bearer ',
      'headers:{Authorization:"Bearer ',
      '\\"Authorization\\":\\"Bearer ',
      '{\\\\\\"Authorization\\\\\\":\\\\\\"Bearer ',
      "Bearer ",
      'apiKey:"',
      '"secret":"',
      "cfg.auth = '",
      'X_API_KEY = "',
    ]) {
      expect(heldAsCredential(before)).toBe(true);
      expect(withBefore(before)).toMatchObject({ type: "JSON Web Token", confidence: "medium" });
    }
    // No context at all: standalone.
    expect(refineFinding("JSON Web Token", t, NOW)?.type).toBe("Session Token (JWT)");
    // The higher tiers are unaffected by where the token sits.
    expect(refineFinding("JSON Web Token", token({ ...claims, scope: "admin" }), NOW, { before: () => "Bearer " })?.confidence).toBe("high");
    expect(refineFinding("JSON Web Token", token({ iss: "supabase", ref: "abcdefghij", role: "anon", exp: nowSec + 3600 }), NOW, { before: () => "Bearer " })?.publicByDesign).toBe(true);
  });

  test("a token issued by a *.myshopify.com domain is Shopify's public storefront JWT", () => {
    const nowSec = Math.floor(NOW / 1000);
    const r = refineFinding("JSON Web Token", token({ iss: "acme-shop.myshopify.com", aud: "storefront", exp: nowSec + 86400 * 7 }), NOW);
    expect(r).toMatchObject({ type: "Shopify Storefront JWT", confidence: "medium", publicByDesign: true });
    expect(r?.extra?.issuer).toBe("acme-shop.myshopify.com");
    // Placement does not change a public key, and a lookalike host does not qualify.
    expect(refineFinding("JSON Web Token", token({ iss: "acme-shop.myshopify.com", exp: nowSec + 3600 }), NOW, { before: () => "Bearer " })?.publicByDesign).toBe(true);
    expect(refineFinding("JSON Web Token", token({ iss: "myshopify.com.evil.test", exp: nowSec + 3600 }), NOW)?.type).toBe("JSON Web Token");
    // Expired still wins.
    expect(refineFinding("JSON Web Token", token({ iss: "acme-shop.myshopify.com", exp: nowSec - 3600 }), NOW)?.confidence).toBe("info");
  });

  test("a payload that is not JSON is a generic JWT-shaped string", () => {
    const r = refineFinding("Supabase Anon Key", `${header}.${"x".repeat(120)}`, NOW);
    expect(r).toMatchObject({ type: "JSON Web Token", confidence: "medium", publicByDesign: false });
  });

  test("hostile claims do not throw: huge exp, non-string role, deep nesting, giant payload", () => {
    // An exp past Date's range is read as absent, not as a thrown refinement
    // (which would leave the token labelled as the pattern's public tier).
    expect(refineFinding("Supabase Anon Key", token({ iss: "supabase", ref: "abcdefghij", role: "service_role", exp: 1e300 }), NOW)).toMatchObject({
      type: "Supabase Service Role JWT",
      confidence: "high",
    });
    for (const claims of [
      { exp: Number.MAX_SAFE_INTEGER },
      { exp: -1 },
      { exp: "soon" },
      { role: { nested: true } },
      { scope: [null, 1, { a: 1 }] },
      { deep: JSON.parse("[".repeat(500) + "]".repeat(500)) },
    ]) {
      expect(() => refineFinding("Supabase Anon Key", token(claims), NOW)).not.toThrow();
    }
    const giant = `${header}.${"A".repeat(20000)}`;
    expect(refineFinding("Supabase Anon Key", giant, NOW)?.type).toBe("JSON Web Token");
  });
});

describe("Algolia keys", () => {
  const hmac = (r: () => number) => runOf(r, "0123456789abcdef", 64);
  const secured = (r: () => number, params: string) => Buffer.from(hmac(r) + params).toString("base64");

  test("a secured key's restrictions decode, and unknown params are ignored", () => {
    const key = secured(rng(6), "restrictIndices=products&validUntil=1900000000&foo=bar&filters=brand%3Aacme");
    expect(decodeAlgoliaSecuredKey(key)).toEqual({
      restrictIndices: "products",
      validUntil: "1900000000",
      filters: "brand:acme",
    });
    expect(decodeAlgoliaSecuredKey(secured(rng(7), ""))).toEqual({});
    expect(decodeAlgoliaSecuredKey(Buffer.from("not a secured key at all, just text of a similar length here").toString("base64"))).toBeNull();
    expect(decodeAlgoliaSecuredKey("A".repeat(9000))).toBeNull();
  });

  test("restricted keys are public, unrestricted ones medium, non-keys dropped", () => {
    expect(refineFinding("Algolia Secured API Key", secured(rng(8), "restrictIndices=products"))).toMatchObject({
      publicByDesign: true,
      confidence: "medium",
      structural: true,
      extra: { keyType: "secured", restrictIndices: "products" },
    });
    expect(refineFinding("Algolia Secured API Key", secured(rng(9), ""))).toMatchObject({
      publicByDesign: false,
      confidence: "medium",
      extra: { restrictions: "none" },
    });
    expect(refineFinding("Algolia Secured API Key", Buffer.from("x".repeat(100)).toString("base64"))).toEqual({ drop: true });
  });

  test("a 32-hex key near the keyword stays medium, marked as admin-or-search shaped", () => {
    const found = scanContent(`window.__ALGOLIA__={algoliaKey:"${"7b".repeat(16)}"};`, "inline-script");
    expect(found.map((f) => [f.type, f.confidence, f.extra])).toEqual([
      ["Algolia API Key", "medium", { keyType: "admin-or-search-shaped", restrictions: "unknown" }],
    ]);
  });

  test("a secured key's restriction value is clipped", () => {
    const key = secured(rng(10), `filters=${"a".repeat(1000)}`);
    const filters = decodeAlgoliaSecuredKey(key)?.filters ?? "";
    expect(filters.length).toBeLessThan(210);
  });
});

describe("Stripe, Slack, Sentry structure", () => {
  test("Stripe keys carry their mode and kind", () => {
    expect(refineFinding("Stripe Live Key", j(["sk_li", "ve_"]) + "a".repeat(24))?.extra).toEqual({ kind: "secret", mode: "live" });
    expect(refineFinding("Stripe Test Key", j(["sk_te", "st_"]) + "a".repeat(24))?.extra).toEqual({ kind: "secret", mode: "test" });
    expect(refineFinding("Stripe Publishable Key", j(["pk_li", "ve_"]) + "a".repeat(24))?.extra).toEqual({ kind: "publishable", mode: "live" });
  });

  test("Slack tokens with numeric ids stay high; a placeholder shape is medium", () => {
    const real = j(["xo", "xb-"]) + "2094857361-3948572610-Kj8dPqR2mTvX5nB7wLcH1sZa";
    expect(refineFinding("Slack Token", real)).toMatchObject({ confidence: "high", extra: { kind: "bot", segments: 3 } });
    const placeholder = j(["xo", "xp-"]) + "your-token-goes-here";
    expect(refineFinding("Slack Token", placeholder)).toMatchObject({ confidence: "medium" });
    expect(refineFinding("Slack Token", placeholder)?.extra?.structure).toBe("no numeric workspace id");
  });

  test("a Sentry DSN carries its org and project", () => {
    const dsn = `https://${"a".repeat(32)}@o123456.ingest.sentry.io/7654321`;
    expect(refineFinding("Sentry DSN", dsn)?.extra).toEqual({ org: "o123456", projectId: "7654321" });
  });

  test("types with nothing to decode return null", () => {
    expect(refineFinding("OpenAI API Key", "sk-" + "a".repeat(48))).toBeNull();
    expect(refineFinding("Private Key (RSA)", "-----BEGIN RSA PRIVATE KEY-----")).toBeNull(); // pragma: allowlist secret
  });
});

describe("no network, ever", () => {
  const original = globalThis.fetch;
  let calls = 0;
  beforeEach(() => {
    calls = 0;
    globalThis.fetch = ((..._args: unknown[]) => {
      calls++;
      throw new Error("leaked-secrets must never call fetch");
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  test("every decoder runs through the scanner without touching fetch", () => {
    const r = rng(11);
    const body = runOf(r, ALNUM, 30);
    const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ iss: "supabase", ref: "abcdefghij", role: "service_role", exp: 2000000000, pad: "p".repeat(60) })}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;
    const page = [
      `var gh="${j(["gh", "p_"]) + body + githubChecksum(body)}";`,
      `var aws="${j(["AK", "IA"]) + runOf(r, B32, 16).replace(/DO/g, "DQ")}";`,
      `var sb="${jwt}";`,
      `var algoliaSearchKey="${Buffer.from(runOf(r, "0123456789abcdef", 64) + "restrictIndices=x").toString("base64")}";`,
      `var st="${j(["sk_li", "ve_"]) + runOf(r, ALNUM, 24)}";`,
      `var sl="${j(["xo", "xb-"])}${runOf(r, "0123456789", 12)}-${runOf(r, "0123456789", 13)}-${runOf(r, ALNUM, 24)}";`,
      `var dsn="https://${runOf(r, "0123456789abcdef", 32)}@o${runOf(r, "0123456789", 6)}.ingest.sentry.io/${runOf(r, "0123456789", 7)}";`,
    ].join("\n");
    const found = scanContent(page, "inline-script");
    expect(found.length).toBeGreaterThanOrEqual(7);
    expect(found.every((f) => f.extra !== undefined)).toBe(true);
    expect(calls).toBe(0);
  });
});
