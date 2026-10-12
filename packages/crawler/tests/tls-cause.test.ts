// The crawl's TLS root failure names its cause from the same handshake (#712).
// Certificates are generated at test time and served from 127.0.0.1.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { auditFailureDetail } from "@squirrelscan/core-contracts/failure-reason";
import {
  createTlsFixtures,
  serveCertificate,
  type LocalTlsServer,
  type TlsFixtures,
} from "../../utils/tests/helpers/tls-fixtures";

import { withTlsCause } from "../src/tls-cause";

let fixtures: TlsFixtures;
const servers: LocalTlsServer[] = [];

beforeAll(() => {
  fixtures = createTlsFixtures();
}, 60_000);

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function failureFor(served: Parameters<typeof serveCertificate>[0]) {
  const server = await serveCertificate(served);
  servers.push(server);
  const url = `https://127.0.0.1:${server.port}/`;
  const detail = auditFailureDetail({
    code: "tls",
    host: "127.0.0.1",
    detail: "unable to verify the first certificate",
  });
  return withTlsCause(detail, url);
}

describe("withTlsCause", () => {
  test("an expired certificate names its end date", async () => {
    const detail = await failureFor(fixtures.expired);
    expect(detail.code).toBe("tls");
    expect(detail.detail).toMatch(/^certificate has expired on \d{4}-\d{2}-\d{2}$/);
  });

  test("a certificate for another name names the hostname it does not cover", async () => {
    const detail = await failureFor(fixtures.wrongName);
    expect(detail.detail).toBe(
      "hostname/IP does not match: the certificate does not cover 127.0.0.1",
    );
  });

  test("a self-signed certificate says so", async () => {
    const detail = await failureFor(fixtures.selfSigned);
    expect(detail.detail).toBe("self-signed certificate");
  });

  test("a server that omits its intermediate names the missing chain", async () => {
    const detail = await failureFor(fixtures.leafOnly);
    expect(detail.detail).toContain("did not send its intermediate certificate");
  });

  test("a non-TLS failure and a plain http URL keep their detail", async () => {
    const network = auditFailureDetail({ code: "connection", detail: "reset" });
    expect(await withTlsCause(network, "https://127.0.0.1:1/")).toBe(network);

    const tls = auditFailureDetail({ code: "tls", detail: "runtime text" });
    expect(await withTlsCause(tls, "http://127.0.0.1:1/")).toBe(tls);
  });

  test("a handshake that cannot be made keeps the fetch's detail", async () => {
    const tls = auditFailureDetail({ code: "tls", detail: "runtime text" });
    expect(await withTlsCause(tls, "https://127.0.0.1:1/")).toBe(tls);
  });
});
