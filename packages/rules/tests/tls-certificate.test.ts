// security/tls-certificate (#712). The rule opens no socket: it asks the
// injected `TlsProbeFn` (the CLI's, tested against real handshakes in
// apps/cli/tests/audit/tls-probe.test.ts). Here the probe answers certificate
// facts directly, as the runtime reports them for each fixture.

import { describe, expect, test } from "bun:test";

import type { TlsProbe, TlsTarget } from "@squirrelscan/utils/tls-certificate";

import {
  checkTlsCertificate,
  optionsSchema,
  tlsCertificateRule,
  expiryWindowFor,
  wwwVariant,
  type TlsCertificateOptions,
} from "../src/security/tls-certificate";
import type { CheckResult, RuleContext } from "../src/types";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NOW = new Date();
const DEFAULTS: TlsCertificateOptions = optionsSchema.parse({});

type Served = Extract<TlsProbe, { kind: "certificate" }>;

/** A served certificate for `names`, signed by the test intermediate and trusted. */
function cert(
  names: string[],
  overrides: { validTo?: Date; validFrom?: Date; rsaBits?: number; trusted?: boolean; trustError?: string } = {},
): Served {
  const { validTo, validFrom, rsaBits, trusted = true, trustError } = overrides;
  // A certificate with only an end date is a 90-day one (Let's Encrypt's lifetime),
  // so the lifetime-relative expiry window is what a real certificate gets (#1279).
  const defaultFrom = validTo ? new Date(validTo.getTime() - 90 * DAY_MS) : new Date(NOW.getTime() - DAY_MS);
  return {
    kind: "certificate",
    certificate: {
      names,
      issuer: "squirrel test intermediate",
      validFrom: validFrom ?? defaultFrom,
      validTo: validTo ?? new Date(NOW.getTime() + 365 * DAY_MS),
      ...(rsaBits !== undefined ? { rsaBits } : { rsaBits: 2048 }),
    },
    trusted,
    ...(trustError !== undefined ? { trustError } : {}),
  };
}

/** `days` days and one hour from now, so a whole-day count lands on `days`. */
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY_MS + HOUR_MS);

