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
        a: { email: "a@example.com", password: "Tr0ub4dor-invented" },
        b: { email: "b@example.com", apiKey: "sk_live_invented0123456789" },
        c: {
          email: "c@example.com",
          otp: "493021",
          otpExpiresAt: "2020-01-01T00:00:00Z",
        },
        d: {
          email: "d@example.com",
          otp: "493021",
          otpExpiresAt: "2040-01-01T00:00:00Z",
        },
        e: { email: "e@example.com", sessionToken: "sess_invented_0123456789" },
        f: { email: "f@example.com", passwordHash: BCRYPT },
      },
      now
    );
    const kinds = Object.fromEntries(findings.map((f) => [f.path, f.kind]));
    expect(kinds).toEqual({
      "$.a.password": "plaintext-password",
      "$.b.apiKey": "api-key",
      "$.c.otp": "otp-expired",
      "$.d.otp": "otp",
      "$.e.sessionToken": "session-reference",
      "$.f.passwordHash": "password-hash",
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
