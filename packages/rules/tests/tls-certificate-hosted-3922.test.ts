// security/tls-certificate wording for a hosted (cloud) audit (#3922): a check
// that was not made says so without advice about networks, proxies or
// --offline, which a hosted user cannot act on. The local wording is unchanged.

import { describe, expect, test } from "bun:test";

import type { TlsProbe } from "@squirrelscan/utils/tls-certificate";

import { tlsCertificateRule } from "../src/security/tls-certificate";
import type { CheckResult, RuleContext } from "../src/types";

const ADVICE = /[Pp]roxy|[Pp]roxies|--offline|[Nn]etwork|CONNECT/;

function ctxFor(extra: Partial<RuleContext> = {}): RuleContext {
  return {
    site: { baseUrl: "https://example.com/", pages: [] },
    options: {},
    page: { url: "https://example.com/" },
    ...extra,
  } as unknown as RuleContext;
}

async function checkWith(probe: TlsProbe | undefined, hosted: boolean): Promise<CheckResult> {
  const result = await tlsCertificateRule.run(
    ctxFor({
      ...(probe ? { tlsProbe: async () => probe } : {}),
      ...(hosted ? { hosted: true } : {}),
    }),
  );
  return (result.checks as CheckResult[])[0]!;
}

const REFUSED: TlsProbe = {
  kind: "unreachable",
  code: "EGRESS_REFUSED",
  message: "example.com was not contacted: refused",
};
const PROXY: TlsProbe = {
  kind: "unreachable",
  code: "PROXY_CONNECT_403",
  message: "the proxy 127.0.0.1:3128 refused CONNECT to 93.184.216.34:443 with status 403",
};
const OFFLINE: TlsProbe = {
  kind: "unavailable",
  reason: "--offline contacts only the audited host, not www.example.com",
};
const TIMEOUT: TlsProbe = { kind: "unreachable", code: "ETIMEDOUT", message: "timed out" };

describe("hosted wording of a TLS certificate that was not checked (#3922)", () => {
  test("no probe: the hosted message has no network, proxy or --offline advice", async () => {
    const check = await checkWith(undefined, true);
    expect(check).toMatchObject({
      status: "skipped",
      value: "not-checked",
      skipReason: "tls-certificate-not-checked",
      details: { environment: "cloud" },
    });
    expect(check.message).toBe(
      "TLS certificate not checked: the hosted audit could not open a TLS connection to the site",
    );
    expect(check.message).not.toMatch(ADVICE);
  });

  test.each([
    ["a refused address", REFUSED],
    ["a proxy refusal", PROXY],
    ["an --offline reason", OFFLINE],
    ["a timeout", TIMEOUT],
  ])("%s never leaks local wording and stays skipped", async (_name, probe) => {
    const check = await checkWith(probe, true);
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("tls-certificate-not-checked");
    expect(check.details).toEqual({ environment: "cloud" });
    expect(check.message.startsWith("TLS certificate not checked: the hosted audit")).toBe(true);
    expect(check.message).not.toMatch(ADVICE);
  });

  test("the CLI wording is unchanged and carries no environment marker", async () => {
    expect((await checkWith(undefined, false)).message).toBe(
      "TLS certificate not checked: this environment does not open TLS connections for the audit",
    );
    expect((await checkWith(PROXY, false)).message).toBe(`TLS certificate not checked: ${PROXY.message}`);
    expect((await checkWith(OFFLINE, false)).message).toBe(`TLS certificate not checked: ${OFFLINE.reason}`);
    expect((await checkWith(REFUSED, false)).message).toBe(`TLS certificate not checked: ${REFUSED.message}`);
    expect((await checkWith(TIMEOUT, false)).message).toBe(
      "TLS certificate not checked: no TLS handshake with example.com, error ETIMEDOUT",
    );
    expect((await checkWith(undefined, false)).details).toBeUndefined();
  });
});