const LOCAL = ["localhost", "127.0.0.1"];
const fixtures = {
  valid: cert(LOCAL),
  expiresIn45Days: cert(LOCAL, { validTo: inDays(45) }),
  expiresIn28Days: cert(LOCAL, { validTo: inDays(28) }),
  expiresIn20Days: cert(LOCAL, { validTo: inDays(20) }),
  expiresIn10Days: cert(LOCAL, { validTo: inDays(10) }),
  expiresIn5Days: cert(LOCAL, { validTo: inDays(5) }),
  expired: cert(LOCAL, {
    validFrom: new Date(NOW.getTime() - 60 * DAY_MS),
    validTo: new Date(NOW.getTime() - 3 * DAY_MS),
    trusted: false,
    trustError: "CERT_HAS_EXPIRED",
  }),
  wrongName: cert(["other.test"], { trusted: false, trustError: "ERR_TLS_CERT_ALTNAME_INVALID" }),
  example: cert(["example.test", "www.example.test"]),
  selfSigned: cert(LOCAL, { trusted: false, trustError: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
  leafOnly: cert(LOCAL, { trusted: false, trustError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
  weakKey: cert(LOCAL, { rsaBits: 1024 }),
  ecKey: { ...cert(LOCAL), certificate: { ...cert(LOCAL).certificate, rsaBits: undefined } } as Served,
};

/**
 * Audit `hosts` (the first key is the audited host). A host mapped to a
 * certificate serves it; a host mapped to `null` does not resolve. Every
 * handshake the rule asks for is recorded in `calls`.
 */
async function audit(
  hosts: Record<string, TlsProbe | null>,
  options: Partial<TlsCertificateOptions> = {},
  now: Date = NOW,
): Promise<{ checks: CheckResult[]; calls: string[] }> {
  const calls: string[] = [];
  const [audited] = Object.keys(hosts);
  const result = await checkTlsCertificate(`https://${audited}/`, optionsSchema.parse({ ...options }), {
    now,
    probe: async ({ hostname }: TlsTarget): Promise<TlsProbe> => {
      calls.push(hostname);
      return (
        hosts[hostname] ?? { kind: "unreachable", code: "ENOTFOUND", message: `${hostname} does not resolve` }
      );
    },
  });
  return { checks: result.checks, calls };
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((item) => item.name === name);
}

describe("expiry thresholds", () => {
  test("a valid certificate passes and shows the issuer and expiry date", async () => {
    const { checks, calls } = await audit({ localhost: fixtures.valid });
    const expiry = check(checks, "tls-certificate-expiry");
    expect(expiry?.status).toBe("pass");
    expect(expiry?.message).toContain("squirrel test intermediate");
    expect(expiry?.message).toMatch(/valid until \d{4}-\d{2}-\d{2}, \d+ days remaining/);
    expect(checks.filter((item) => item.status === "fail" || item.status === "warn")).toEqual([]);
    expect(calls).toEqual(["localhost"]);
  });

  test("a 90-day certificate with 28 days left, inside the renewal window, does not warn (#1279)", async () => {
    const { checks } = await audit({ localhost: fixtures.expiresIn28Days });
    expect(check(checks, "tls-certificate-expiry")?.status).toBe("pass");
    expect(check(await audit({ localhost: fixtures.expiresIn20Days }).then((r) => r.checks), "tls-certificate-expiry")?.status).toBe("pass");
  });

  test("a 90-day certificate with 10 days left warns with the date and days left (#1279)", async () => {
    const { checks } = await audit({ localhost: fixtures.expiresIn10Days });
    const expiry = check(checks, "tls-certificate-expiry");
    expect(expiry?.status).toBe("warn");
    expect(expiry?.message).toMatch(/expires in 10 days \(\d{4}-\d{2}-\d{2}\), within the 16-day warning threshold/);
    expect(expiry?.details).toMatchObject({ warnDays: 16, warnDaysSource: "lifetime" });
  });

  test("a certificate expiring in 5 days is an error", async () => {
    const { checks } = await audit({ localhost: fixtures.expiresIn5Days });
    const expiry = check(checks, "tls-certificate-expiry");
    expect(expiry?.status).toBe("fail");
    expect(expiry?.message).toMatch(/expires in 5 days/);
  });

  test("an expired certificate is an error that names the date", async () => {
    const { checks } = await audit({ localhost: fixtures.expired });
    const expiry = check(checks, "tls-certificate-expiry");
    expect(expiry?.status).toBe("fail");
    expect(expiry?.message).toMatch(/^Certificate expired on \d{4}-\d{2}-\d{2}/);
  });

  test("warn_days can be raised so a 45-day certificate warns", async () => {
    const withDefault = await audit({ localhost: fixtures.expiresIn45Days });
    expect(check(withDefault.checks, "tls-certificate-expiry")?.status).toBe("pass");

    const withSixty = await audit({ localhost: fixtures.expiresIn45Days }, { warn_days: 60 });
    expect(check(withSixty.checks, "tls-certificate-expiry")?.status).toBe("warn");
  });

  test("warn_days stays an explicit override whatever the lifetime", async () => {
    const thirty = await audit({ localhost: fixtures.expiresIn28Days }, { warn_days: 30 });
    expect(check(thirty.checks, "tls-certificate-expiry")).toMatchObject({
      status: "warn",
      details: { warnDays: 30, warnDaysSource: "option", errorDays: 7, errorDaysSource: "lifetime" },
    });
    const five = await audit({ localhost: fixtures.expiresIn10Days }, { warn_days: 5, error_days: 3 });
    expect(check(five.checks, "tls-certificate-expiry")?.status).toBe("pass");
  });

  test("the windows follow the certificate's lifetime", () => {
    const at = (lifetimeDays: number, options: object = {}) => {
      const window = expiryWindowFor(
        { names: [], issuer: "x", validFrom: new Date(0), validTo: new Date(lifetimeDays * DAY_MS) },
        optionsSchema.parse(options),
      );
      return [window.warnDays, window.errorDays];
    };
    // [warn days, error days]
    expect(at(90)).toEqual([16, 7]);
    expect(at(200)).toEqual([52, 7]);
    expect(at(365)).toEqual([107, 7]);
    expect(at(47)).toEqual([8, 4]);
    expect(at(30)).toEqual([5, 3]);
    expect(at(10)).toEqual([1, 1]);
    expect(at(6)).toEqual([1, 1]);
    // Let's Encrypt's 90 days less a second still reads as 90.
    expect(
      expiryWindowFor(
        { names: [], issuer: "x", validFrom: new Date(0), validTo: new Date(90 * DAY_MS - 1000) },
        optionsSchema.parse({}),
      ).warnDays,
    ).toBe(16);
    // Explicit options win; error never exceeds an explicit warn.
    expect(at(90, { warn_days: 30 })).toEqual([30, 7]);
    expect(at(90, { error_days: 3 })).toEqual([16, 3]);
    expect(at(6, { error_days: 3 })).toEqual([3, 3]);
    expect(at(90, { warn_days: 5 })).toEqual([5, 5]);
    expect(at(0)).toEqual([30, 7]);
  });

  test.each([
    // lifetime days, days left, expected status
    [90, 28, "pass"],
    [90, 16, "warn"],
    [90, 10, "warn"],
    [90, 5, "fail"],
    [365, 100, "warn"],
    [365, 108, "pass"],
    [47, 15, "pass"],
    [47, 8, "warn"],
    [47, 4, "fail"],
    [30, 6, "pass"],
    [30, 4, "warn"],
    [30, 3, "fail"],
    [10, 5, "pass"],
    [10, 1, "fail"],
    [6, 5, "pass"],
    [6, 3, "pass"],
    [6, 1, "fail"],
  ] as const)("a %d-day certificate with %d days left is %s", async (lifetime, left, status) => {
    const certificate = cert(LOCAL, {
      validFrom: new Date(NOW.getTime() + left * DAY_MS + HOUR_MS - lifetime * DAY_MS),
      validTo: inDays(left),
    });
    const { checks } = await audit({ localhost: certificate });
    expect(check(checks, "tls-certificate-expiry")?.status).toBe(status);
  });

  test("error_days moves the error threshold", async () => {
    const { checks } = await audit({ localhost: fixtures.expiresIn20Days }, { error_days: 25 });
    expect(check(checks, "tls-certificate-expiry")?.status).toBe("fail");
  });

  test("the options default to lifetime-relative windows", () => {
    expect(DEFAULTS).toEqual({
      key_types: ["rsa", "ecdsa", "ed25519"],
      rsa_min_bits: 2048,
      ecdsa_min_bits: 256,
      dsa_min_bits: 2048,
      reject_weak_signature: true,
      min_tls_version: "TLSv1.2",
      check_counterpart: true,
    });
    expect(DEFAULTS.warn_days).toBeUndefined();
    expect(DEFAULTS.error_days).toBeUndefined();
  });

  test("an error threshold above the warning threshold is refused, naming error_days", () => {
    const refused = optionsSchema.safeParse({ warn_days: 30, error_days: 40 });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["error_days"]);
    // With no warn_days the window is derived and never under error_days, so nothing to refuse.
    expect(optionsSchema.safeParse({ error_days: 40 }).success).toBe(true);
    expect(optionsSchema.safeParse({ warn_days: 30, error_days: 30 }).success).toBe(true);
    // The refinement keeps the object shape the option checks and docs read.
    expect(Object.keys(optionsSchema.shape)).toEqual([
      "warn_days",
      "error_days",
      "key_types",
      "rsa_min_bits",
      "ecdsa_min_bits",
      "dsa_min_bits",
      "reject_weak_signature",
      "min_tls_version",
      "check_counterpart",
    ]);
  });

  test("a certificate that expired hours ago says less than a day, not 1 day", async () => {
    const { checks } = await audit({
      localhost: cert(LOCAL, {
        validFrom: new Date(NOW.getTime() - 30 * DAY_MS),
        validTo: new Date(NOW.getTime() - 2 * HOUR_MS),
        trusted: false,
        trustError: "CERT_HAS_EXPIRED",
      }),
    });
    expect(check(checks, "tls-certificate-expiry")?.message).toMatch(/\(less than a day ago\)$/);
  });

  test("a certificate that expired three and a half days ago says 3 days", async () => {
    const { checks } = await audit({
      localhost: cert(LOCAL, {
        validFrom: new Date(NOW.getTime() - 30 * DAY_MS),
        validTo: new Date(NOW.getTime() - 3.5 * DAY_MS),
        trusted: false,
        trustError: "CERT_HAS_EXPIRED",
      }),
    });
    expect(check(checks, "tls-certificate-expiry")?.message).toMatch(/\(3 days ago\)$/);
  });
});

describe("hostname, chain and key", () => {
  test("a certificate that does not cover the audited host names both", async () => {
    const { checks } = await audit({ localhost: fixtures.wrongName });
    const hostname = check(checks, "tls-certificate-hostname");
    expect(hostname?.status).toBe("fail");
    expect(hostname?.message).toContain("does not cover localhost");
    expect(hostname?.message).toContain("other.test");
  });

  test("a certificate with many names lists ten and counts the rest", async () => {
    const names = Array.from({ length: 25 }, (_, i) => `host${i}.other.test`);
    const { checks } = await audit({
      localhost: cert(names, { trusted: false, trustError: "ERR_TLS_CERT_ALTNAME_INVALID" }),
    });
    const hostname = check(checks, "tls-certificate-hostname");
    expect(hostname?.message).toEndWith("host9.other.test and 15 more");
    expect(hostname?.message).not.toContain("host10.other.test");
  });

  test("a self-signed certificate is an error that says self-signed", async () => {
    const { checks } = await audit({ localhost: fixtures.selfSigned });
    const chain = check(checks, "tls-certificate-chain");
    expect(chain?.status).toBe("fail");
    expect(chain?.message).toContain("self-signed");
  });

  test("a server that omits its intermediate gets an incomplete-chain error", async () => {
    const { checks } = await audit({ localhost: fixtures.leafOnly });
    const chain = check(checks, "tls-certificate-chain");
    expect(chain?.status).toBe("fail");
    expect(chain?.message).toContain("incomplete chain");
    expect(chain?.message).toContain("intermediate");
  });

  test("an RSA key under 2048 bits warns", async () => {
    const { checks } = await audit({ localhost: fixtures.weakKey });
    const key = check(checks, "tls-certificate-key");
    expect(key?.status).toBe("warn");
    expect(key?.message).toContain("1024 bits");
    expect(key?.value).toBe("RSA 1024 bits");
  });

  test("an ECDSA key has no RSA size to judge and does not warn", async () => {
    const { checks } = await audit({ localhost: fixtures.ecKey });
    expect(check(checks, "tls-certificate-key")).toBeUndefined();
  });
});

describe("www and apex variant", () => {
  test("both handshakes start before either answers, so the worst case is one deadline", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const pending = checkTlsCertificate("https://example.com/", DEFAULTS, {
      now: NOW,
      probe: async ({ hostname }) => {
        started.push(hostname);
        await gate;
        return cert(["example.com", "www.example.com"]);
      },
    });
    await Promise.resolve();
    expect(started).toEqual(["example.com", "www.example.com"]);
    release();
    expect(check((await pending).checks, "tls-certificate-www")).toBeUndefined();
  });

  test("a variant that answers with a certificate not valid for it warns, naming it", async () => {
    const { checks, calls } = await audit({
      "example.test": fixtures.example,
      "www.example.test": fixtures.wrongName,
    });
    expect(check(checks, "tls-certificate-expiry")?.status).toBe("pass");
    const www = check(checks, "tls-certificate-www");
    expect(www?.status).toBe("warn");
    expect(www?.message).toContain("www.example.test");
    expect(calls).toEqual(["example.test", "www.example.test"]);
  });

  test("a variant whose certificate covers it adds nothing", async () => {
    const { checks } = await audit({
      "example.test": fixtures.example,
      "www.example.test": fixtures.example,
    });
    expect(check(checks, "tls-certificate-www")).toBeUndefined();
  });

  test("a variant that does not resolve reports nothing", async () => {
    const { checks, calls } = await audit({
      "example.test": fixtures.example,
      "www.example.test": null,
    });
    expect(check(checks, "tls-certificate-www")).toBeUndefined();
    expect(calls).toEqual(["example.test", "www.example.test"]);
  });

  test("a bare or local host has no variant to check", async () => {
    const { calls } = await audit({ localhost: fixtures.valid });
    expect(calls).toEqual(["localhost"]);
  });
});

describe("not checked", () => {
  test("a probe that cannot run here reports not checked with its reason, never pass", async () => {
    const result = await checkTlsCertificate("https://example.test/", DEFAULTS, {
      now: new Date(),
      probe: async () => ({ kind: "unavailable", reason: "an HTTP proxy is set in the environment" }),
    });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ status: "skipped", value: "not-checked", skipReason: "tls-certificate-not-checked" });
    expect(result.checks[0]!.message).toBe(
      "TLS certificate not checked: an HTTP proxy is set in the environment",
    );
  });

  test("a handshake that cannot complete reports not checked, never fail", async () => {
    const result = await checkTlsCertificate("https://example.test/", DEFAULTS, {
      now: new Date(),
      probe: async () => ({ kind: "unreachable", code: "ECONNREFUSED", message: "refused" }),
    });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ status: "skipped", value: "not-checked", skipReason: "tls-certificate-not-checked" });
    expect(result.checks[0]!.message).toContain("ECONNREFUSED");
  });

  test("a plain http site is left to security/https", async () => {
    let probed = false;
    const result = await checkTlsCertificate("http://example.test/", DEFAULTS, {
      now: new Date(),
      probe: async () => {
        probed = true;
        return { kind: "unreachable", code: "x", message: "" };
      },
    });
    expect(probed).toBe(false);
    expect(result.checks[0]).toMatchObject({ status: "skipped", skipReason: "not-https" });
  });
});

