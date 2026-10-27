// The CLI's TLS probe (#712): one vetted, pinned handshake per call. Every
// certificate is generated at test time and served from 127.0.0.1, and every
// name resolves through an injected resolver, so no live host or DNS server is
// contacted.

import type { CheckResult, RuleContext } from "@squirrelscan/rules/types";

import { tlsCertificateRule } from "@squirrelscan/rules/security/tls-certificate";
import {
  certificateProblems,
  daysUntil,
  type TlsProbe,
} from "@squirrelscan/utils/tls-certificate";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createServer, type Socket } from "node:net";

import {
  createTlsProbe,
  type TlsProbeOptions,
} from "../../src/audit/tls-probe";
import {
  createTlsFixtures,
  serveCertificate,
  type LocalTlsServer,
  type ServedCertificate,
  type TlsFixtures,
} from "../helpers/tls-fixtures";

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

const PROXY_VARS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
] as const;
const savedProxy = Object.fromEntries(
  PROXY_VARS.map((name) => [name, process.env[name]])
);
afterEach(() => {
  for (const name of PROXY_VARS) {
    if (savedProxy[name] === undefined) delete process.env[name];
    else process.env[name] = savedProxy[name];
  }
});
for (const name of PROXY_VARS) delete process.env[name];

async function serve(served: ServedCertificate): Promise<number> {
  const server = await serveCertificate(served);
  servers.push(server);
  return server.port;
}

/** A resolver that answers from `answers` and records every name it is asked. */
function resolver(answers: Record<string, string[]>) {
  const asked: string[] = [];
  return {
    asked,
    resolve: async (hostname: string) => {
      asked.push(hostname);
      const addresses = answers[hostname];
      if (!addresses)
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
          code: "ENOTFOUND",
        });
      return addresses;
    },
  };
}

/** Handshake with `served` as `localhost`, which resolves to the fixture server. */
async function handshake(
  served: ServedCertificate,
  trust = true
): Promise<TlsProbe> {
  const port = await serve(served);
  const probe = createTlsProbe({
    allowPrivateNetwork: true,
    resolve: resolver({ localhost: ["127.0.0.1"] }).resolve,
    ...(trust ? { ca: fixtures.root } : {}),
  });
  return probe({ hostname: "localhost", port });
}

function certificate(
  probe: TlsProbe
): Extract<TlsProbe, { kind: "certificate" }> {
  if (probe.kind !== "certificate")
    throw new Error(`expected a certificate, got ${JSON.stringify(probe)}`);
  return probe;
}

describe("certificate facts from a real handshake", () => {
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
    expect(certificateProblems(probe, "localhost", NOW)).toEqual([
      { kind: "incomplete-chain" },
    ]);
  });

  test("a self-signed certificate is reported as self-signed", async () => {
    const probe = certificate(await handshake(fixtures.selfSigned, false));
    expect(probe.trustError).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    expect(certificateProblems(probe, "localhost", NOW)).toContainEqual({
      kind: "self-signed",
    });
  });

  test("a full chain to a root the runtime does not trust is an untrusted root", async () => {
    const probe = certificate(await handshake(fixtures.valid, false));
    expect(probe.trusted).toBe(false);
    expect(certificateProblems(probe, "localhost", NOW)).toContainEqual(
      expect.objectContaining({ kind: "untrusted-root" })
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
    expect(
      certificate(await handshake(fixtures.weakKey)).certificate.rsaBits
    ).toBe(1024);
    expect(
      certificate(await handshake(fixtures.ecKey)).certificate.rsaBits
    ).toBeUndefined();
  });

  test("a port nobody listens on is unreachable, not a certificate", async () => {
    const server = await serveCertificate(fixtures.valid);
    const port = server.port;
    await server.close();
    const probe = createTlsProbe({
      allowPrivateNetwork: true,
      resolve: resolver({ localhost: ["127.0.0.1"] }).resolve,
      timeoutMs: 3_000,
    });
    expect((await probe({ hostname: "localhost", port })).kind).toBe(
      "unreachable"
    );
  });
});

