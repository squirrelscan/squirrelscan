// The probe's explicit `proxyUrl` (#3922): the hosted audit has no proxy
// environment and must reach every host through its egress guard's local
// CONNECT proxy. The option wins over the environment and over NO_PROXY, and is
// used exactly like an environment proxy: the name is vetted here, CONNECT names
// the vetted address, TLS runs inside the tunnel. Certificates are generated at
// test time and every name resolves through an injected resolver.

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createServer as createHttpServer } from "node:http";
import { connect as connectTcp, type AddressInfo, type Socket } from "node:net";

import { createTlsProbe } from "@/audit/tls-probe";

import {
  createTlsFixtures,
  serveCertificate,
  type LocalTlsServer,
  type TlsFixtures,
} from "../helpers/tls-fixtures";

let fixtures: TlsFixtures;
const servers: LocalTlsServer[] = [];
const proxies: Array<{ close: () => Promise<void> }> = [];

beforeAll(() => {
  fixtures = createTlsFixtures();
}, 60_000);

const ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;
const saved = Object.fromEntries(
  ENV_NAMES.map((name) => [name, process.env[name]])
);
for (const name of ENV_NAMES) delete process.env[name];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

/** A CONNECT proxy on 127.0.0.1 that records every target it is asked for. */
async function connectProxy(mode: "accept" | { refuse: number } = "accept") {
  const seen: string[] = [];
  const open = new Set<Socket>();
  const server = createHttpServer();
  server.on("connect", (req, client: Socket, head) => {
    open.add(client);
    client.on("close", () => open.delete(client));
    client.on("error", () => {});
    seen.push(req.url ?? "");
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const proxy = {
    port: (server.address() as AddressInfo).port,
    seen,
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  proxies.push(proxy);
  return proxy;
}

const resolve = async (hostname: string) => {
  if (hostname === "localhost") return ["127.0.0.1"];
  if (hostname === "shop.example.com") return ["93.184.216.34"];
  throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
    code: "ENOTFOUND",
  });
};

describe("proxyUrl on the shared TLS probe (#3922)", () => {
  test("CONNECT goes to proxyUrl even when environment proxies are set", async () => {
    const explicit = await connectProxy();
    const fromEnv = await connectProxy();
    process.env.HTTPS_PROXY = `http://127.0.0.1:${fromEnv.port}`;
    process.env.HTTP_PROXY = `http://127.0.0.1:${fromEnv.port}`;
    const server = await serveCertificate(fixtures.valid);
    servers.push(server);

    const probe = createTlsProbe({
      ca: fixtures.root,
      resolve,
      allowPrivateNetwork: true,
      proxyUrl: `http://127.0.0.1:${explicit.port}`,
    });
    const result = await probe({ hostname: "localhost", port: server.port });

    expect(explicit.seen).toEqual([`127.0.0.1:${server.port}`]);
    expect(fromEnv.seen).toEqual([]);
    expect(result).toMatchObject({ kind: "certificate", trusted: true });
  });

  test("proxyUrl is used with no proxy environment, and NO_PROXY does not bypass it", async () => {
    const explicit = await connectProxy();
    process.env.NO_PROXY = "localhost";
    const server = await serveCertificate(fixtures.valid);
    servers.push(server);

    const probe = createTlsProbe({
      ca: fixtures.root,
      resolve,
      allowPrivateNetwork: true,
      proxyUrl: `http://127.0.0.1:${explicit.port}`,
    });
    await probe({ hostname: "localhost", port: server.port });
    expect(explicit.seen).toEqual([`127.0.0.1:${server.port}`]);
  });

  test.each([403, 407, 502])(
    "a %d from the proxy is not checked, never a pass",
    async (status) => {
      const explicit = await connectProxy({ refuse: status });
      const probe = createTlsProbe({
        ca: fixtures.root,
        resolve,
        proxyUrl: `http://127.0.0.1:${explicit.port}`,
      });
      const result = await probe({ hostname: "shop.example.com", port: 443 });
      expect(result).toMatchObject({
        kind: "unreachable",
        code: `PROXY_CONNECT_${status}`,
      });
      expect(explicit.seen).toEqual(["93.184.216.34:443"]);
    }
  );

  test("the egress guard still runs first: a metadata answer never reaches the proxy", async () => {
    const explicit = await connectProxy();
    const probe = createTlsProbe({
      resolve: async () => ["169.254.169.254"],
      proxyUrl: `http://127.0.0.1:${explicit.port}`,
    });
    const result = await probe({ hostname: "shop.example.com", port: 443 });
    expect(result).toMatchObject({
      kind: "unreachable",
      code: "EGRESS_REFUSED",
    });
    expect(explicit.seen).toEqual([]);
  });

  test.each([
    "not a url at all ::",
    "https://127.0.0.1:1",
    "socks5://127.0.0.1:1",
  ])(
    "an unusable proxyUrl (%s) is not checked, never a direct socket",
    async (proxyUrl) => {
      const server = await serveCertificate(fixtures.valid);
      servers.push(server);
      const probe = createTlsProbe({
        ca: fixtures.root,
        resolve,
        allowPrivateNetwork: true,
        proxyUrl,
      });
      const result = await probe({ hostname: "localhost", port: server.port });
      expect(result.kind).toBe("unavailable");
    }
  );
});