describe("the injected probe", () => {
  function ctxFor(baseUrl: string, extra: Partial<RuleContext> = {}): RuleContext {
    return {
      site: { baseUrl, pages: [] },
      options: {},
      page: { url: baseUrl },
      ...extra,
    } as unknown as RuleContext;
  }

  test("run() with no ctx.tlsProbe reports not checked with the reason, and never passes", async () => {
    const result = await tlsCertificateRule.run(ctxFor("https://example.com/"));
    const checks = result.checks as CheckResult[];
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: "skipped", value: "not-checked", skipReason: "tls-certificate-not-checked" });
    expect(checks[0]!.message).toBe(
      "TLS certificate not checked: this environment does not open TLS connections for the audit",
    );
  });

  test("run() asks ctx.tlsProbe for the audited host and port", async () => {
    const targets: TlsTarget[] = [];
    const result = await tlsCertificateRule.run(
      ctxFor("https://example.com:8443/", {
        tlsProbe: async (target) => {
          targets.push(target);
          return target.hostname === "example.com"
            ? cert(["example.com"], { trusted: false, trustError: "DEPTH_ZERO_SELF_SIGNED_CERT" })
            : { kind: "unreachable", code: "ENOTFOUND", message: "no" };
        },
      }),
    );
    const checks = result.checks as CheckResult[];
    expect(check(checks, "tls-certificate-chain")?.message).toContain("self-signed");
    expect(targets).toEqual([
      { hostname: "example.com", port: 8443 },
      { hostname: "www.example.com", port: 8443 },
    ]);
  });

  test("an audited host the egress guard refused is not checked, naming why", async () => {
    const result = await checkTlsCertificate("https://example.com/", DEFAULTS, {
      now: NOW,
      probe: async () => ({
        kind: "unreachable",
        code: "EGRESS_REFUSED",
        message: "example.com was not contacted: refused: host resolves to a non-public address",
      }),
    });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ status: "skipped", value: "not-checked", skipReason: "tls-certificate-not-checked" });
    expect(result.checks[0]!.message).toBe(
      "TLS certificate not checked: example.com was not contacted: refused: host resolves to a non-public address",
    );
  });

  test("a variant the egress guard refused adds nothing", async () => {
    const { checks, calls } = await audit({
      "example.test": fixtures.example,
      "www.example.test": { kind: "unreachable", code: "EGRESS_REFUSED", message: "refused" },
    });
    expect(check(checks, "tls-certificate-www")).toBeUndefined();
    expect(calls).toEqual(["example.test", "www.example.test"]);
  });
});

