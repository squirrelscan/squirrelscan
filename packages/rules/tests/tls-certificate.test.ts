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
  warnDaysFor,
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
      details: { warnDays: 30, warnDaysSource: "option" },
    });
    const five = await audit({ localhost: fixtures.expiresIn10Days }, { warn_days: 5, error_days: 3 });
    expect(check(five.checks, "tls-certificate-expiry")?.status).toBe("pass");
  });

  test("the warning window follows the certificate's lifetime", () => {
    const at = (lifetimeDays: number, options: object = {}) =>
      warnDaysFor(
        { names: [], issuer: "x", validFrom: new Date(0), validTo: new Date(lifetimeDays * DAY_MS) },
        optionsSchema.parse(options),
      );
    expect(at(90)).toBe(16);
    expect(at(200)).toBe(52);
    expect(at(365)).toBe(107);
    // Shrinking lifetimes shrink the window; it never drops under the error threshold.
    expect(at(47)).toBe(7);
    expect(at(47, { error_days: 2 })).toBe(2);
    expect(at(0)).toBe(30);
  });

  test("error_days moves the error threshold", async () => {
    const { checks } = await audit({ localhost: fixtures.expiresIn20Days }, { error_days: 25 });
    expect(check(checks, "tls-certificate-expiry")?.status).toBe("fail");
  });

  test("the options default to a lifetime-relative warning and a 7-day error", () => {
    expect(DEFAULTS).toEqual({ error_days: 7 });
    expect(DEFAULTS.warn_days).toBeUndefined();
  });

  test("an error threshold above the warning threshold is refused, naming error_days", () => {
    const refused = optionsSchema.safeParse({ warn_days: 30, error_days: 40 });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["error_days"]);
    // With no warn_days the window is derived and never under error_days, so nothing to refuse.
    expect(optionsSchema.safeParse({ error_days: 40 }).success).toBe(true);
    expect(optionsSchema.safeParse({ warn_days: 30, error_days: 30 }).success).toBe(true);
    // The refinement keeps the object shape the option checks and docs read.
    expect(Object.keys(optionsSchema.shape)).toEqual(["warn_days", "error_days"]);
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
