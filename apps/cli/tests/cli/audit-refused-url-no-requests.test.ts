// `squirrel audit` on a URL it cannot run on is refused before ANY request: no
// balance read, no run registered, no trace or telemetry upload. The real CLI
// runs in a subprocess, signed in, with telemetry on, and the cloud API and the
// HTTP(S) proxy both pointed at one counting server, so a request of any kind
// to any path shows up.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-refused-url-"));

const hits: string[] = [];
const counter = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    hits.push(`${req.method} ${req.url}`);
    return Response.json({});
  },
});

afterAll(() => {
  void counter.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  hits.length = 0;
});

// The CLI's own startup install ping (`POST /v1/installs`) runs before any
// command is parsed and carries no URL; it is the one request a refused audit
// may still make. Anything else (credits, register, traces, telemetry) fails.
const startupOnly = () => hits.filter((h) => !h.includes("/v1/installs"));

let homes = 0;

function env(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (
      v === undefined ||
      /^(SQUIRREL|NO_TELEMETRY|FORCE_COLOR|COLORTERM)/.test(k)
    )
      continue;
    base[k] = v;
  }
  return {
    ...base,
    HOME: join(scratch, `home-${++homes}`),
    NO_COLOR: "1",
    SQUIRREL_NO_UPDATE: "1",
    SQUIRREL_API_SERVER: counter.url.origin,
    SQUIRREL_API_TOKEN: "sqcli_test_token",
    HTTP_PROXY: counter.url.origin,
    HTTPS_PROXY: counter.url.origin,
  };
}

async function audit(url: string) {
  const proc = Bun.spawn([process.execPath, "run", entry, "audit", url], {
    env: env(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, err };
}

const REFUSED = [
  "ftp://example.com/",
  "file:///etc/passwd",
  "javascript:alert(1)",
  "mailto:a@b.com",
  "javascript:alert(1)@x.com",
  "https://",
  "x://",
];

describe("squirrel audit refuses an unauditable URL before any request", () => {
  test.each(REFUSED)("%p", async (url) => {
    const { code, err } = await audit(url);
    expect(code).toBe(1);
    expect(err).toContain("Error:");
    expect(startupOnly()).toEqual([]);
  });

  test("an error never echoes credentials from the input", async () => {
    const { err } = await audit(`ftp://${["u", "pw"].join(":")}@example.com/`);
    expect(err).not.toContain("pw");
    expect(startupOnly()).toEqual([]);
  });
});