describe("wwwVariant: the registrable domain only", () => {
  test("toggles www on the registrable domain", () => {
    expect(wwwVariant("example.com")).toBe("www.example.com");
    expect(wwwVariant("www.example.com")).toBe("example.com");
    expect(wwwVariant("WWW.Example.COM.")).toBe("example.com");
    expect(wwwVariant("example.co.uk")).toBe("www.example.co.uk");
    expect(wwwVariant("www.example.co.uk")).toBe("example.co.uk");
  });

  test("derives nothing for another subdomain", () => {
    expect(wwwVariant("blog.example.com")).toBeUndefined();
    expect(wwwVariant("www.blog.example.com")).toBeUndefined();
    expect(wwwVariant("a.b.example.co.uk")).toBeUndefined();
  });

  test("a private suffix is a registry: another tenant's name is never derived", () => {
    expect(wwwVariant("acme.pages.dev")).toBe("www.acme.pages.dev");
    expect(wwwVariant("www.acme.pages.dev")).toBe("acme.pages.dev");
    // `www.pages.dev` would be the platform's own name, not this site's.
    expect(wwwVariant("pages.dev")).toBeUndefined();
    expect(wwwVariant("co.uk")).toBeUndefined();
  });

  test("an IP literal or a name with no registrable domain has none", () => {
    expect(wwwVariant("127.0.0.1")).toBeUndefined();
    expect(wwwVariant("::1")).toBeUndefined();
    expect(wwwVariant("2606:4700::1111")).toBeUndefined();
    expect(wwwVariant("localhost")).toBeUndefined();
    expect(wwwVariant("intranet")).toBeUndefined();
  });
});

