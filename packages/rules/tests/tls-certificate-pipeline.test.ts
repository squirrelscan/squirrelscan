// security/tls-certificate through the audit's rule stage (#712).
//
// The audited URL is a public-looking name, so the runner does not apply the
// private-target skip, and the rule runs the way it does in an audit: options
// come from `rule_options` in the config, one site pass, one handshake per
// host. The handshake is the runner scope's `tlsProbe`, which the CLI injects;
// here it answers certificate facts for each name, so the test touches no DNS
// and no socket. Without one the rule reports "not checked".

import { describe, expect, test } from "bun:test";

import type { TlsProbe, TlsProbeFn, TlsTarget } from "@squirrelscan/utils/tls-certificate";

import { RuleRunner, type RulesConfig } from "../src/runner";
import type { CheckResult, SiteData } from "../src/types";

const RULE = "security/tls-certificate";
const AUDITED = "tls-fixture.com";
const WWW = "www.tls-fixture.com";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function served(names: string[], validTo: Date): TlsProbe {
  return {
    kind: "certificate",
    certificate: {
      names,
      issuer: "squirrel test intermediate",
      // A 90-day certificate, so the lifetime-relative warning window applies (#1279);
      // a long-lived one (365 days out) started a day ago.
      validFrom:
        validTo.getTime() - Date.now() > 100 * DAY_MS
          ? new Date(Date.now() - DAY_MS)
          : new Date(validTo.getTime() - 90 * DAY_MS),
      validTo,
      rsaBits: 2048,
    },
    trusted: validTo.getTime() > Date.now(),
    ...(validTo.getTime() > Date.now() ? {} : { trustError: "CERT_HAS_EXPIRED" }),
  };
}

const inDays = (days: number) => new Date(Date.now() + days * DAY_MS + HOUR_MS);
const AUDITED_NAMES = [AUDITED, WWW];

/** A probe answering `hosts` (null or absent: does not resolve), recording each target. */
function probeFor(hosts: Record<string, TlsProbe | null>): { probe: TlsProbeFn; targets: TlsTarget[] } {
  const targets: TlsTarget[] = [];
  return {
    targets,
    probe: async (target) => {
      targets.push(target);
      return (
        hosts[target.hostname] ?? {
          kind: "unreachable",
          code: "ENOTFOUND",
          message: `${target.hostname} does not resolve`,
        }
      );
    },
  };
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
  tlsProbe: TlsProbeFn | undefined,
  ruleOptions: Record<string, unknown> = {},
): Promise<CheckResult[]> {
  const config: RulesConfig = {
    rule_options: { [RULE]: ruleOptions },
    rules: { enable: [RULE] },
  };
  const runner = new RuleRunner({ config, ...(tlsProbe ? { tlsProbe } : {}) });
  const { ruleResults } = await runner.runSiteRules(site(baseUrl));
  return ruleResults.get(RULE)?.checks ?? [];
}

function expiry(checks: CheckResult[]): CheckResult | undefined {
  return checks.find((check) => check.name === "tls-certificate-expiry");
}

describe("certificate expiry through the audit's rule stage", () => {
  const only = (certificate: TlsProbe) => probeFor({ [AUDITED]: certificate, [WWW]: null }).probe;

  test("a 90-day certificate with 28 days left does not warn, one with 10 days left does (#1279)", async () => {
    const ok = expiry(await auditStage(`https://${AUDITED}/`, only(served(AUDITED_NAMES, inDays(28)))));
    expect(ok?.status).toBe("pass");
    const check = expiry(await auditStage(`https://${AUDITED}/`, only(served(AUDITED_NAMES, inDays(10)))));
    expect(check?.status).toBe("warn");
    expect(check?.message).toMatch(/expires in 10 days \(\d{4}-\d{2}-\d{2}\)/);
  });

  test("a certificate expiring in 5 days is an error", async () => {
    const check = expiry(await auditStage(`https://${AUDITED}/`, only(served(AUDITED_NAMES, inDays(5)))));
    expect(check?.status).toBe("fail");
    expect(check?.message).toMatch(/expires in 5 days/);
  });

  test("an expired certificate is an error that names the date", async () => {
    const check = expiry(await auditStage(`https://${AUDITED}/`, only(served(AUDITED_NAMES, inDays(-3)))));
    expect(check?.status).toBe("fail");
    expect(check?.message).toMatch(/^Certificate expired on \d{4}-\d{2}-\d{2}/);
  });

  test("rule options from the config move the thresholds", async () => {
    // A 20-day certificate is outside the lifetime window by default; warn_days = 30 makes it a
    // warning, error_days 14 keeps it one, and error_days 25 (with warn_days 30) turns it into an error.
    const probe = only(served(AUDITED_NAMES, inDays(20)));
    expect(expiry(await auditStage(`https://${AUDITED}/`, probe))?.status).toBe("pass");
    expect(expiry(await auditStage(`https://${AUDITED}/`, probe, { warn_days: 30, error_days: 14 }))?.status).toBe("warn");
    expect(expiry(await auditStage(`https://${AUDITED}/`, probe, { warn_days: 30, error_days: 25 }))?.status).toBe("fail");
  });

  test("a valid certificate passes with issuer and expiry in the same stage", async () => {
    const { probe, targets } = probeFor({ [AUDITED]: served(AUDITED_NAMES, inDays(365)), [WWW]: null });
    const check = expiry(await auditStage(`https://${AUDITED}/`, probe));
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("squirrel test intermediate");
    expect(targets.map((target) => target.hostname)).toEqual([AUDITED, WWW]);
  });

  test("a runner with no tlsProbe in its scope reports not checked", async () => {
    const checks = await auditStage(`https://${AUDITED}/`, undefined);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: "skipped",
      value: "not-checked",
      skipReason: "tls-certificate-not-checked",
    });
  });
});

describe("www/apex counterpart through the audit's rule stage", () => {
  test("a counterpart whose certificate does not cover it warns, naming it", async () => {
    const { probe } = probeFor({
      "example.com": served(["example.com"], inDays(365)),
      "www.example.com": served(["other.test"], inDays(365)),
    });
    const checks = await auditStage("https://example.com/", probe);
    const www = checks.find((check) => check.name === "tls-certificate-www");
    expect(www?.status).toBe("warn");
    expect(www?.message).toContain("www.example.com");
  });

  test("a counterpart that does not resolve adds nothing", async () => {
    const { probe } = probeFor({ "example.com": served(["example.com"], inDays(365)) });
    const checks = await auditStage("https://example.com/", probe);
    expect(checks.find((check) => check.name === "tls-certificate-www")).toBeUndefined();
  });

  test("a subdomain audit derives no counterpart: only the registrable domain has one", async () => {
    const { probe, targets } = probeFor({ "blog.example.com": served(["blog.example.com"], inDays(365)) });
    await auditStage("https://blog.example.com/", probe);
    expect(targets.map((target) => target.hostname)).toEqual(["blog.example.com"]);
  });
});
