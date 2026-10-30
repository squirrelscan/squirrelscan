// `squirrel audit` against a start URL that cannot be reached (#1269), end to
// end: the real CLI in a subprocess. The report says `unreachable` with the
// failure class and the probe's own text, the exit code is its own (5), and a
// blocked report always exits 3, with or without an identified WAF vendor.

import type { AuditFailureReasonCode } from "@squirrelscan/core-contracts/failure-reason";

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  unreachableOutcome,
  renderUnreachableOutcome,
} from "@/cli/unreachable";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-unreachable-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let homes = 0;
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
      continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: join(scratch, `home-${++homes}`),
    SQUIRREL_NO_UPDATE: "1",
    NO_TELEMETRY: "1",
    NO_COLOR: "1",
  };
}

async function audit(url: string, ...args: string[]) {
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      entry,
      "audit",
      url,
      "--offline",
      "-m",
      "3",
      ...args,
    ],
    { env: cleanEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

type Outcome = {
  status: string;
  statusReasonCode: string;
  statusReason: string;
  url: string;
};

describe("unreachableOutcome classes", () => {
  const cases: Array<[string, AuditFailureReasonCode]> = [
    ["DNS lookup failed - domain may not exist", "dns"],
    ["Host not found", "dns"],
    ["Connection refused - server may be down", "connection"],
    [
      "The socket connection was closed unexpectedly (ECONNRESET)",
      "connection",
    ],
    ["SSL/TLS error - certificate issue", "tls"],
    ["unknown certificate verification error", "tls"],
    ["error:0A00010B:SSL routines::wrong version number", "tls"],
    ["Request timed out after 10000ms (ETIMEDOUT)", "timeout"],
  ];
  for (const [reason, code] of cases) {
    test(`${reason} is ${code}`, () => {
      const outcome = unreachableOutcome(
        "https://example.com/?token=secret",
        reason
      );
      expect(outcome.status).toBe("unreachable");
      expect(outcome.statusReasonCode).toBe(code);
      expect(outcome.statusReason).toBe(reason);
      // Credentials and query never reach the report.
      expect(JSON.stringify(outcome)).not.toContain("secret");
    });
  }

  test("every format names the status and the reason", () => {
    const outcome = unreachableOutcome(
      "https://example.com/",
      "Host not found"
    );
    expect(JSON.parse(renderUnreachableOutcome(outcome, "json"))).toMatchObject(
      { status: "unreachable" }
    );
    expect(renderUnreachableOutcome(outcome, "xml")).toContain(
      'status="unreachable" reason-code="dns"'
    );
    expect(renderUnreachableOutcome(outcome, "text")).toContain(
      "Host not found"
    );
  });
});

describe("squirrel audit -f json on a start URL it cannot reach", () => {
  test("connection refused: a report on stdout, exit 5", async () => {
    // A port that was open a moment ago and is now closed.
    const probe = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => probe.once("listening", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise((resolve) => probe.close(resolve));

    const r = await audit(`http://127.0.0.1:${port}/`, "-f", "json");
    expect(r.code).toBe(5);
    const outcome = JSON.parse(r.out) as Outcome;
    expect(outcome.status).toBe("unreachable");
    expect(outcome.statusReasonCode).toBe("connection");
    expect(outcome.statusReason.length).toBeGreaterThan(0);
    expect(r.err).toContain("Cannot reach");
  }, 60_000);

  test("a reset connection: written to -o, exit 5", async () => {
    const server = createServer((socket) => socket.destroy()).listen(
      0,
      "127.0.0.1"
    );
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const file = join(scratch, "reset.json");
    try {
      const r = await audit(
        `http://127.0.0.1:${port}/`,
        "-f",
        "json",
        "-o",
        file
      );
      expect(r.code).toBe(5);
      const outcome = JSON.parse(readFileSync(file, "utf8")) as Outcome;
      expect(outcome.status).toBe("unreachable");
      expect(outcome.statusReasonCode).toBe("connection");
    } finally {
      server.close();
    }
  }, 60_000);

  test("TLS to a plain-http port: tls", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("plain"),
    });
    try {
      const r = await audit(`https://127.0.0.1:${server.port}/`, "-f", "json");
      expect(r.code).toBe(5);
      const outcome = JSON.parse(r.out) as Outcome;
      expect(outcome.status).toBe("unreachable");
      expect(outcome.statusReasonCode).toBe("tls");
    } finally {
      void server.stop(true);
    }
  }, 60_000);

  test("a server that accepts and never answers: a timed out connection", async () => {
    const server = createServer(() => {}).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const r = await audit(`http://127.0.0.1:${port}/`, "-f", "json");
      expect(r.code).toBe(5);
      const outcome = JSON.parse(r.out) as Outcome;
      expect(outcome.status).toBe("unreachable");
      // The probe's own wording is "Connection timed out", which the shared
      // failure vocabulary files under `connection` (its parity corpus pins it).
      expect(outcome.statusReason).toMatch(/timed out/i);
      expect(outcome.statusReasonCode).toBe("connection");
    } finally {
      server.close();
    }
  }, 120_000);

  test("a name that does not exist: dns", async () => {
    const r = await audit(
      "http://squirrel-no-such-host.invalid/",
      "-f",
      "json"
    );
    expect(r.code).toBe(5);
    const outcome = JSON.parse(r.out) as Outcome;
    expect(outcome.status).toBe("unreachable");
    expect(outcome.statusReasonCode).toBe("dns");
  }, 60_000);
});

describe("a blocked report exits 3", () => {
  test("a bare 403 with no WAF vendor still exits 3", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response("Request blocked", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
    });
    try {
      const r = await audit(`http://127.0.0.1:${server.port}/`, "-f", "json");
      const report = JSON.parse(r.out) as { status: string };
      expect(report.status).toBe("blocked");
      expect(r.code).toBe(3);
    } finally {
      void server.stop(true);
    }
  }, 60_000);
});

// #1275: the level snapshot on an --offline run says what ran.
describe("an --offline audit reports the settings that ran", () => {
  test("-C surface --offline: no cloud checks, rendering or external links", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(
          `<!doctype html><html lang="en"><head><title>Offline level fixture</title></head><body><h1>Hi</h1></body></html>`,
          { headers: { "content-type": "text/html" } }
        ),
    });
    try {
      const r = await audit(
        `http://127.0.0.1:${server.port}/`,
        "-C",
        "surface",
        "--passive",
        "-f",
        "json"
      );
      const report = JSON.parse(r.out) as {
        meta: {
          auditLevel: {
            basedOn: string;
            offline?: boolean;
            settings: Record<string, unknown>;
          };
        };
      };
      expect(report.meta.auditLevel.basedOn).toBe("surface");
      expect(report.meta.auditLevel.offline).toBe(true);
      expect(report.meta.auditLevel.settings).toMatchObject({
        crawlStrategy: "sampled",
        cloudChecks: false,
        render: "off",
        externalLinks: false,
        probe: "passive",
      });
    } finally {
      void server.stop(true);
    }
  }, 60_000);
});