test("a server that accepts and never answers the handshake times out as unreachable", async () => {
  const held: Socket[] = [];
  const server = createServer((socket) => {
    held.push(socket);
  });
  await new Promise<void>((done) =>
    server.listen(0, "127.0.0.1", () => done())
  );
  const { port } = server.address() as { port: number };
  try {
    const probe = createTlsProbe({
      allowPrivateNetwork: true,
      resolve: resolver({ localhost: ["127.0.0.1"] }).resolve,
    });
    const started = Date.now();
    const result = await probe({ hostname: "localhost", port, timeoutMs: 300 });
    expect(result).toMatchObject({ kind: "unreachable", code: "ETIMEDOUT" });
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally {
    for (const socket of held) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

describe("the egress guard runs before every handshake", () => {
  const PUBLIC_SITE = "https://shop.example.com/";

  function publicSiteProbe(
    answers: Record<string, string[]>,
    extra: Partial<TlsProbeOptions> = {}
  ) {
    const dns = resolver(answers);
    return {
      dns,
      probe: createTlsProbe({
        siteUrl: PUBLIC_SITE,
        resolve: dns.resolve,
        ca: fixtures.root,
        ...extra,
      }),
    };
  }

  test("a metadata answer is refused and nothing connects, even where private networks are allowed", async () => {
    const dns = resolver({ "shop.example.com": ["169.254.169.254"] });
    const probe = createTlsProbe({
      allowPrivateNetwork: true,
      resolve: dns.resolve,
    });
    const result = await probe({ hostname: "shop.example.com", port: 443 });
    expect(result).toMatchObject({
      kind: "unreachable",
      code: "EGRESS_REFUSED",
    });
    expect(dns.asked).toEqual(["shop.example.com"]);
  });

  test("an IPv6 link-local or a metadata literal is refused without a lookup", async () => {
    const { dns, probe } = publicSiteProbe({});
    expect(
      await probe({ hostname: "169.254.169.254", port: 443 })
    ).toMatchObject({ code: "EGRESS_REFUSED" });
    expect(await probe({ hostname: "fe80::1", port: 443 })).toMatchObject({
      code: "EGRESS_REFUSED",
    });
    expect(
      await probe({ hostname: "metadata.google.internal", port: 443 })
    ).toMatchObject({
      code: "EGRESS_REFUSED",
    });
    expect(dns.asked).toEqual([]);
  });

  test("a name that answers one public and one metadata address is refused as a whole", async () => {
    const { probe } = publicSiteProbe({
      "www.example.com": ["93.184.216.34", "169.254.169.254"],
    });
    expect(
      await probe({ hostname: "www.example.com", port: 443 })
    ).toMatchObject({
      code: "EGRESS_REFUSED",
    });
  });

  test("a public site's other name may not resolve to a private address", async () => {
    const port = await serve(fixtures.example);
    const { probe } = publicSiteProbe({ "www.example.com": ["127.0.0.1"] });
    const result = await probe({ hostname: "www.example.com", port });
    expect(result).toMatchObject({
      kind: "unreachable",
      code: "EGRESS_REFUSED",
    });
  });

  test("the audited origin itself may resolve privately: the crawl already requests it", async () => {
    const port = await serve(fixtures.valid);
    const dns = resolver({ "shop.example.com": ["127.0.0.1"] });
    const probe = createTlsProbe({
      siteUrl: `https://shop.example.com:${port}/`,
      resolve: dns.resolve,
      ca: fixtures.root,
    });
    const result = await probe({ hostname: "shop.example.com", port });
    expect(result.kind).toBe("certificate");
    // Another port on the same host is not the audited origin.
    const otherPort = await serve(fixtures.valid);
    expect(
      await probe({ hostname: "shop.example.com", port: otherPort })
    ).toMatchObject({
      code: "EGRESS_REFUSED",
    });
  });

  test("the socket connects to the address that was checked, with the name as SNI", async () => {
    // The fixture server only listens on 127.0.0.1, so a certificate proves the
    // pinned address was used; the hostname mismatch proves SNI and the
    // verification name were the audited name, not the address.
    const port = await serve(fixtures.wrongName);
    const dns = resolver({ "lan.example.com": ["127.0.0.1"] });
    const probe = createTlsProbe({
      allowPrivateNetwork: true,
      resolve: dns.resolve,
      ca: fixtures.root,
    });
    const result = certificate(
      await probe({ hostname: "lan.example.com", port })
    );
    expect(result.trustError).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(dns.asked).toEqual(["lan.example.com"]);
  });

  test("each name is resolved once per probe, so a rebinding answer cannot move a later handshake", async () => {
    const port = await serve(fixtures.valid);
    let calls = 0;
    const probe = createTlsProbe({
      allowPrivateNetwork: true,
      ca: fixtures.root,
      resolve: async () =>
        ++calls === 1 ? ["127.0.0.1"] : ["169.254.169.254"],
    });
    expect((await probe({ hostname: "localhost", port })).kind).toBe(
      "certificate"
    );
    expect((await probe({ hostname: "localhost", port })).kind).toBe(
      "certificate"
    );
    expect(calls).toBe(1);
  });

  test("a host the URL parser would read as something else is refused before any lookup", async () => {
    const { dns, probe } = publicSiteProbe({});
    for (const hostname of [
      "0x7f.1",
      "user@example.com",
      "example.com/path",
      "example.com:8443",
    ]) {
      expect(await probe({ hostname, port: 443 })).toMatchObject({
        kind: "unreachable",
        code: "EGRESS_REFUSED",
      });
    }
    expect(dns.asked).toEqual([]);
  });

  test("--offline contacts the audited host only: the counterpart is not checked and not resolved", async () => {
    const port = await serve(fixtures.valid);
    const dns = resolver({
      "example.com": ["127.0.0.1"],
      "www.example.com": ["127.0.0.1"],
    });
    const probe = createTlsProbe({
      siteUrl: `https://example.com:${port}/`,
      siteHostOnly: true,
      resolve: dns.resolve,
      ca: fixtures.root,
    });
    expect(await probe({ hostname: "www.example.com", port })).toMatchObject({
      kind: "unavailable",
      reason: "--offline contacts only the audited host, not www.example.com",
    });
    expect((await probe({ hostname: "example.com", port })).kind).toBe(
      "certificate"
    );
    expect(dns.asked).toEqual(["example.com"]);

    // A site URL spelled with the root dot is the same host.
    const dotted = createTlsProbe({
      siteUrl: `https://example.com.:${port}/`,
      siteHostOnly: true,
      resolve: dns.resolve,
      ca: fixtures.root,
    });
    expect((await dotted({ hostname: "example.com", port })).kind).toBe(
      "certificate"
    );
  });

  test("a name that does not resolve is unreachable with the resolver's code", async () => {
    const { probe } = publicSiteProbe({});
    expect(
      await probe({ hostname: "missing.example.com", port: 443 })
    ).toMatchObject({
      kind: "unreachable",
      code: "ENOTFOUND",
    });
  });

  test("behind an HTTP proxy from the environment no handshake is made", async () => {
    process.env.HTTPS_PROXY = "http://proxy.invalid:8080";
    const { dns, probe } = publicSiteProbe({
      "shop.example.com": ["93.184.216.34"],
    });
    const result = await probe({ hostname: "shop.example.com", port: 443 });
    expect(result.kind).toBe("unavailable");
    expect(dns.asked).toEqual([]);
  });
});

describe("security/tls-certificate with the CLI's probe", () => {
  test("run() handshakes through ctx.tlsProbe and reports the self-signed certificate", async () => {
    const port = await serve(fixtures.selfSigned);
    const baseUrl = `https://127.0.0.1:${port}/`;
    const ctx = {
      site: { baseUrl, pages: [] },
      options: {},
      page: { url: baseUrl },
      tlsProbe: createTlsProbe({ siteUrl: baseUrl }),
    } as unknown as RuleContext;

    const checks = (await tlsCertificateRule.run(ctx)).checks as CheckResult[];
    expect(
      checks.find((item) => item.name === "tls-certificate-chain")?.message
    ).toContain("self-signed");
    // The fixture lasts 30 days, inside the default 30-day warning window.
    expect(
      checks.find((item) => item.name === "tls-certificate-expiry")?.status
    ).toBe("warn");
  });

  test("a www variant that resolves privately for a public site is never contacted", async () => {
    const port = await serve(fixtures.example);
    const dns = resolver({
      "example.com": ["127.0.0.1"],
      "www.example.com": ["127.0.0.1"],
    });
    const baseUrl = `https://example.com:${port}/`;
    const ctx = {
      site: { baseUrl, pages: [] },
      options: {},
      page: { url: baseUrl },
      tlsProbe: createTlsProbe({
        siteUrl: baseUrl,
        resolve: dns.resolve,
        ca: fixtures.root,
      }),
    } as unknown as RuleContext;

    const checks = (await tlsCertificateRule.run(ctx)).checks as CheckResult[];
    expect(
      checks.find((item) => item.name === "tls-certificate-expiry")
    ).toBeDefined();
    expect(
      checks.find((item) => item.name === "tls-certificate-www")
    ).toBeUndefined();
    expect(dns.asked).toEqual(["example.com", "www.example.com"]);
  });
});
