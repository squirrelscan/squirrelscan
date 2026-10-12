import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  certificateCovers,
  certificateProblems,
  daysUntil,
  probeTlsCertificate,
  tlsFailureCause,
  type TlsProbe,
} from "../src/tls-certificate";
import {
  createTlsFixtures,
  serveCertificate,
  type LocalTlsServer,
  type TlsFixtures,
} from "./helpers/tls-fixtures";

const NOW = new Date();

let fixtures: TlsFixtures;
const servers: LocalTlsServer[] = [];

// Generating the chain runs openssl a couple of dozen times: about 3.5s.
beforeAll(() => {
  fixtures = createTlsFixtures();
}, 60_000);

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

/** Serve `served` locally and handshake with it, trusting the fixture root. */
async function handshake(
  served: Parameters<typeof serveCertificate>[0],
  options: { trust?: boolean } = { trust: true },
): Promise<TlsProbe> {
  const server = await serveCertificate(served);
  servers.push(server);
  return probeTlsCertificate(
    { hostname: "localhost", port: server.port },
    { address: "127.0.0.1", ...(options.trust ? { ca: fixtures.root } : {}) },
  );
}

function certificate(probe: TlsProbe): Extract<TlsProbe, { kind: "certificate" }> {
  if (probe.kind !== "certificate") throw new Error(`expected a certificate, got ${probe.kind}`);
  return probe;
}

describe("probeTlsCertificate on local fixtures", () => {
  test("a valid chain is trusted, with its issuer and expiry", async () => {
    const probe = certificate(await handshake(fixtures.valid));
    expect(probe.trusted).toBe(true);
    expect(probe.trustError).toBeUndefined();
    expect(probe.certificate.names).toContain("localhost");
    expect(probe.certificate.issuer).toBe("squirrel test intermediate");
    expect(probe.certificate.validTo.getTime()).toBeGreaterThan(NOW.getTime());
    expect(certificateProblems(probe, "localhost", NOW)).toEqual([]);
  });

  test("a leaf served without its intermediate is an incomplete chain", async () => {
    const probe = certificate(await handshake(fixtures.leafOnly));
    expect(probe.trustError).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    expect(certificateProblems(probe, "localhost", NOW)).toEqual([{ kind: "incomplete-chain" }]);
  });

  test("a self-signed certificate is reported as self-signed", async () => {
    const probe = certificate(await handshake(fixtures.selfSigned, { trust: false }));
    expect(probe.trustError).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    expect(certificateProblems(probe, "localhost", NOW)).toContainEqual({ kind: "self-signed" });
  });

  test("a full chain to a root the runtime does not trust is an untrusted root", async () => {
    const probe = certificate(await handshake(fixtures.valid, { trust: false }));
    expect(probe.trusted).toBe(false);
    expect(certificateProblems(probe, "localhost", NOW)).toContainEqual(
      expect.objectContaining({ kind: "untrusted-root" }),
    );
  });

  test("an expired certificate is reported with its end date", async () => {
    const probe = certificate(await handshake(fixtures.expired));
    const [problem] = certificateProblems(probe, "localhost", NOW);
    expect(problem).toMatchObject({ kind: "expired" });
    expect(daysUntil(probe.certificate.validTo, NOW)).toBeLessThan(0);
  });

  test("a certificate for another name is a hostname problem that names what it covers", async () => {
    const probe = certificate(await handshake(fixtures.wrongName));
    expect(certificateProblems(probe, "localhost", NOW)).toContainEqual({
      kind: "hostname",
      hostname: "localhost",
      names: ["other.test"],
    });
  });

  test("an RSA key reports its modulus size, an EC key reports none", async () => {
    const weak = certificate(await handshake(fixtures.weakKey));
    expect(weak.certificate.rsaBits).toBe(1024);
    const ec = certificate(await handshake(fixtures.ecKey));
    expect(ec.certificate.rsaBits).toBeUndefined();
  });

  test("a port nobody listens on is unreachable, not a certificate", async () => {
    const server = await serveCertificate(fixtures.valid);
    const port = server.port;
    await server.close();
    const probe = await probeTlsCertificate(
      { hostname: "localhost", port },
      { address: "127.0.0.1", ca: fixtures.root, timeoutMs: 3_000 },
    );
    expect(probe.kind).toBe("unreachable");
  });
});

describe("certificateCovers", () => {
  test("matches exact names case-insensitively", () => {
    expect(certificateCovers(["example.com"], "Example.COM")).toBe(true);
    expect(certificateCovers(["example.com"], "www.example.com")).toBe(false);
  });

  test("a wildcard covers exactly one label", () => {
    const names = ["*.example.com"];
    expect(certificateCovers(names, "www.example.com")).toBe(true);
    expect(certificateCovers(names, "example.com")).toBe(false);
    expect(certificateCovers(names, "a.b.example.com")).toBe(false);
  });

  test("an IP address is covered only by an IP entry", () => {
    expect(certificateCovers(["127.0.0.1"], "127.0.0.1")).toBe(true);
    expect(certificateCovers([], "localhost")).toBe(false);
  });
});

describe("tlsFailureCause", () => {
  const base = { trusted: false } as const;
  const certAt = (validTo: Date, names: string[] = ["example.com"]) => ({
    kind: "certificate" as const,
    ...base,
    certificate: {
      names,
      issuer: "Test CA",
      validFrom: new Date("2019-01-01T00:00:00Z"),
      validTo,
    },
  });

  test("names an expired certificate by its end date", () => {
    const cause = tlsFailureCause(
      certAt(new Date("2020-01-15T00:00:00Z"), ["example.com"]),
      "example.com",
      NOW,
    );
    expect(cause).toBe("certificate has expired on 2020-01-15");
  });

  test("names the hostname the certificate does not cover", () => {
    const probe = { ...certAt(new Date("2099-01-01T00:00:00Z"), ["other.test"]), trustError: "ERR_TLS_CERT_ALTNAME_INVALID" };
    expect(tlsFailureCause(probe, "example.com", NOW)).toBe(
      "hostname/IP does not match: the certificate does not cover example.com",
    );
  });

  test("names a missing intermediate", () => {
    const probe = { ...certAt(new Date("2099-01-01T00:00:00Z")), trustError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" };
    expect(tlsFailureCause(probe, "example.com", NOW)).toContain("did not send its intermediate");
  });

  test("returns nothing when the handshake found no problem or could not look", () => {
    expect(tlsFailureCause({ kind: "unavailable", reason: "no tls" }, "example.com", NOW)).toBeUndefined();
    const valid = { ...certAt(new Date("2099-01-01T00:00:00Z")), trusted: true };
    expect(tlsFailureCause(valid, "example.com", NOW)).toBeUndefined();
  });
});
