// security/tls-certificate through the audit's rule stage (#712).
//
// The audited URL is a public-looking name, so the runner does not apply the
// private-target skip, and the rule runs the way it does in an audit: options
// come from `rule_options` in the config, one site pass, one handshake per
// host. The name is routed to a local fixture server, which keeps the test off
// DNS and off live hosts. The handshake itself is a real TLS connection to
// 127.0.0.1 with the fixture certificate.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { routeTlsHostForTests } from "@squirrelscan/utils/tls-certificate";

import {
  createTlsFixtures,
  serveCertificate,
  type LocalTlsServer,
  type ServedCertificate,
  type TlsFixtures,
} from "../../utils/tests/helpers/tls-fixtures";

import { RuleRunner, type RulesConfig } from "../src/runner";
import type { CheckResult, SiteData } from "../src/types";

const RULE = "security/tls-certificate";
const AUDITED = "tls-fixture.test";
const WWW = "www.tls-fixture.test";

let fixtures: TlsFixtures;
const servers: LocalTlsServer[] = [];
const restores: Array<() => void> = [];

beforeAll(() => {
  fixtures = createTlsFixtures();
}, 60_000);

afterAll(async () => {
  while (restores.length > 0) restores.pop()?.();
  await Promise.all(servers.map((server) => server.close()));
});

/** Serve `served` on loopback and route `hostname` to it, or to nothing when `served` is null. */
async function route(hostname: string, served: ServedCertificate | null): Promise<void> {
  if (!served) {
    restores.push(routeTlsHostForTests(hostname, null));
    return;
  }
  const server = await serveCertificate(served);
  servers.push(server);
  restores.push(
    routeTlsHostForTests(hostname, { address: "127.0.0.1", port: server.port, ca: fixtures.root }),
  );
}

function site(baseUrl: string): SiteData {
  return {
    baseUrl,
    pages: [
      {
        url: `${baseUrl}`,
        statusCode: 200,
        headers: {},
        contentType: "text/html; charset=utf-8",
      },
    ],
    robotsTxt: null,
    sitemaps: null,
    resourceSizes: { css: [], images: [] },
  } as unknown as SiteData;
}

/** One site pass of the runner with the rule enabled, as an audit runs it. */
async function auditStage(
  baseUrl: string,
  ruleOptions: Record<string, unknown> = {},
): Promise<CheckResult[]> {
  const config: RulesConfig = {
    rule_options: { [RULE]: ruleOptions },
    rules: { enable: [RULE] },
  };
  const { ruleResults } = await new RuleRunner({ config }).runSiteRules(site(baseUrl));
  return ruleResults.get(RULE)?.checks ?? [];
}

function expiry(checks: CheckResult[]): CheckResult | undefined {
  return checks.find((check) => check.name === "tls-certificate-expiry");
}

describe("certificate expiry through the audit's rule stage", () => {
  test("a certificate expiring in 20 days warns with the date and days left", async () => {
    await route(AUDITED, fixtures.expiresIn20Days);
    await route(WWW, null);
    const checks = await auditStage(`https://${AUDITED}/`);
    const check = expiry(checks);
    expect(check?.status).toBe("warn");
    expect(check?.message).toMatch(/expires in 20 days \(\d{4}-\d{2}-\d{2}\)/);
  });

  test("a certificate expiring in 5 days is an error", async () => {
    await route(AUDITED, fixtures.expiresIn5Days);
    await route(WWW, null);
    const check = expiry(await auditStage(`https://${AUDITED}/`));
    expect(check?.status).toBe("fail");
    expect(check?.message).toMatch(/expires in 5 days/);
  });

  test("an expired certificate is an error that names the date", async () => {
    await route(AUDITED, fixtures.expired);
    await route(WWW, null);
    const check = expiry(await auditStage(`https://${AUDITED}/`));
    expect(check?.status).toBe("fail");
    expect(check?.message).toMatch(/^Certificate expired on \d{4}-\d{2}-\d{2}/);
  });

  test("rule options from the config move the thresholds", async () => {
    // A 20-day certificate passes with error_days 14; error_days 25 turns it into an error.
    await route(AUDITED, fixtures.expiresIn20Days);
    await route(WWW, null);
    expect(expiry(await auditStage(`https://${AUDITED}/`, { error_days: 14 }))?.status).toBe(
      "warn",
    );
    expect(expiry(await auditStage(`https://${AUDITED}/`, { error_days: 25 }))?.status).toBe(
      "fail",
    );
  });

  test("a valid certificate passes with issuer and expiry in the same stage", async () => {
    await route(AUDITED, fixtures.valid);
    await route(WWW, null);
    const check = expiry(await auditStage(`https://${AUDITED}/`));
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("squirrel test intermediate");
  });
});

describe("www/apex counterpart through the audit's rule stage", () => {
  test("a counterpart whose certificate does not cover it warns, naming it", async () => {
    await route("example.test", fixtures.example);
    await route("www.example.test", fixtures.wrongName);
    const checks = await auditStage("https://example.test/");
    const www = checks.find((check) => check.name === "tls-certificate-www");
    expect(www?.status).toBe("warn");
    expect(www?.message).toContain("www.example.test");
  });

  test("a counterpart that does not resolve adds nothing", async () => {
    await route("example.test", fixtures.example);
    await route("www.example.test", null);
    const checks = await auditStage("https://example.test/");
    expect(checks.find((check) => check.name === "tls-certificate-www")).toBeUndefined();
  });
});
