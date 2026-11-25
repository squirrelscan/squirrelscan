// security/serialized-account-data: account records serialised into framework data (#2320).
// Every record below is invented; the hash is built from parts so no literal looks real.

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { CheckResult, RuleContext } from "../src/types";

import {
  KIND_LABEL,
  scanAccountData,
  serializedAccountDataRule,
} from "../src/security/serialized-account-data";

const BCRYPT = `$2b$12$${"Abcdefghijklmnopqrstu"}${"vwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0".slice(0, 32)}`;
const PAGE_URL = "https://example.com/account";

async function run(body: string): Promise<CheckResult> {
  const html = `<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`;
  const ctx = {
    page: { url: PAGE_URL, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, PAGE_URL),
    options: {},
  } as unknown as RuleContext;
  const result = await serializedAccountDataRule.run(ctx);
  return result.checks[0]!;
}

const next = (data: unknown) =>
  `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;

describe("security/serialized-account-data", () => {
  test("a bcrypt hash in __NEXT_DATA__ fails with its JSON path and no value", async () => {
    const check = await run(
      next({
        props: {
          pageProps: {
            user: { id: 7, email: "ada@example.com", passwordHash: BCRYPT },
          },
        },
      })
    );
    expect(check.status).toBe("fail");
    expect(check.items![0]!.meta).toMatchObject({
      path: "$.props.pageProps.user.passwordHash",
      kind: "password-hash",
    });
    const all = JSON.stringify(check);
    expect(all).not.toContain(BCRYPT.slice(7, 30));
    expect(all).not.toContain("ada@example.com");
    expect(check.message).toContain("explicit list of public fields");
    expect(check.message).toContain("purge");
  });

  test("kinds are told apart", () => {
    const now = Date.parse("2030-01-01T00:00:00Z");
    const { findings } = scanAccountData(
      {
        title: "Account",
        user: { email: "a@example.com", password: "Tr0ub4dor-invented" },
        account: {
          email: "b@example.com",
          apiKey: "sk_live_invented0123456789",
        },
        profile: {
          email: "c@example.com",
          otp: "493021",
          otpExpiresAt: "2020-01-01T00:00:00Z",
        },
        member: {
          email: "d@example.com",
          otp: "493021",
          otpExpiresAt: "2040-01-01T00:00:00Z",
        },
        customer: {
          email: "e@example.com",
          sessionToken: "sess_invented_0123456789",
        },
        owner: { email: "f@example.com", passwordHash: BCRYPT },
      },
      now
    );
    const kinds = Object.fromEntries(findings.map((f) => [f.path, f.kind]));
    expect(kinds).toEqual({
      "$.user.password": "plaintext-password",
      "$.account.apiKey": "api-key",
      "$.profile.otp": "otp-expired",
      "$.member.otp": "otp",
      "$.customer.sessionToken": "session-reference",
      "$.owner.passwordHash": "password-hash",
    });
  });

  test("wording: sessions are not bearer tokens, expired codes are not current access", async () => {
    expect(KIND_LABEL["session-reference"]).not.toMatch(/bearer|usable|valid/i);
    expect(KIND_LABEL["otp-expired"]).toContain("expired");
    expect(KIND_LABEL["otp-expired"]).not.toMatch(/access|valid/i);
    const check = await run(
      next({
        u: { email: "e@example.com", sessionToken: "sess_invented_0123456789" },
      })
    );
    expect(check.status).toBe("warn");
    expect(JSON.stringify(check.details)).toContain("does not show");
    const expired = await run(
      next({ u: { id: 1, otp: "493021", otpExpiresAt: 1_000_000 } })
    );
    expect(expired.status).toBe("warn");
    expect(JSON.stringify(expired)).not.toContain("493021");
  });

  test("labels, placeholders and documented examples are not flagged", () => {
    const { findings } = scanAccountData({
      form: { name: "password", type: "password", label: "Password" },
      i18n: { email: "Email", password: "Password" },
      a: { email: "a@example.com", password: "********" },
      b: { email: "b@example.com", password: "hunter2" },
      c: { email: "c@example.com", passwordHash: "[REDACTED]" },
      d: { email: "d@example.com", apiKey: "your_api_key_here_000" },
      docs: { example: { email: "x@example.com", passwordHash: BCRYPT } },
      lib: {
        hash: "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy",
      },
      pub: { email: "p@example.com", apiKey: "pk_live_invented0123456789" },
    });
    expect(findings).toEqual([]);
  });

  test("public browser keys and keys outside an account record are not flagged", () => {
    // Invented values in the shape of public client keys.
    const google = `AIza${"Sy0invented0invented0invented0inv".slice(0, 35)}`;
    const { findings } = scanAccountData({
      firebase: {
        id: 1,
        apiKey: google,
        authDomain: "example.firebaseapp.com",
        projectId: "example",
        appId: "1:000000000000:web:0000000000000000",
      },
      algolia: {
        id: 2,
        appId: "EXAMPLEAPP",
        apiKey: "0123456789abcdef0123456789abcdef",
      },
      maps: { id: 1, apiKey: google },
      config: { apiKey: "sk_live_invented0123456789" },
    });
    expect(findings).toEqual([]);
  });

  test("a plaintext password needs a record around it", () => {
    expect(
      scanAccountData({ password: "Tr0ub4dor-invented" }).findings
    ).toEqual([]);
  });

  test("map keys that could be personal are folded", () => {
    const { findings } = scanAccountData({
      title: "Team",
      users: {
        alice: { email: "a@example.com", passwordHash: BCRYPT },
        bob: { email: "b@example.com", passwordHash: BCRYPT },
      },
      "carol@example.com": { passwordHash: BCRYPT },
    });
    const paths = findings.map((f) => f.path).sort();
    expect(paths).toEqual(
      ["$.users[*].passwordHash", "$[*].passwordHash"].sort()
    );
    expect(JSON.stringify(findings)).not.toMatch(/alice|bob|carol/);
  });

  test("a single record keyed by a username is folded", () => {
    const { findings } = scanAccountData({
      users: { alice: { email: "a@example.com", passwordHash: BCRYPT } },
      admin: { username: "admin", passwordHash: BCRYPT },
      user: { id: 7, passwordHash: BCRYPT },
    });
    expect(findings.map((f) => f.path).sort()).toEqual(
      [
        "$.users[*].passwordHash",
        "$[*].passwordHash",
        "$.user.passwordHash",
      ].sort()
    );
    expect(JSON.stringify(findings)).not.toMatch(/alice|admin/);
  });

  test("only allowlisted keys are printed in a path", () => {
    const { findings } = scanAccountData({
      team: {
        jdoe: { id: 7, passwordHash: BCRYPT },
      },
      user: { id: 8, jdoe_pw: BCRYPT },
    });
    expect(findings.map((f) => f.path).sort()).toEqual(
      ["$.user[*]", "$[*][*].passwordHash"].sort()
    );
    expect(JSON.stringify(findings)).not.toMatch(/jdoe|team/);
  });

  test("a wide record is scanned in linear time", () => {
    // Many password-named keys in a record with no identity field: a per-field
    // rescan of the record's keys made this quadratic (seconds at 200 KB).
    const wide = (n: number) => {
      const rec: Record<string, string> = {};
      for (let i = 0; i < n; i++)
        rec[`${"_".repeat(i % 64)}password${"-".repeat(Math.floor(i / 64))}`] =
          "Tr0ub4dor-invented";
      return rec;
    };
    const small = wide(2000);
    const big = wide(8000);
    expect(JSON.stringify(big).length).toBeGreaterThan(200 * 1024);
    const time = (rec: Record<string, string>) => {
      const t = performance.now();
      expect(scanAccountData(rec).findings).toEqual([]);
      return performance.now() - t;
    };
    time(small);
    const tSmall = time(small);
    const tBig = time(big);
    // 4x the keys: linear is about 4x, quadratic about 16x.
    expect(tBig).toBeLessThan(Math.max(tSmall, 5) * 10);
    expect(tBig).toBeLessThan(1000);
  });

  test("window globals and astro props are read", async () => {
    const user = { user: { id: 1, passwordHash: BCRYPT } };
    const g = await run(
      `<script>window.__NUXT__ = ${JSON.stringify(user)};</script>`
    );
    expect(g.status).toBe("fail");
    const astro = await run(
      `<astro-island props='${JSON.stringify(user)}'></astro-island>`
    );
    expect(astro.status).toBe("fail");
  });

  test("__NUXT_DATA__ (devalue) is not read: its numbers are slot indices", async () => {
    // Nuxt 3 devalue output: `1050` and `4` are indices into the array, not values.
    const devalue = [
      { data: 1 },
      { user: 2 },
      { id: 4, email: 5, verificationCode: 1050 },
      "unused",
      7,
      "a@example.com",
    ];
    // Read as plain JSON the slot index would look like a code.
    expect(scanAccountData(devalue).findings.length).toBeGreaterThan(0);
    const check = await run(
      `<script type="application/json" id="__NUXT_DATA__">${JSON.stringify(devalue)}</script>`
    );
    expect(check.status).toBe("pass");
    expect(check.items ?? []).toEqual([]);
  });

  test("a clean payload passes and no payload passes", async () => {
    expect((await run(next({ props: { title: "Hi" } }))).status).toBe("pass");
    expect((await run("<p>hello</p>")).status).toBe("pass");
  });

  test("a deep payload is cut, not crashed on", () => {
    let v: unknown = { email: "a@example.com", passwordHash: BCRYPT };
    for (let i = 0; i < 200; i++) v = { n: v };
    expect(scanAccountData(v).truncated).toBe(true);
  });

  test("__proto__ keys do not pollute", async () => {
    const json = `{"__proto__":{"polluted":1},"user":{"id":1,"passwordHash":"${BCRYPT}"}}`;
    const check = await run(
      `<script id="__NEXT_DATA__" type="application/json">${json}</script>`
    );
    expect(check.status).toBe("fail");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
