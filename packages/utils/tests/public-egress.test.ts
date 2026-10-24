// The egress guard for third-party probes (#703): what a page on a public site
// can make squirrel request, and what it cannot, on every redirect hop.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EgressRefusedError,
  assertEgressAllowed,
  egressGuardedSend,
  egressRefuses,
  isLinkLocalOrMetadataAddress,
  isNonPublicAddress,
  memoizeResolveHost,
  refusedWithoutLookup,
  vetEgressTarget,
  type EgressPolicy,
  type ResolveHost,
} from "../src/public-egress";
import { safeRedirectFetch } from "../src/safe-fetch";

/** A resolver from a fixed table that records every name it is asked for. */
function table(answers: Record<string, string[]>): ResolveHost & { asked: string[] } {
  const asked: string[] = [];
  const resolve = async (host: string) => {
    asked.push(host);
    const answer = answers[host];
    if (!answer) throw new Error(`ENOTFOUND ${host}`);
    return answer;
  };
  return Object.assign(resolve, { asked });
}

const PUBLIC_DNS = {
  "cdn.example.net": ["93.184.216.34"],
  "dual.example.net": ["93.184.216.34", "2606:2800:220:1::1"],
  "rebind.example.net": ["93.184.216.34", "10.0.0.9"],
  "mapped.example.net": ["::ffff:10.0.0.1"],
  "meta.example.net": ["169.254.169.254"],
  "dev.localhost": ["127.0.0.1"],
  localhost: ["127.0.0.1", "::1"],
};

function publicOnly(resolve: ResolveHost = table(PUBLIC_DNS)): EgressPolicy {
  return { allowPrivateNetwork: false, resolve };
}

function privateNetwork(resolve: ResolveHost = table(PUBLIC_DNS)): EgressPolicy {
  return { allowPrivateNetwork: true, resolve };
}

async function refused(url: string, policy: EgressPolicy): Promise<boolean> {
  try {
    await assertEgressAllowed(url, policy);
    return false;
  } catch (error) {
    if (error instanceof EgressRefusedError) return true;
    throw error;
  }
}

