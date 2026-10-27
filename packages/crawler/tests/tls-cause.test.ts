// The crawl's TLS root failure names its cause from one injected handshake
// (#712). The probe here is a stand-in that answers certificate facts: the
// crawler opens no socket of its own, and the CLI's real probe is tested in
// apps/cli/tests/audit/tls-probe.test.ts.

import { describe, expect, test } from "bun:test";

import { auditFailureDetail, type AuditFailureDetail } from "@squirrelscan/core-contracts/failure-reason";
import type { TlsProbe, TlsProbeFn, TlsTarget } from "@squirrelscan/utils/tls-certificate";

import { memoizeTlsProbe, TLS_CAUSE_TIMEOUT_MS, withTlsCause } from "../src/tls-cause";

const DAY_MS = 86_400_000;

function tlsDetail(): AuditFailureDetail {
  return auditFailureDetail({
    code: "tls",
    host: "127.0.0.1",
    detail: "unable to verify the first certificate",
  });
}

function served(overrides: Partial<Extract<TlsProbe, { kind: "certificate" }>> & {
  names?: string[];
  validTo?: Date;
} = {}): TlsProbe {
  const { names = ["127.0.0.1"], validTo = new Date(Date.now() + 90 * DAY_MS), ...rest } = overrides;
  return {
    kind: "certificate",
    certificate: { names, issuer: "Test CA", validFrom: new Date(Date.now() - DAY_MS), validTo },
    trusted: true,
    ...rest,
  };
}

/** A probe that answers `result` and records every target it was asked for. */
function recording(result: TlsProbe) {
  const targets: TlsTarget[] = [];
  const probe: TlsProbeFn = async (target) => {
    targets.push(target);
    return result;
  };
  return { probe, targets };
}

const SITE = "https://127.0.0.1:8443/";

describe("withTlsCause", () => {
  test("an expired certificate names its end date", async () => {
    const { probe } = recording(served({ validTo: new Date("2020-01-15T00:00:00Z"), trusted: false }));
    const out = await withTlsCause(tlsDetail(), SITE, probe);
    expect(out.detail).toBe("certificate has expired on 2020-01-15");
  });

  test("a certificate for another name names the hostname it does not cover", async () => {
    const { probe } = recording(
      served({ names: ["other.test"], trusted: false, trustError: "ERR_TLS_CERT_ALTNAME_INVALID" }),
    );
    const out = await withTlsCause(tlsDetail(), SITE, probe);
    expect(out.detail).toContain("does not cover 127.0.0.1");
  });

  test("a self-signed certificate says so", async () => {
    const { probe } = recording(served({ trusted: false, trustError: "DEPTH_ZERO_SELF_SIGNED_CERT" }));
    expect((await withTlsCause(tlsDetail(), SITE, probe)).detail).toBe("self-signed certificate");
  });

  test("a server that omits its intermediate names the missing chain", async () => {
    const { probe } = recording(served({ trusted: false, trustError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }));
    expect((await withTlsCause(tlsDetail(), SITE, probe)).detail).toContain("intermediate");
  });

  test("without an injected probe the fetch's detail stands", async () => {
    const detail = tlsDetail();
    expect(await withTlsCause(detail, SITE, undefined)).toBe(detail);
  });

  test("a non-TLS failure and a plain http URL keep their detail and send nothing", async () => {
    const { probe, targets } = recording(served({ trusted: false, trustError: "DEPTH_ZERO_SELF_SIGNED_CERT" }));
    const dns = auditFailureDetail({ code: "dns", host: "127.0.0.1" });
    expect(await withTlsCause(dns, SITE, probe)).toBe(dns);
    const detail = tlsDetail();
    expect(await withTlsCause(detail, "http://127.0.0.1:8080/", probe)).toBe(detail);
    expect(targets).toEqual([]);
  });

  test("a handshake that cannot be made, or one the guard refused, keeps the fetch's detail", async () => {
    for (const result of [
      { kind: "unreachable", code: "ECONNREFUSED", message: "refused" },
      { kind: "unreachable", code: "EGRESS_REFUSED", message: "not contacted" },
      { kind: "unavailable", reason: "proxy" },
    ] satisfies TlsProbe[]) {
      const detail = tlsDetail();
      expect(await withTlsCause(detail, SITE, recording(result).probe)).toBe(detail);
    }
  });

  test("the handshake waits at most 3 s, or less when the URL's budget has less left", async () => {
    const { probe, targets } = recording(served());
    await withTlsCause(tlsDetail(), SITE, probe);
    await withTlsCause(tlsDetail(), SITE, probe, 60_000);
    await withTlsCause(tlsDetail(), SITE, probe, 1_200);
    expect(targets.map((target) => target.timeoutMs)).toEqual([
      TLS_CAUSE_TIMEOUT_MS,
      TLS_CAUSE_TIMEOUT_MS,
      1_200,
    ]);
    expect(TLS_CAUSE_TIMEOUT_MS).toBe(3_000);
    expect(targets[0]).toMatchObject({ hostname: "127.0.0.1", port: 8443 });
  });

  test("no budget left skips the handshake", async () => {
    const { probe, targets } = recording(served());
    const detail = tlsDetail();
    expect(await withTlsCause(detail, SITE, probe, 0)).toBe(detail);
    expect(await withTlsCause(detail, SITE, probe, -500)).toBe(detail);
    expect(targets).toEqual([]);
  });
});

describe("memoizeTlsProbe", () => {
  test("one handshake per host and port, however many pages fail", async () => {
    const { probe, targets } = recording(served());
    const once = memoizeTlsProbe(probe);
    await Promise.all([
      once({ hostname: "Example.com", port: 443 }),
      once({ hostname: "example.com" }),
      once({ hostname: "example.com", port: 443 }),
    ]);
    await once({ hostname: "example.com", port: 8443 });
    expect(targets.map((target) => `${target.hostname}:${target.port ?? 443}`)).toEqual([
      "Example.com:443",
      "example.com:8443",
    ]);
  });

  test("a probe that throws is remembered as unreachable, not rethrown", async () => {
    const once = memoizeTlsProbe(async () => {
      throw new Error("boom");
    });
    expect(await once({ hostname: "example.com" })).toMatchObject({ kind: "unreachable", message: "boom" });
  });
});
