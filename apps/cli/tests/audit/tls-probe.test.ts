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
  spyOn,
  test,
} from "bun:test";
import { createServer as createHttpServer } from "node:http";
import {
  connect as connectTcp,
  createServer,
  type AddressInfo,
  type Socket,
} from "node:net";

import {
  createTlsProbe,
  proxyForTarget,
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

  test("a proxy this check cannot tunnel through is reported, never bypassed (#1259)", async () => {
    process.env.HTTPS_PROXY = "socks5://proxy.invalid:1080";
    const { dns, probe } = publicSiteProbe({
      "shop.example.com": ["93.184.216.34"],
    });
    const result = await probe({ hostname: "shop.example.com", port: 443 });
    expect(result.kind).toBe("unavailable");
    expect(result).toMatchObject({
      reason: expect.stringContaining("socks5 proxy"),
    });
    expect(dns.asked).toEqual([]);
  });
});

/** A CONNECT proxy on 127.0.0.1 that records every target it is asked for. */
async function connectProxy(
  mode: "accept" | { refuse: number } | "hang" | "garbage" = "accept",
  listenHost = "127.0.0.1"
): Promise<{ port: number; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const open = new Set<Socket>();
  const server = createHttpServer();
  server.on("connect", (req, client: Socket, head) => {
    open.add(client);
    client.on("close", () => open.delete(client));
    client.on("error", () => {});
    seen.push(req.url ?? "");
    if (mode === "hang") return;
    if (mode === "garbage") {
      client.write("not http at all\r\n\r\n");
      return;
    }
    if (typeof mode === "object") {
      client.write(
        `HTTP/1.1 ${mode.refuse} Refused\r\nContent-Length: 0\r\n\r\n`
      );
      client.end();
      return;
    }
    const [host, port] = (req.url ?? "").split(":");
    const upstream = connectTcp(Number(port), host ?? "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    open.add(upstream);
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, listenHost, resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("behind an HTTP proxy from the environment (#1259)", () => {
  const proxies: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  });
  const via = async (mode: Parameters<typeof connectProxy>[0] = "accept") => {
    const proxy = await connectProxy(mode);
    proxies.push(proxy);
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
    return proxy;
  };
  const PUBLIC_AND_LOCAL = {
    localhost: ["127.0.0.1"],
    "shop.example.com": ["93.184.216.34"],
  };
  const probeVia = (
    options: TlsProbeOptions = {},
    answers: Record<string, string[]> = PUBLIC_AND_LOCAL
  ) => {
    const dns = resolver(answers);
    return {
      dns,
      // The fixture server is on loopback, so private answers are allowed for the happy paths.
      probe: createTlsProbe({
        ca: fixtures.root,
        resolve: dns.resolve,
        allowPrivateNetwork: true,
        ...options,
      }),
    };
  };

  test("the handshake goes through a CONNECT tunnel to the vetted address, with SNI and verification intact", async () => {
    const proxy = await via();
    const port = await serve(fixtures.valid);
    const { dns, probe } = probeVia();
    const result = certificate(await probe({ hostname: "localhost", port }));
    // The CONNECT names the address the guard vetted, never the name.
    expect(proxy.seen).toEqual([`127.0.0.1:${port}`]);
    expect(result.trusted).toBe(true);
    expect(result.certificate.names).toContain("localhost");
    // Resolved once, locally, by the guard.
    expect(dns.asked).toEqual(["localhost"]);
  });

  test("an HTTP_PROXY alone is used too", async () => {
    const proxy = await via();
    delete process.env.HTTPS_PROXY;
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
    const port = await serve(fixtures.valid);
    const { probe } = probeVia();
    expect(
      certificate(await probe({ hostname: "localhost", port })).trusted
    ).toBe(true);
    expect(proxy.seen).toEqual([`127.0.0.1:${port}`]);
  });

  test.each([
    ["an expired certificate", "expired", "CERT_HAS_EXPIRED"],
    ["a self-signed certificate", "selfSigned", "DEPTH_ZERO_SELF_SIGNED_CERT"],
    [
      "a leaf without its intermediate",
      "leafOnly",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ],
  ] as const)(
    "%s is reported through the tunnel as it is without a proxy",
    async (_name, key, trustError) => {
      await via();
      const port = await serve(fixtures[key]);
      const { probe } = probeVia();
      const result = certificate(await probe({ hostname: "localhost", port }));
      expect(result.trusted).toBe(false);
      expect(result.trustError).toBe(trustError);
    }
  );

  test("a name the certificate does not cover is still a hostname problem through the tunnel", async () => {
    await via();
    const port = await serve(fixtures.wrongName);
    const { probe } = probeVia();
    const result = certificate(await probe({ hostname: "localhost", port }));
    expect(
      certificateProblems(result, "localhost", NOW).map(
        (problem) => problem.kind
      )
    ).toContain("hostname");
  });

  test("an IP-literal host's certificate is judged against that address, not the proxy's (#1259 review)", async () => {
    // The fixture certificate covers 127.0.0.1; the proxy listens on ::1, a different address.
    let proxy: Awaited<ReturnType<typeof connectProxy>>;
    try {
      proxy = await connectProxy("accept", "::1");
    } catch {
      return; // no IPv6 loopback on this machine
    }
    proxies.push(proxy);
    process.env.HTTPS_PROXY = `http://[::1]:${proxy.port}`;
    const port = await serve(fixtures.valid);
    const { probe } = probeVia({}, { "127.0.0.1": ["127.0.0.1"] });
    const tunnelled = certificate(await probe({ hostname: "127.0.0.1", port }));
    expect(proxy.seen).toEqual([`127.0.0.1:${port}`]);
    expect(tunnelled.trusted).toBe(true);
    expect(tunnelled.trustError).toBeUndefined();
    expect(certificateProblems(tunnelled, "127.0.0.1", NOW)).toEqual([]);
    // Without the proxy the same handshake agrees.
    delete process.env.HTTPS_PROXY;
    const direct = certificate(await probe({ hostname: "127.0.0.1", port }));
    expect(direct.trusted).toBe(true);
  });

  test("a proxy URL with a malformed percent escape in its credentials is not checked, never a throw", async () => {
    const proxy = await via({ refuse: 403 });
    process.env.HTTPS_PROXY = `http://us%zzer:pw@127.0.0.1:${proxy.port}`; // pragma: allowlist secret
    const { probe } = probeVia();
    expect(
      await probe({ hostname: "shop.example.com", port: 443 })
    ).toMatchObject({
      kind: "unreachable",
      code: "PROXY_BAD_URL",
    });
    expect(proxy.seen).toEqual([]);
  });

  test("an empty NO_PROXY does not shadow no_proxy, and CIDR entries do not match", () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:3128";
    process.env.NO_PROXY = "";
    process.env.no_proxy = "shop.example.com";
    try {
      expect(proxyForTarget("shop.example.com", 443).kind).toBe("direct");
      delete process.env.no_proxy;
      process.env.NO_PROXY = "10.0.0.0/8";
      expect(proxyForTarget("10.1.2.3", 443).kind).toBe("proxy");
    } finally {
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;
    }
  });

  test("a host named by NO_PROXY is probed directly, and the proxy is never contacted", async () => {
    const proxy = await via();
    process.env.NO_PROXY = "other.example, localhost";
    const port = await serve(fixtures.valid);
    const { probe } = probeVia({
      allowPrivateNetwork: true,
      resolve: resolver({ localhost: ["127.0.0.1"] }).resolve,
    });
    expect(
      certificate(await probe({ hostname: "localhost", port })).trusted
    ).toBe(true);
    expect(proxy.seen).toEqual([]);
  });

  test.each([
    ["*", "shop.example.com", true],
    [".example.com", "shop.example.com", true],
    ["*.example.com", "shop.example.com", true],
    ["example.com", "shop.example.com", true],
    ["example.com", "notexample.com", false],
    ["shop.example.com:8443", "shop.example.com", false],
    ["other.test", "shop.example.com", false],
  ])("NO_PROXY=%s for %s direct: %s", (list, host, direct) => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:3128";
    process.env.NO_PROXY = list;
    try {
      expect(proxyForTarget(host, 443).kind).toBe(direct ? "direct" : "proxy");
    } finally {
      delete process.env.NO_PROXY;
    }
  });

  test.each([403, 407, 502])(
    "a proxy that answers CONNECT with %d is not checked, never a pass",
    async (status) => {
      const proxy = await via({ refuse: status });
      const { dns, probe } = probeVia();
      const result = await probe({ hostname: "shop.example.com", port: 443 });
      expect(result).toMatchObject({
        kind: "unreachable",
        code: `PROXY_CONNECT_${status}`,
      });
      expect(proxy.seen).toEqual(["93.184.216.34:443"]);
      expect(dns.asked).toEqual(["shop.example.com"]);
    }
  );

  describe("the egress guard applies behind the proxy (#1259)", () => {
    const strict = (answers: Record<string, string[]>) =>
      probeVia({ allowPrivateNetwork: false }, answers);

    test.each([
      ["a cloud metadata address", "169.254.169.254"],
      ["another link-local address", "169.254.10.10"],
      ["the Azure WireServer address", "168.63.129.16"],
      ["an IPv6 link-local address", "fe80::1"],
    ])(
      "a name that resolves to %s is refused and the proxy is never asked",
      async (_name, address) => {
        const proxy = await via();
        const { probe } = probeVia({}, { "shop.example.com": [address] });
        const result = await probe({ hostname: "shop.example.com", port: 443 });
        expect(result).toMatchObject({
          kind: "unreachable",
          code: "EGRESS_REFUSED",
        });
        expect(proxy.seen).toEqual([]);
      }
    );

    test("an address literal for the metadata service as the start host is refused", async () => {
      const proxy = await via();
      const { probe } = probeVia({ siteUrl: "https://169.254.169.254/" });
      const result = await probe({ hostname: "169.254.169.254", port: 443 });
      expect(result).toMatchObject({
        kind: "unreachable",
        code: "EGRESS_REFUSED",
      });
      expect(proxy.seen).toEqual([]);
    });

    test("a private answer for the www counterpart of a public site is refused, the proxy never asked", async () => {
      const proxy = await via();
      const { probe } = probeVia(
        { siteUrl: "https://example.com/", allowPrivateNetwork: false },
        { "example.com": ["93.184.216.34"], "www.example.com": ["10.0.0.5"] }
      );
      const result = await probe({ hostname: "www.example.com", port: 443 });
      expect(result).toMatchObject({
        kind: "unreachable",
        code: "EGRESS_REFUSED",
      });
      expect(proxy.seen).toEqual([]);
    });

    test("a private-network answer for an ordinary public name is refused", async () => {
      const proxy = await via();
      const { probe } = strict({ "shop.example.com": ["192.168.1.10"] });
      expect(
        await probe({ hostname: "shop.example.com", port: 443 })
      ).toMatchObject({
        kind: "unreachable",
        code: "EGRESS_REFUSED",
      });
      expect(proxy.seen).toEqual([]);
    });

    test("rebinding: the name is resolved once and the CONNECT names the vetted address", async () => {
      const proxy = await via({ refuse: 403 });
      const asked: string[] = [];
      let calls = 0;
      const probe = createTlsProbe({
        ca: fixtures.root,
        // A hostile resolver: public on the first answer, the metadata address after.
        resolve: async (hostname: string) => {
          asked.push(hostname);
          return calls++ === 0 ? ["93.184.216.34"] : ["169.254.169.254"];
        },
      });
      await probe({ hostname: "shop.example.com", port: 443 });
      await probe({ hostname: "shop.example.com", port: 443 });
      // Every CONNECT named an address that passed the guard for that call, never the name
      // the proxy could resolve differently.
      // One lookup per probe: the second answer is never asked for, so it cannot be used.
      expect(asked).toEqual(["shop.example.com"]);
      for (const target of proxy.seen) expect(target).toBe("93.184.216.34:443");
      expect(proxy.seen.length).toBeGreaterThanOrEqual(1);
      expect(proxy.seen.join(",")).not.toContain("169.254");
      expect(proxy.seen.join(",")).not.toContain("shop.example.com");
    });

    test("a name that does not resolve locally is not checked, even though a proxy could resolve it", async () => {
      const proxy = await via();
      const { probe } = strict({});
      expect(
        await probe({ hostname: "only-the-proxy-knows.example.com", port: 443 })
      ).toMatchObject({
        kind: "unreachable",
        code: "ENOTFOUND",
      });
      expect(proxy.seen).toEqual([]);
    });

    test("the proxy's reply never supplies a target: a redirect status is a refusal", async () => {
      const proxy = await via({ refuse: 307 });
      const { probe } = strict({ "shop.example.com": ["93.184.216.34"] });
      expect(
        await probe({ hostname: "shop.example.com", port: 443 })
      ).toMatchObject({
        kind: "unreachable",
        code: "PROXY_CONNECT_307",
      });
      expect(proxy.seen).toEqual(["93.184.216.34:443"]);
    });

    test("a NO_PROXY host takes the direct path, which is vetted the same way", async () => {
      const proxy = await via();
      process.env.NO_PROXY = "shop.example.com";
      const { probe } = strict({ "shop.example.com": ["169.254.169.254"] });
      expect(
        await probe({ hostname: "shop.example.com", port: 443 })
      ).toMatchObject({
        kind: "unreachable",
        code: "EGRESS_REFUSED",
      });
      expect(proxy.seen).toEqual([]);
    });
  });

  test("a proxy that never answers times out as not checked", async () => {
    await via("hang");
    const { probe } = probeVia();
    const started = Date.now();
    const result = await probe({
      hostname: "shop.example.com",
      port: 443,
      timeoutMs: 300,
    });
    expect(result).toMatchObject({
      kind: "unreachable",
      code: "PROXY_TIMEOUT",
    });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("a proxy that sends garbage, and one that is down, are not checked", async () => {
    await via("garbage");
    const { probe } = probeVia();
    expect(
      await probe({ hostname: "shop.example.com", port: 443 })
    ).toMatchObject({
      kind: "unreachable",
      code: "PROXY_BAD_REPLY",
    });
    process.env.HTTPS_PROXY = "http://127.0.0.1:1";
    expect(
      await probe({ hostname: "shop.example.com", port: 443, timeoutMs: 2_000 })
    ).toMatchObject({
      kind: "unreachable",
      code: "PROXY_UNREACHABLE",
    });
  });

  test("proxy credentials are sent as Proxy-Authorization, not logged in the result", async () => {
    const proxy = await via({ refuse: 407 });
    process.env.HTTPS_PROXY = `http://user:secret@127.0.0.1:${proxy.port}`; // pragma: allowlist secret
    const { probe } = probeVia();
    const logs: string[] = [];
    const spies = (["log", "error", "warn", "info", "debug"] as const).map(
      (method) =>
        spyOn(console, method).mockImplementation((...args: unknown[]) => {
          logs.push(args.map(String).join(" "));
        })
    );
    let result: TlsProbe;
    try {
      result = await probe({ hostname: "shop.example.com", port: 443 });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(logs.join("\n")).not.toContain("secret");
  });

  test("the rule reports a refused CONNECT as a skipped, not-checked result", async () => {
    await via({ refuse: 403 });
    const baseUrl = "https://shop.example.com/";
    const ctx = {
      site: { baseUrl, pages: [] },
      options: {},
      page: { url: baseUrl },
      tlsProbe: createTlsProbe({
        siteUrl: baseUrl,
        resolve: resolver({ "shop.example.com": ["93.184.216.34"] }).resolve,
      }),
    } as unknown as RuleContext;
    const checks = (await tlsCertificateRule.run(ctx)).checks as CheckResult[];
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: "tls-certificate",
      status: "skipped",
      value: "not-checked",
      skipReason: "tls-certificate-not-checked",
    });
    expect(checks[0]?.message).toContain("refused CONNECT");
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
    // The fixture lasts 30 days, so its lifetime-relative warning window is
    // short (#1279): no warning by default, a warning when warn_days says so.
    expect(
      checks.find((item) => item.name === "tls-certificate-expiry")?.status
    ).toBe("pass");
    const explicit = (
      await tlsCertificateRule.run({
        ...ctx,
        options: { warn_days: 45 },
      } as unknown as RuleContext)
    ).checks as CheckResult[];
    expect(
      explicit.find((item) => item.name === "tls-certificate-expiry")?.status
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

describe("the proxy resolves names, opt-in (#1317)", () => {
  const proxies: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  });
  const via = async (mode: Parameters<typeof connectProxy>[0] = "accept") => {
    const proxy = await connectProxy(mode);
    proxies.push(proxy);
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
    return proxy;
  };
  const probeFor = (
    options: TlsProbeOptions,
    answers: Record<string, string[]> = {}
  ) => {
    const dns = resolver(answers);
    return {
      dns,
      probe: createTlsProbe({
        ca: fixtures.root,
        resolve: dns.resolve,
        ...options,
      }),
    };
  };

  test("off by default: the CONNECT names the vetted address and the name is resolved here", async () => {
    const proxy = await via({ refuse: 403 });
    const { dns, probe } = probeFor(
      { siteUrl: "https://shop.example.com/" },
      { "shop.example.com": ["93.184.216.34"] }
    );
    expect(
      await probe({ hostname: "shop.example.com", port: 443 })
    ).toMatchObject({ code: "PROXY_CONNECT_403" });
    expect(proxy.seen).toEqual(["93.184.216.34:443"]);
    expect(dns.asked).toEqual(["shop.example.com"]);
  });

  test("on: the audited host is CONNECTed by name and never resolved here", async () => {
    const proxy = await via({ refuse: 403 });
    const { dns, probe } = probeFor({
      siteUrl: "https://shop.example.com/",
      proxyResolvesNames: true,
    });
    expect(
      await probe({ hostname: "shop.example.com", port: 443 })
    ).toMatchObject({ kind: "unreachable", code: "PROXY_CONNECT_403" });
    expect(proxy.seen).toEqual(["shop.example.com:443"]);
    expect(dns.asked).toEqual([]);
  });

  test("on: the www and apex counterparts too, in both directions", async () => {
    for (const [site, host] of [
      ["https://example.com/", "www.example.com"],
      ["https://www.example.com/", "example.com"],
    ] as const) {
      const proxy = await via({ refuse: 403 });
      const { dns, probe } = probeFor({
        siteUrl: site,
        proxyResolvesNames: true,
      });
      await probe({ hostname: host, port: 443 });
      expect(proxy.seen).toEqual([`${host}:443`]);
      expect(dns.asked).toEqual([]);
    }
  });

  test("on: a name that came from page content is still vetted here and CONNECTed by address", async () => {
    const proxy = await via({ refuse: 403 });
    const { dns, probe } = probeFor(
      { siteUrl: "https://example.com/", proxyResolvesNames: true },
      {
        "cdn.othersite.com": ["93.184.216.34"],
        "evil.example.com": ["169.254.169.254"],
      }
    );
    await probe({ hostname: "cdn.othersite.com", port: 443 });
    expect(proxy.seen).toEqual(["93.184.216.34:443"]);
    expect(dns.asked).toEqual(["cdn.othersite.com"]);
    // a sibling subdomain of the site is not the audited host or its counterpart: vetted, and refused on a metadata answer
    expect(
      await probe({ hostname: "evil.example.com", port: 443 })
    ).toMatchObject({ code: "EGRESS_REFUSED" });
    expect(proxy.seen).toEqual(["93.184.216.34:443"]);
  });

  test("on: an IP literal and a metadata name are refused in both modes before a byte is sent", async () => {
    for (const proxyResolvesNames of [false, true]) {
      const proxy = await via();
      const { probe } = probeFor({
        siteUrl: "https://example.com/",
        proxyResolvesNames,
      });
      // not the audited host: vetted locally either way
      expect(
        await probe({ hostname: "169.254.169.254", port: 443 })
      ).toMatchObject({ code: "EGRESS_REFUSED" });
      expect(
        await probe({ hostname: "metadata.google.internal", port: 443 })
      ).toMatchObject({ code: "EGRESS_REFUSED" });
      // the audited host itself being such a name or literal is refused without a lookup, too
      for (const site of [
        "https://169.254.169.254/",
        "https://metadata.google.internal/",
      ]) {
        const host = new URL(site).hostname;
        const { probe: p } = probeFor({
          siteUrl: site,
          proxyResolvesNames,
          allowPrivateNetwork: false,
        });
        const result = await p({ hostname: host, port: 443 });
        expect(result).toMatchObject({ code: "EGRESS_REFUSED" });
      }
      expect(
        proxy.seen.filter(
          (s) => s.includes("169.254") || s.includes("metadata")
        )
      ).toEqual([]);
    }
  });

  test("on: a proxy that refuses, hangs or sends garbage is not checked, and credentials never reach the result", async () => {
    for (const mode of [{ refuse: 407 }, "hang", "garbage"] as const) {
      const proxy = await connectProxy(mode);
      proxies.push(proxy);
      // Built at run time so no credential-shaped literal sits in the source (secret scanner).
      process.env.HTTPS_PROXY = `http://${["user", "s3cret"].join(":")}@127.0.0.1:${proxy.port}`;
      const { probe } = probeFor({
        siteUrl: "https://shop.example.com/",
        proxyResolvesNames: true,
        timeoutMs: 600,
      });
      const result = await probe({ hostname: "shop.example.com", port: 443 });
      expect(result.kind).toBe("unreachable");
      expect(JSON.stringify(result)).not.toContain("s3cret");
    }
  });

  test("on: a certificate through the tunnel is still verified against the name", async () => {
    const proxy = await via();
    const port = await serve(fixtures.valid);
    // "localhost" is the audited host; the proxy relays to it by name and the certificate covers localhost
    const { probe } = probeFor({
      siteUrl: `https://localhost:${port}/`,
      proxyResolvesNames: true,
      allowPrivateNetwork: true,
    });
    const result = certificate(await probe({ hostname: "localhost", port }));
    expect(proxy.seen).toEqual([`localhost:${port}`]);
    expect(result.trusted).toBe(true);
    expect(result.certificate.names).toContain("localhost");
  });
});
