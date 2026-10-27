// security/tls-certificate (#712). Every certificate is generated at test time
// and served from 127.0.0.1; no live host is contacted.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  probeTlsCertificate,
  type TlsProbe,
  type TlsTarget,
} from "@squirrelscan/utils/tls-certificate";
import {
  createTlsFixtures,
  serveCertificate,
  type LocalTlsServer,
  type ServedCertificate,
  type TlsFixtures,
} from "../../utils/tests/helpers/tls-fixtures";

import {
  checkTlsCertificate,
  optionsSchema,
  tlsCertificateRule,
  type TlsCertificateOptions,
} from "../src/security/tls-certificate";
import type { CheckResult, RuleContext } from "../src/types";

let fixtures: TlsFixtures;
const servers: LocalTlsServer[] = [];

// Generating the chain runs openssl a couple of dozen times: about 3.5s.
beforeAll(() => {
  fixtures = createTlsFixtures();
}, 60_000);

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

const DEFAULTS: TlsCertificateOptions = optionsSchema.parse({});

/**
 * Audit `hosts` (the first key is the audited host). A host mapped to a
 * certificate is served locally; a host mapped to `null` does not answer.
 * Every handshake the rule makes is recorded in `calls`.
 */
async function audit(
  hosts: Record<string, ServedCertificate | null>,
  options: Partial<TlsCertificateOptions> = {},
  now: Date = new Date(),
): Promise<{ checks: CheckResult[]; calls: string[] }> {
  const ports = new Map<string, number>();
  for (const [host, served] of Object.entries(hosts)) {
    if (!served) continue;
    const server = await serveCertificate(served);
    servers.push(server);
    ports.set(host, server.port);
  }
  const calls: string[] = [];
  const [audited] = Object.keys(hosts);
  const result = await checkTlsCertificate(`https://${audited}/`, optionsSchema.parse({ ...options }), {
    now,
    probe: async ({ hostname }: TlsTarget): Promise<TlsProbe> => {
      calls.push(hostname);
      const port = ports.get(hostname);
      if (port === undefined) {
        return { kind: "unreachable", code: "ENOTFOUND", message: `${hostname} does not resolve` };
      }
      return probeTlsCertificate(
        { hostname, port },
        { address: "127.0.0.1", ca: fixtures.root },
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

  test("a certificate expiring in 20 days warns with the date and days left", async () => {
    const { checks } = await audit({ localhost: fixtures.expiresIn20Days });
    const expiry = check(checks, "tls-certificate-expiry");
    expect(expiry?.status).toBe("warn");
    expect(expiry?.message).toMatch(/expires in 20 days \(\d{4}-\d{2}-\d{2}\)/);
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

  test("error_days moves the error threshold", async () => {
    const { checks } = await audit({ localhost: fixtures.expiresIn20Days }, { error_days: 25 });
    expect(check(checks, "tls-certificate-expiry")?.status).toBe("fail");
  });

  test("the options default to a 30-day warning and a 7-day error", () => {
    expect(DEFAULTS).toEqual({ warn_days: 30, error_days: 7 });
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
  test("a runtime without a TLS socket API reports not checked, never pass", async () => {
    const result = await checkTlsCertificate("https://example.test/", DEFAULTS, {
      now: new Date(),
      probe: async () => ({ kind: "unavailable", reason: "node:tls has no connect()" }),
    });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ status: "info", value: "not-checked" });
    expect(result.checks[0]!.message).toContain("not checked");
  });

  test("a handshake that cannot complete reports not checked, never fail", async () => {
    const result = await checkTlsCertificate("https://example.test/", DEFAULTS, {
      now: new Date(),
      probe: async () => ({ kind: "unreachable", code: "ECONNREFUSED", message: "refused" }),
    });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ status: "info", value: "not-checked" });
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

describe("the rule against a real socket", () => {
  test("run() handshakes with a local server and reports the self-signed certificate", async () => {
    const server = await serveCertificate(fixtures.selfSigned);
    servers.push(server);
    const ctx = {
      site: { baseUrl: `https://127.0.0.1:${server.port}/`, pages: [] },
      options: {},
      page: { url: `https://127.0.0.1:${server.port}/` },
    } as unknown as RuleContext;

    const result = await tlsCertificateRule.run(ctx);
    const checks = result.checks as CheckResult[];
    expect(check(checks, "tls-certificate-chain")?.message).toContain("self-signed");
    // The fixture lasts 30 days, inside the default 30-day warning window.
    expect(check(checks, "tls-certificate-expiry")?.status).toBe("warn");
  });

  test("run() reports not checked for a port nothing listens on", async () => {
    const server = await serveCertificate(fixtures.valid);
    const port = server.port;
    await server.close();
    const ctx = {
      site: { baseUrl: `https://127.0.0.1:${port}/`, pages: [] },
      options: {},
      page: { url: `https://127.0.0.1:${port}/` },
    } as unknown as RuleContext;

    const result = await tlsCertificateRule.run(ctx);
    const checks = result.checks as CheckResult[];
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: "info", value: "not-checked" });
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
