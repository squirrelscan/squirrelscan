// #1259: a start URL whose TLS certificate is broken ends the run with an `unreachable` report in the
// format asked for, and that report says `security/tls-certificate` failed, with the cause, instead of
// only "Cannot reach". Local TLS servers with generated certificates; nothing leaves the machine.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTlsFixtures,
  serveCertificate,
  type LocalTlsServer,
  type TlsFixtures,
} from "../helpers/tls-fixtures";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-tls-start-"));
let fixtures: TlsFixtures;
const servers: LocalTlsServer[] = [];
let homes = 0;
let rootPath = "";

beforeAll(() => {
  fixtures = createTlsFixtures();
  // The fixture root, for the cases where the chain must verify so the name is the problem.
  rootPath = join(scratch, "root.pem");
  writeFileSync(rootPath, fixtures.root);
});
afterAll(async () => {
  for (const s of servers) await s.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function audit(
  port: number,
  format: string,
  trustRoot = false,
  extra: string[] = []
) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (
      v === undefined ||
      /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM|HTTPS?_PROXY|NO_PROXY)/i.test(
        k
      )
    )
      continue;
    env[k] = v;
  }
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      entry,
      "audit",
      `https://127.0.0.1:${port}/`,
      "--http",
      "-m",
      "1",
      "--format",
      format,
      ...extra,
    ],
    {
      env: {
        ...env,
        ...(trustRoot ? { NODE_EXTRA_CA_CERTS: rootPath } : {}),
        HOME: join(scratch, `home-${++homes}`),
        SQUIRREL_NO_UPDATE: "1",
        NO_TELEMETRY: "1",
        NO_COLOR: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [out, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, code };
}

interface Outcome {
  status: string;
  statusReasonCode: string;
  statusReason: string;
  issues?: Array<{
    ruleId: string;
    severity: string;
    checks: Array<{
      name: string;
      status: string;
      message: string;
      affectedPages: string[];
      affectedPagesCount: number;
      affectedPagesHasMore: boolean;
      legacyValue: string;
    }>;
    description: string;
    solution: string;
  }>;
}
const parse = (out: string): Outcome =>
  JSON.parse(out.slice(out.indexOf("{"))) as Outcome;

describe("a broken start-URL certificate fails security/tls-certificate instead of only aborting", () => {
  const cases: Array<
    [string, () => TlsFixtures[keyof TlsFixtures], RegExp, boolean?]
  > = [
    [
      "expired",
      () => fixtures.expired,
      /certificate has expired on \d{4}-\d{2}-\d{2}/,
    ],
    ["wrong host", () => fixtures.wrongName, /does not cover|hostname/i, true],
    ["self-signed", () => fixtures.selfSigned, /self.signed/i],
    [
      "weak key (RSA-1024) on an untrusted root",
      () => fixtures.weakKey,
      /RSA 1024 bits, below 2048/,
    ],
  ];
  for (const [name, pick, cause, trustRoot] of cases) {
    test(name, async () => {
      const server = await serveCertificate(pick() as never);
      servers.push(server);
      const { out, code } = await audit(server.port, "json", trustRoot);
      const outcome = parse(out);
      expect(code).toBe(5);
      expect(outcome.status).toBe("unreachable");
      expect(outcome.statusReasonCode).toBe("tls");
      const issue = outcome.issues?.find(
        (i) => i.ruleId === "security/tls-certificate"
      );
      expect(issue?.severity).toBe("error");
      const check = issue?.checks[0];
      expect(check?.status).toBe("fail");
      expect(check?.message).toMatch(cause);
      // The shape of an issue in a real report.
      expect(check?.affectedPages).toEqual([
        `https://127.0.0.1:${server.port}/`,
      ]);
      expect(check?.affectedPagesCount).toBe(1);
      expect(check?.affectedPagesHasMore).toBe(false);
      expect(check?.legacyValue).toBeTruthy();
      expect(issue?.description).toContain("TLS certificate");
      expect(issue?.solution).toBeTruthy();
    }, 60_000);
  }

  test("xml and console formats say the same", async () => {
    const server = await serveCertificate(fixtures.expired);
    servers.push(server);
    const xml = await audit(server.port, "xml");
    expect(xml.out).toContain(
      '<finding rule="security/tls-certificate" status="fail">'
    );
    const llm = await audit(server.port, "llm");
    expect(llm.out).toContain('rule="security/tls-certificate"');
  }, 60_000);

  test("a host that does not answer is unreachable as before, with no certificate finding", async () => {
    const server = await serveCertificate(fixtures.valid);
    const port = server.port;
    await server.close();
    const { out, code } = await audit(port, "json");
    const outcome = parse(out);
    expect(code).toBe(5);
    expect(outcome.status).toBe("unreachable");
    expect(outcome.statusReasonCode).not.toBe("tls");
    expect(outcome.issues).toBeUndefined();
  }, 60_000);

  test("--rule-exclude security/tls-certificate suppresses the finding, the failure stays", async () => {
    const server = await serveCertificate(fixtures.expired);
    servers.push(server);
    const { out, code } = await audit(server.port, "json", false, [
      "--rule-exclude",
      "security/tls-certificate",
    ]);
    const outcome = parse(out);
    expect(code).toBe(5);
    expect(outcome.status).toBe("unreachable");
    expect(outcome.statusReasonCode).toBe("tls");
    expect(outcome.issues).toBeUndefined();
  }, 60_000);

  test("a port that speaks plain HTTP is a TLS failure but not a certificate finding", async () => {
    const plain = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
          socket.end();
        },
        open() {},
        close() {},
      },
    });
    try {
      const { out, code } = await audit(plain.port, "json");
      const outcome = parse(out);
      expect(code).toBe(5);
      expect(outcome.status).toBe("unreachable");
      expect(outcome.issues).toBeUndefined();
    } finally {
      plain.stop(true);
    }
  }, 60_000);
});