describe("rule declaration", () => {
  test("skips private targets like the other transport rules and declares its options", () => {
    expect(tlsCertificateRule.meta.id).toBe("security/tls-certificate");
    expect(tlsCertificateRule.meta.scope).toBe("site");
    expect(tlsCertificateRule.meta.skipOnPrivateTarget).toBe(true);
    expect(tlsCertificateRule.meta.optionsSchema).toBeDefined();
  });
});

describe("key and certificate limits (#1259)", () => {
  const withKey = (extra: Partial<Served["certificate"]>, protocol?: string): Served => {
    const base = cert(LOCAL);
    return { ...base, certificate: { ...base.certificate, rsaBits: undefined, ...extra }, ...(protocol ? { protocol } : {}) } as Served;
  };
  const RSA = (bits: number) => withKey({ keyType: "rsa", keyBits: bits, rsaBits: bits });
  const EC = (curve: string, bits: number) => withKey({ keyType: "ecdsa", keyBits: bits, curve });
  const keyOf = async (served: Served, options: Partial<TlsCertificateOptions> = {}) =>
    check((await audit({ localhost: served }, options)).checks, "tls-certificate-key");

  test("the key check names the type and size", async () => {
    expect((await keyOf(RSA(1024)))?.value).toBe("RSA 1024 bits");
    expect((await keyOf(EC("P-224", 224)))?.value).toBe("ECDSA P-224");
    expect((await keyOf(withKey({ keyType: "dsa", keyBits: 1024 })))?.value).toBe("DSA 1024 bits");
  });

  test("RSA, ECDSA and Ed25519 at or above their minimums do not warn", async () => {
    expect(await keyOf(RSA(2048))).toBeUndefined();
    expect(await keyOf(EC("P-256", 256))).toBeUndefined();
    expect(await keyOf(withKey({ keyType: "ed25519" }))).toBeUndefined();
  });

  test("a DSA key warns by default and passes when dsa is allowed at its minimum", async () => {
    const dsa = withKey({ keyType: "dsa", keyBits: 2048 });
    expect((await keyOf(dsa))?.message).toContain("not in the allowed key types (rsa, ecdsa, ed25519)");
    expect(await keyOf(dsa, { key_types: ["rsa", "ecdsa", "ed25519", "dsa"] })).toBeUndefined();
    expect((await keyOf(withKey({ keyType: "dsa", keyBits: 1024 }), { key_types: ["dsa"] }))?.message).toContain("below the 2048-bit minimum for DSA");
  });

  test("the minimums are options", async () => {
    expect((await keyOf(RSA(2048), { rsa_min_bits: 3072 }))?.message).toContain("below the 3072-bit minimum for RSA");
    expect(await keyOf(RSA(1024), { rsa_min_bits: 1024 })).toBeUndefined();
    expect((await keyOf(EC("P-256", 256), { ecdsa_min_bits: 384 }))?.message).toContain("below the 384-bit minimum for ECDSA");
  });

  test("a key type outside key_types warns even when its size is fine", async () => {
    expect((await keyOf(RSA(4096), { key_types: ["ecdsa", "ed25519"] }))?.message).toContain("not in the allowed key types (ecdsa, ed25519)");
  });

  const sig = async (algorithm: string | undefined, options: Partial<TlsCertificateOptions> = {}) =>
    check((await audit({ localhost: withKey({ keyType: "rsa", keyBits: 2048, rsaBits: 2048, signatureAlgorithm: algorithm }) }, options)).checks, "tls-certificate-signature");

  test("a SHA-1 or MD5 signature warns by default, SHA-256 and unread ones do not", async () => {
    expect((await sig("sha1WithRSAEncryption"))?.status).toBe("warn");
    expect((await sig("md5WithRSAEncryption"))?.status).toBe("warn");
    expect((await sig("ecdsa-with-SHA1"))?.status).toBe("warn");
    for (const ok of ["sha256WithRSAEncryption", "sha384WithRSAEncryption", "ecdsa-with-SHA256", "ED25519", undefined]) {
      expect(await sig(ok), String(ok)).toBeUndefined();
    }
  });

  test("reject_weak_signature = false turns the signature check off", async () => {
    expect(await sig("sha1WithRSAEncryption", { reject_weak_signature: false })).toBeUndefined();
  });

  const proto = async (protocol: string | undefined, options: Partial<TlsCertificateOptions> = {}) =>
    check((await audit({ localhost: withKey({ keyType: "rsa", keyBits: 2048, rsaBits: 2048 }, protocol) }, options)).checks, "tls-certificate-protocol");

  test("a negotiated protocol below min_tls_version warns; the default minimum is TLS 1.2", async () => {
    expect((await proto("TLSv1.1"))?.message).toContain("TLSv1.1, below the TLSv1.2 minimum");
    expect((await proto("TLSv1"))?.status).toBe("warn");
    expect(await proto("TLSv1.2")).toBeUndefined();
    expect(await proto("TLSv1.3")).toBeUndefined();
    expect(await proto(undefined)).toBeUndefined();
    expect(await proto("TLSv1.2", { min_tls_version: "TLSv1.3" })).toBeDefined();
    expect(await proto("TLSv1.1", { min_tls_version: "TLSv1.1" })).toBeUndefined();
  });

  test("check_counterpart = false makes no handshake with the www or apex name", async () => {
    const hosts = { "example.test": fixtures.example, "www.example.test": fixtures.example };
    expect((await audit(hosts)).calls.sort()).toEqual(["example.test", "www.example.test"]);
    expect((await audit(hosts, { check_counterpart: false })).calls).toEqual(["example.test"]);
  });

  test("invalid values are refused with the option named", () => {
    for (const [bad, path] of [
      [{ key_types: [] }, "key_types"],
      [{ key_types: ["rsa", "ecc"] }, "key_types"],
      [{ rsa_min_bits: 100 }, "rsa_min_bits"],
      [{ ecdsa_min_bits: "256" }, "ecdsa_min_bits"],
      [{ min_tls_version: "TLSv2" }, "min_tls_version"],
      [{ reject_weak_signature: "yes" }, "reject_weak_signature"],
      [{ check_counterpart: 1 }, "check_counterpart"],
    ] as const) {
      const refused = optionsSchema.safeParse(bad);
      expect(refused.success, JSON.stringify(bad)).toBe(false);
      expect(refused.error?.issues[0]?.path[0]).toBe(path);
    }
  });
});