describe("assertEgressAllowed: public site", () => {
  test.each([
    "http://127.0.0.1/a",
    "http://127.8.9.10:8080/a",
    // Decimal, hex, octal and short IPv4 spellings, canonicalized by the URL parser.
    "http://2130706433/a",
    "http://0x7f000001/a",
    "http://0177.0.0.1/a",
    "http://127.1/a",
    "http://0xa9.0xfe.0xa9.0xfe/latest/meta-data/",
    "http://0251.0376.0251.0376/latest/meta-data/",
    "http://[::ffff:7f00:1]/a",
    "http://10.0.0.5/a",
    "http://172.16.4.1/a",
    "http://192.168.1.10/a",
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.169.254./latest/meta-data/",
    "http://0.0.0.0/a",
    "http://100.64.0.1/a",
    "http://[::1]/a",
    "http://[fe80::1]/a",
    "http://[fd00::1]/a",
    "http://[::ffff:169.254.169.254]/a",
    "http://[::ffff:10.0.0.1]/a",
    // IPv6 forms a NAT64 or 6to4 gateway delivers to a private IPv4 address.
    "http://[64:ff9b::a00:1]/a",
    "http://[64:ff9b::a9fe:a9fe]/a",
    "http://[64:ff9b:1::a00:1]/a",
    "http://[::a00:1]/a",
    "http://[2002:a9fe:a9fe::]/a",
    "http://[2002:a00:1::1]/a",
    // Reserved, multicast, broadcast and metadata ranges outside RFC1918.
    "http://192.0.0.192/a",
    "http://198.18.0.1/a",
    "http://224.0.0.1/a",
    "http://240.0.0.1/a",
    "http://255.255.255.255/a",
    "http://168.63.129.16/a",
    "http://[fec0::1]/a",
    "http://[ff02::1]/a",
    "http://localhost:3000/a",
    "http://app.localhost/a",
    "http://localhost./a",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://box.local/a",
    "http://service.test/a",
    "http://intranet/a",
    "ftp://cdn.example.net/a",
    "file:///etc/passwd",
  ])("refuses %s without a lookup", async (url) => {
    const resolve = table(PUBLIC_DNS);
    expect(await refused(url, publicOnly(resolve))).toBe(true);
    expect(resolve.asked).toEqual([]);
  });

  test.each([
    ["rebind.example.net", "any private answer refuses the name"],
    ["mapped.example.net", "an IPv4-mapped private answer"],
    ["meta.example.net", "a name that resolves to the metadata address"],
  ])("refuses %s (%s)", async (host) => {
    expect(await refused(`https://${host}/a.js`, publicOnly())).toBe(true);
  });

  test("allows a public IP literal and a name whose every answer is public", async () => {
    expect(await refused("https://93.184.216.34/a.js", publicOnly())).toBe(false);
    expect(await refused("https://[2606:4700::1111]/a.js", publicOnly())).toBe(false);
    // NAT64 and 6to4 of a public IPv4 address stay public.
    expect(await refused("https://[64:ff9b::5db8:d822]/a.js", publicOnly())).toBe(false);
    expect(await refused("https://[2002:5db8:d822::1]/a.js", publicOnly())).toBe(false);
    expect(await refused("https://cdn.example.net/a.js", publicOnly())).toBe(false);
    expect(await refused("https://dual.example.net/a.js", publicOnly())).toBe(false);
  });

  test("a name that resolves to no address at all is refused", async () => {
    const policy = { allowPrivateNetwork: false, resolve: async () => [] };
    expect(await refused("https://empty.example.net/a.js", policy)).toBe(true);
  });

  test("a name that does not resolve fails as the network error, not as refused", async () => {
    await expect(assertEgressAllowed("https://nx.example.net/a.js", publicOnly())).rejects.toThrow(
      "ENOTFOUND",
    );
  });

  test("an abort during a slow lookup rejects as an AbortError", async () => {
    const controller = new AbortController();
    const policy = { allowPrivateNetwork: false, resolve: () => new Promise<string[]>(() => {}) };
    const pending = assertEgressAllowed("https://slow.example.net/a.js", policy, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("assertEgressAllowed: site on a private network", () => {
  test.each([
    "http://127.0.0.1:4000/a",
    "http://10.0.0.5/a",
    "http://[::1]/a",
    "http://localhost:3000/a",
    "http://dev.localhost/a",
  ])("allows %s", async (url) => {
    expect(await refused(url, privateNetwork())).toBe(false);
  });

  test.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.10.20/a",
    "http://[fe80::1]/a",
    "http://[fd00:ec2::254]/latest/meta-data/",
    "http://[::ffff:169.254.169.254]/a",
    "http://[64:ff9b::a9fe:a9fe]/a",
    "http://168.63.129.16/machine",
    "http://100.100.100.200/latest/meta-data/",
    "http://192.0.0.192/opc/v1/",
    // Local-use NAT64 can embed 169.254.169.254 where it cannot be read back.
    "http://[64:ff9b:1:a9fe:a9:fe00::]/a",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://meta.example.net/a",
  ])("still refuses link-local and metadata: %s", async (url) => {
    expect(await refused(url, privateNetwork())).toBe(true);
  });
});

describe("isLinkLocalOrMetadataAddress", () => {
  test.each([
    ["169.254.169.254", true],
    ["[fe80::1]", true],
    ["febf::1", true],
    ["fd00:ec2::254", true],
    ["::ffff:a9fe:a9fe", true],
    ["10.0.0.1", false],
    ["127.0.0.1", false],
    ["fec0::1", false],
    ["93.184.216.34", false],
    ["not-an-ip", false],
  ])("%s -> %p", (address, expected) => {
    expect(isLinkLocalOrMetadataAddress(address)).toBe(expected);
  });
});

describe("egressGuardedSend with safeRedirectFetch: every hop is vetted, then pinned", () => {
  interface Sent {
    /** What the request connected to. */
    url: string;
    host: string | null;
    serverName: string | undefined;
  }
  /**
   * A fake transport. Each request is answered by its LOGICAL URL (the connect
   * URL with the Host header put back), and every send is recorded as sent.
   */
  function transport(answers: Record<string, () => Response>) {
    const sent: Sent[] = [];
    const send = async (url: string, init: RequestInit) => {
      const host = new Headers(init.headers).get("host");
      const tls = (init as { tls?: { serverName?: string } }).tls;
      sent.push({ url, host, serverName: tls?.serverName });
      const logical = new URL(url);
      if (host) logical.host = host;
      const answer = answers[logical.href];
      return answer ? answer() : new Response("ok", { status: 200 });
    };
    return { send, sent };
  }
  const to = (location: string) => () => new Response(null, { status: 302, headers: { location } });

  test.each([
    ["the metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["a private IP", "http://10.0.0.7/x"],
    ["loopback", "http://127.0.0.1:6379/"],
    ["a decimal-encoded loopback", "http://2130706433/"],
    ["a public-looking name that resolves privately", "http://rebind.example.net/x"],
  ])("a redirect to %s is refused and never sent", async (_label, location) => {
    const first = "https://cdn.example.net/a.js";
    const { send, sent } = transport({ [first]: to(location) });
    await expect(
      safeRedirectFetch(first, { method: "HEAD" }, egressGuardedSend(send, publicOnly())),
    ).rejects.toBeInstanceOf(EgressRefusedError);
    expect(sent.map((s) => s.url)).toEqual(["https://93.184.216.34/a.js"]);
  });

  test("allowHost holds every hop to the allowed hosts: an off-site redirect is refused unsent", async () => {
    const first = "https://cdn.example.net/m.json";
    const { send, sent } = transport({ [first]: to("https://dual.example.net/m.json") });
    const policy = { ...publicOnly(), allowHost: (host: string) => host === "cdn.example.net" };
    await expect(
      safeRedirectFetch(first, {}, egressGuardedSend(send, policy)),
    ).rejects.toBeInstanceOf(EgressRefusedError);
    expect(sent.map((s) => s.host)).toEqual(["cdn.example.net"]);
  });

  test("a connection that fails moves to the next vetted address; an answer or an abort is final", async () => {
    // localhost answering ::1 and 127.0.0.1 for a dev server listening on ::1 only.
    const resolve = table({ "dev.localhost": ["::1", "127.0.0.1"] });
    const tried: string[] = [];
    const send = async (url: string) => {
      tried.push(url);
      if (url.startsWith("http://127.0.0.1")) {
        throw Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused" });
      }
      return new Response("ok", { status: 200 });
    };
    const { response } = await safeRedirectFetch(
      "http://dev.localhost:5173/app",
      {},
      egressGuardedSend(send, privateNetwork(resolve)),
    );
    expect(response.status).toBe(200);
    expect(tried).toEqual(["http://127.0.0.1:5173/app", "http://[::1]:5173/app"]);

    const aborted: string[] = [];
    const abortingSend = async (url: string) => {
      aborted.push(url);
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    await expect(
      safeRedirectFetch(
        "http://dev.localhost:5173/app",
        {},
        egressGuardedSend(abortingSend, privateNetwork(resolve)),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(aborted).toHaveLength(1);
  });

  test("an error after the connection was made is final: the request is never re-sent", async () => {
    const resolve = table({ "dev.localhost": ["127.0.0.1", "::1"] });
    const tried: string[] = [];
    const send = async (url: string) => {
      tried.push(url);
      throw Object.assign(new TypeError("socket reset"), { code: "ECONNRESET" });
    };
    await expect(
      safeRedirectFetch(
        "http://dev.localhost/app",
        {},
        egressGuardedSend(send, privateNetwork(resolve)),
      ),
    ).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(tried).toEqual(["http://127.0.0.1/app"]);
  });

  test("a connect failure after the caller aborted is final too", async () => {
    const resolve = table({ "dev.localhost": ["127.0.0.1", "::1"] });
    const controller = new AbortController();
    const tried: string[] = [];
    const send = async (url: string) => {
      tried.push(url);
      controller.abort();
      throw Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused" });
    };
    await expect(
      safeRedirectFetch(
        "http://dev.localhost/app",
        { signal: controller.signal },
        egressGuardedSend(send, privateNetwork(resolve)),
      ),
    ).rejects.toMatchObject({ code: "ConnectionRefused" });
    expect(tried).toHaveLength(1);
  });

  test("a scoped IPv6 answer is skipped for a pinnable one", async () => {
    const resolve = table({ "v6.localhost": ["fd00::5%en0", "::1"] });
    const tried: string[] = [];
    const send = async (url: string) => {
      tried.push(url);
      return new Response("ok");
    };
    await safeRedirectFetch(
      "http://v6.localhost/app",
      {},
      egressGuardedSend(send, privateNetwork(resolve)),
    );
    expect(tried).toEqual(["http://[::1]/app"]);
  });

  test("at most one address per family is tried, however many the name answers", async () => {
    const many = Array.from({ length: 30 }, (_, n) => `93.184.216.${n + 1}`);
    const resolve = table({ "wide.example.net": [...many, "2606:2800:220:1::1"] });
    const tried: string[] = [];
    const send = async (url: string) => {
      tried.push(url);
      throw Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused" });
    };
    await expect(
      safeRedirectFetch(
        "https://wide.example.net/a.js",
        {},
        egressGuardedSend(send, publicOnly(resolve)),
      ),
    ).rejects.toMatchObject({ code: "ConnectionRefused" });
    expect(tried).toEqual(["https://93.184.216.1/a.js", "https://[2606:2800:220:1::1]/a.js"]);
  });

  test("allowPrivateTarget lets the site's own origin resolve privately, and nothing else", async () => {
    const resolve = table({
      "staging.example.com": ["10.0.0.20"],
      "cdn.staging.example.com": ["10.0.0.21"],
      "meta.staging.example.com": ["169.254.169.254"],
    });
    const policy = {
      allowPrivateNetwork: false,
      allowPrivateTarget: (url: URL) => url.origin === "https://staging.example.com",
      resolve,
    };
    expect(await refused("https://staging.example.com/m.json", policy)).toBe(false);
    // Another port on the same host, or a subdomain, is not the site's origin.
    expect(await refused("https://staging.example.com:8443/m.json", policy)).toBe(true);
    expect(await refused("https://cdn.staging.example.com/m.json", policy)).toBe(true);
    // Link-local and metadata stay refused even for an allowed target.
    const metaPolicy = { ...policy, allowPrivateTarget: () => true };
    expect(await refused("https://meta.staging.example.com/m.json", metaPolicy)).toBe(true);
  });

  test("a refused first hop sends nothing", async () => {
    const { send, sent } = transport({});
    await expect(
      safeRedirectFetch("http://10.0.0.1/a", {}, egressGuardedSend(send, publicOnly())),
    ).rejects.toBeInstanceOf(EgressRefusedError);
    expect(sent).toEqual([]);
  });

  test("a name connects to the vetted address, keeping its Host header and TLS server name", async () => {
    const { send, sent } = transport({});
    await safeRedirectFetch(
      "https://cdn.example.net:8443/a.js?v=1",
      {},
      egressGuardedSend(send, publicOnly()),
    );
    expect(sent).toEqual([
      {
        url: "https://93.184.216.34:8443/a.js?v=1",
        host: "cdn.example.net:8443",
        serverName: "cdn.example.net",
      },
    ]);
  });

  test("plain http keeps the Host header and sets no TLS server name; IPv4 is preferred", async () => {
    const { send, sent } = transport({});
    await safeRedirectFetch("http://dual.example.net/a", {}, egressGuardedSend(send, publicOnly()));
    expect(sent).toEqual([
      { url: "http://93.184.216.34/a", host: "dual.example.net", serverName: undefined },
    ]);
  });

  test("an IPv6-only name connects to the bracketed address", async () => {
    const { send, sent } = transport({});
    const resolve = table({ "v6.example.net": ["2606:2800:220:1::1"] });
    await safeRedirectFetch(
      "https://v6.example.net/a.js",
      {},
      egressGuardedSend(send, publicOnly(resolve)),
    );
    expect(sent).toEqual([
      {
        url: "https://[2606:2800:220:1::1]/a.js",
        host: "v6.example.net",
        serverName: "v6.example.net",
      },
    ]);
  });

  test("pin: false (a transport that pins itself) still vets and refuses, but sends the name", async () => {
    const { send, sent } = transport({});
    const policy = { ...publicOnly(), pin: false };
    await safeRedirectFetch("http://cdn.example.net/a", {}, egressGuardedSend(send, policy));
    expect(sent).toEqual([{ url: "http://cdn.example.net/a", host: null, serverName: undefined }]);
    await expect(
      safeRedirectFetch("http://rebind.example.net/a", {}, egressGuardedSend(send, policy)),
    ).rejects.toBeInstanceOf(EgressRefusedError);
    expect(sent).toHaveLength(1);
  });

  test("a trailing-dot name keeps its Host but presents the name without the dot", async () => {
    const { send, sent } = transport({});
    await safeRedirectFetch(
      "https://cdn.example.net./a.js",
      {},
      egressGuardedSend(send, publicOnly(table({ "cdn.example.net.": ["93.184.216.34"] }))),
    );
    expect(sent).toEqual([
      {
        url: "https://93.184.216.34/a.js",
        host: "cdn.example.net.",
        serverName: "cdn.example.net",
      },
    ]);
  });

  test.each([
    ["a name", "cdn.other.net"],
    ["a scoped IPv6 address", "2606:2800:220:1::1%en0"],
  ])(
    "a resolver answer that cannot be pinned (%s) is refused, never sent by name",
    async (_label, answer) => {
      const { send, sent } = transport({});
      const policy = publicOnly(table({ "odd.example.net": [answer] }));
      await expect(
        safeRedirectFetch("https://odd.example.net/a.js", {}, egressGuardedSend(send, policy)),
      ).rejects.toBeInstanceOf(EgressRefusedError);
      expect(sent).toEqual([]);
    },
  );

  test("an IP literal is sent as is, with no Host override", async () => {
    const { send, sent } = transport({});
    await safeRedirectFetch("http://93.184.216.34/a", {}, egressGuardedSend(send, publicOnly()));
    expect(sent).toEqual([{ url: "http://93.184.216.34/a", host: null, serverName: undefined }]);
  });

  test("DNS rebinding cannot move the connection: the request goes to the address that was vetted", async () => {
    // Answers public to the guard; a second lookup would answer private. The
    // guard asks once and the connection is pinned, so the second never happens.
    let lookups = 0;
    const resolve = async () => (++lookups === 1 ? ["93.184.216.34"] : ["10.0.0.9"]);
    const { send, sent } = transport({});
    await safeRedirectFetch(
      "https://rebinder.example.net/a.js",
      {},
      egressGuardedSend(send, publicOnly(resolve)),
    );
    expect(lookups).toBe(1);
    expect(sent.map((s) => s.url)).toEqual(["https://93.184.216.34/a.js"]);
  });

  test("a redirect between public hosts is followed, each hop vetted and pinned by its own name", async () => {
    const first = "https://cdn.example.net/a.js";
    const second = "https://dual.example.net/b.js";
    const { send, sent } = transport({ [first]: to(second) });
    const { response, finalUrl } = await safeRedirectFetch(
      first,
      {},
      egressGuardedSend(send, publicOnly()),
    );
    expect(response.status).toBe(200);
    expect(finalUrl).toBe(second);
    expect(sent).toEqual([
      { url: "https://93.184.216.34/a.js", host: "cdn.example.net", serverName: "cdn.example.net" },
      {
        url: "https://93.184.216.34/b.js",
        host: "dual.example.net",
        serverName: "dual.example.net",
      },
    ]);
  });
});

// The pin relies on the runtime checking the certificate against the TLS
// server name, not the IP it connects to. Proven against a real TLS server with
// a throwaway CA, generated at run time so no key is ever committed.
describe.skipIf(!Bun.which("openssl"))("pinned TLS against a real server", () => {
  let dir: string;
  let ca: string;
  let server: ReturnType<typeof Bun.serve>;
  const hosts: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "egress-pin-"));
    const run = (...args: string[]) => {
      const result = Bun.spawnSync(["openssl", ...args], { cwd: dir, stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    run(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-days",
      "1",
      "-subj",
      "/CN=egress test CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign",
    );
    run(
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "leaf.key",
      "-out",
      "leaf.csr",
      "-subj",
      "/CN=pinned.test",
    );
    writeFileSync(
      join(dir, "ext.cnf"),
      "subjectAltName=DNS:pinned.test\nextendedKeyUsage=serverAuth\n",
    );
    run(
      "x509",
      "-req",
      "-in",
      "leaf.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      "leaf.pem",
      "-days",
      "1",
      "-extfile",
      "ext.cnf",
    );
    ca = readFileSync(join(dir, "ca.pem"), "utf8");
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: {
        cert: readFileSync(join(dir, "leaf.pem"), "utf8"),
        key: readFileSync(join(dir, "leaf.key"), "utf8"),
      },
      fetch(req) {
        hosts.push(req.headers.get("host") ?? "");
        return new Response("ok");
      },
    });
  });

  afterAll(() => {
    server?.stop(true);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // 127.0.0.1 is private, so these run under the private-network policy; the
  // point is the TLS behaviour of a pinned request, not the address rules.
  const policy = () =>
    privateNetwork(table({ "pinned.test": ["127.0.0.1"], "other.test": ["127.0.0.1"] }));
  const send = (url: string, init: RequestInit) => fetch(url, init);

  test("connects to the vetted address with the name as Host and as the certificate's name", async () => {
    const { response } = await safeRedirectFetch(
      `https://pinned.test:${server.port}/a.js`,
      { tls: { ca } } as RequestInit,
      egressGuardedSend(send, policy()),
    );
    expect(response.status).toBe(200);
    expect(hosts.at(-1)).toBe(`pinned.test:${server.port}`);
  });

  test("a certificate that does not cover the name is rejected, though the address is the same", async () => {
    await expect(
      safeRedirectFetch(
        `https://other.test:${server.port}/a.js`,
        { tls: { ca } } as RequestInit,
        egressGuardedSend(send, policy()),
      ),
    ).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });
});

describe("isNonPublicAddress", () => {
  test.each([
    ["10.1.2.3", true],
    ["203.0.113.9", true],
    ["2001:db8::1", true],
    ["::", true],
    ["::ffff:192.168.1.1", true],
    ["64:ff9b::7f00:1", true],
    ["93.184.216.34", false],
    ["2606:4700::1111", false],
    ["64:ff9b::5db8:d822", false],
    ["example.com", false],
  ])("%s -> %p", (address, expected) => {
    expect(isNonPublicAddress(address)).toBe(expected);
  });
});

describe("memoizeResolveHost", () => {
  test("forgets a failed lookup, so the next request asks again", async () => {
    let calls = 0;
    const memo = memoizeResolveHost(async () => {
      calls++;
      if (calls === 1) throw new Error("EAI_AGAIN");
      return ["93.184.216.34"];
    });
    await expect(memo("flaky.example.net")).rejects.toThrow("EAI_AGAIN");
    expect(await memo("flaky.example.net")).toEqual(["93.184.216.34"]);
    expect(await memo("flaky.example.net")).toEqual(["93.184.216.34"]);
    expect(calls).toBe(2);
  });

  test("resolves each name once, case-insensitively", async () => {
    const resolve = table(PUBLIC_DNS);
    const memo = memoizeResolveHost(resolve);
    await memo("cdn.example.net");
    await memo("CDN.example.net");
    await memo("dual.example.net");
    expect(resolve.asked).toEqual(["cdn.example.net", "dual.example.net"]);
  });
});

describe("trustTarget: the hosts the crawl requests are sent as it sends them (repo#2764)", () => {
  // An mDNS name answers link-local IPv6 next to its LAN address, so vetting
  // the site's own name would refuse every one of its assets.
  const lan = () =>
    table({
      "printer.local": ["192.168.1.5", "fe80::1"],
      "imds.printer.local": ["169.254.169.254"],
      "meta.example.net": ["169.254.169.254"],
    });
  const policy = (resolve: ResolveHost, trusted = ["printer.local"]): EgressPolicy => ({
    allowPrivateNetwork: true,
    resolve,
    trustTarget: (url) => trusted.includes(url.hostname),
  });

  test("a trusted host is neither resolved nor refused", async () => {
    const resolve = lan();
    expect(await refused("http://printer.local/style.css", policy(resolve))).toBe(false);
    expect(resolve.asked).not.toContain("printer.local");
  });

  test("without trust, the same name is refused for its link-local answer", async () => {
    expect(
      await refused("http://printer.local/style.css", { ...policy(lan()), trustTarget: undefined }),
    ).toBe(true);
  });

  test("a subdomain is not trusted with its parent: one pointed at metadata is refused", async () => {
    expect(await refused("http://imds.printer.local/latest/meta-data/", policy(lan()))).toBe(true);
  });

  test("trust never reaches a metadata hostname or a link-local or metadata literal", async () => {
    const trustEverything: EgressPolicy = {
      allowPrivateNetwork: true,
      resolve: lan(),
      trustTarget: () => true,
    };
    expect(await refused("http://metadata.google.internal/", trustEverything)).toBe(true);
    expect(await refused("http://169.254.169.254/latest/meta-data/", trustEverything)).toBe(true);
    expect(await refused("http://[fe80::1]/x.png", trustEverything)).toBe(true);
  });

  test("a hop that leaves the trusted hosts is vetted as before", async () => {
    const p = policy(lan());
    expect(await refused("http://169.254.169.254/latest/meta-data/", p)).toBe(true);
    expect(await refused("http://meta.example.net/", p)).toBe(true);
    expect(await refused("http://metadata.google.internal/", p)).toBe(true);
    expect(await refused("http://[fe80::1]/x.png", p)).toBe(true);
  });

  test("a trusted host is sent unpinned, by its name", async () => {
    const sent: string[] = [];
    const send = egressGuardedSend(async (url) => {
      sent.push(url);
      return new Response("ok");
    }, policy(lan()));
    await send("http://printer.local/style.css", {});
    expect(sent).toEqual(["http://printer.local/style.css"]);
  });
});

describe("refusedWithoutLookup: what the URL alone settles (pub#770)", () => {
  const publicSite: EgressPolicy = { allowPrivateNetwork: false };
  const privateSite: EgressPolicy = { allowPrivateNetwork: true };

  test("refused on a public site's audit without any lookup", () => {
    for (const url of [
      "http://127.0.0.1:3000/",
      "http://10.0.0.5/admin",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/",
      "http://localhost:8080/",
      "http://printer.local/",
      "ftp://example.com/file",
      "not a url",
    ]) {
      expect(refusedWithoutLookup(url, publicSite)).toBe(true);
    }
  });

  test("a public name is left to the request's own vetting", () => {
    expect(refusedWithoutLookup("https://partner.example.com/pricing", publicSite)).toBe(false);
  });

  test("a private site's audit allows private addresses, never link-local or metadata", () => {
    expect(refusedWithoutLookup("http://10.0.0.5/admin", privateSite)).toBe(false);
    expect(refusedWithoutLookup("http://localhost:8080/", privateSite)).toBe(false);
    expect(refusedWithoutLookup("http://169.254.169.254/", privateSite)).toBe(true);
    expect(refusedWithoutLookup("http://[fe80::1]/", privateSite)).toBe(true);
    expect(refusedWithoutLookup("http://metadata.google.internal/", privateSite)).toBe(true);
  });
});

describe("egressRefuses: a redirect loop's pre-check (repo#2830)", () => {
  const policy: EgressPolicy = {
    allowPrivateNetwork: true,
    resolve: table({ "intranet.test": ["10.0.0.5"], "imds.example.com": ["169.254.169.254"] }),
  };

  test("true for what the policy refuses, false for what it allows; nothing is sent", async () => {
    expect(await egressRefuses("http://169.254.169.254/latest/", policy)).toBe(true);
    expect(await egressRefuses("http://metadata.google.internal/", policy)).toBe(true);
    expect(await egressRefuses("http://imds.example.com/", policy)).toBe(true);
    expect(await egressRefuses("http://intranet.test/", policy)).toBe(false);
  });

  test("a resolver failure is not a refusal: it propagates", async () => {
    await expect(egressRefuses("http://unknown.test/", policy)).rejects.toThrow("ENOTFOUND");
  });
});

describe("a scoped link-local answer beside routable ones (repo#2830)", () => {
  // What macOS answers for a LAN mDNS name such as `nas.local`.
  const lan = ["::1", "fe80::1c2b:3a4d:5e6f:7081%en0", "fd07::5", "127.0.0.1", "192.168.1.5"];

  test("is set aside for a pinned request, which connects to a routable address", async () => {
    const target = await vetEgressTarget("http://nas.local:5000/", {
      allowPrivateNetwork: true,
      resolve: table({ "nas.local": lan }),
    });
    expect(target?.urls.some((url) => url.includes("fe80"))).toBe(false);
    expect(target?.urls).toContain("http://127.0.0.1:5000/");
  });

  test("still refuses a name whose only answers are scoped link-local", async () => {
    await expect(
      vetEgressTarget("http://printer.local/", {
        allowPrivateNetwork: true,
        resolve: table({ "printer.local": ["fe80::1%en0"] }),
      }),
    ).rejects.toThrow(EgressRefusedError);
  });

  test("still refuses an unscoped link-local answer, and any when the transport connects by name", async () => {
    await expect(
      vetEgressTarget("http://nas.local/", {
        allowPrivateNetwork: true,
        resolve: table({ "nas.local": ["192.168.1.5", "fe80::1"] }),
      }),
    ).rejects.toThrow(EgressRefusedError);
    await expect(
      vetEgressTarget("http://nas.local/", {
        allowPrivateNetwork: true,
        pin: false,
        resolve: table({ "nas.local": lan }),
      }),
    ).rejects.toThrow(EgressRefusedError);
  });
});
