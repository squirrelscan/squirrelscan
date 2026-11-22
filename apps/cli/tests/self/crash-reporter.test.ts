// repo#705 phase 3: CLI and MCP crash reporting, proxied through our API.

import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { wrapToolHandler } from "@/mcp/server";
import {
  buildCrashReport,
  CRASH_STACK_MAX_BYTES,
  commandFromArgs,
  formatCrashMessage,
  newCrashReference,
  scrubStack,
} from "@/self/crash-reporter";
import { updateSettings } from "@/self/settings";
import { sendCrashReport } from "@/self/telemetry";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

// Bun reads os.homedir() once: settings writes go to a scratch store, never ~/.squirrel.
const scratch = isolateSquirrelHome("squirrel-crash");

const SAMPLE_STACK = [
  "TypeError: fetch https://secret.example/private?token=abc failed for a@b.co",
  "  second message line /Users/alice/site/page.html",
  "    at runAudit (/$bunfs/root/squirrel-abc123.js:1200:15)",
  "    at async crawl (/Users/alice/dev/squirrel/src/crawl.ts:42:7)",
  "    at load (https://cdn.example/x.js:1:2)",
  "    at notify (mailto:bob@example.org)",
  "    at C:\\Users\\alice\\squirrel\\chunk.js:9:1",
  "    at <anonymous>",
].join("\n");

describe("scrubStack", () => {
  test("keeps code locations and drops the message, URLs, emails and directories", () => {
    const out = scrubStack(SAMPLE_STACK, "/Users/alice") ?? "";
    expect(out.split("\n")).toEqual([
      "at runAudit (squirrel-abc123.js:1200:15)",
      "at async crawl (crawl.ts:42:7)",
      "at load (<url>)",
      "at notify (<email>)",
      "at chunk.js:9:1",
      "at <anonymous>",
    ]);
    for (const leak of [
      "secret.example",
      "token",
      "a@b.co",
      "alice",
      "Users",
      "page.html",
      "cdn.example",
      "bob@",
    ]) {
      expect(out).not.toContain(leak);
    }
  });

  test("caps the stack below the API's anonymous body limit", () => {
    const frames = Array.from(
      { length: 500 },
      (_, i) => `    at fn${i}${"x".repeat(400)} (file.js:${i}:1)`
    );
    const out = scrubStack(`Error: boom\n${frames.join("\n")}`) ?? "";
    expect(out.length).toBeLessThanOrEqual(CRASH_STACK_MAX_BYTES);
    expect(out.split("\n").length).toBeLessThanOrEqual(50);
  });

  test("a stack with no frames reports none", () => {
    expect(scrubStack("Error: only a message")).toBeUndefined();
    expect(scrubStack(undefined)).toBeUndefined();
  });
});

describe("crash report shape", () => {
  test("the reference is cli_ plus 12 hex characters", () => {
    expect(newCrashReference()).toMatch(/^cli_[0-9a-f]{12}$/);
  });

  test("the command is the subcommand name only, never a URL or a path", () => {
    expect(commandFromArgs(["audit", "https://example.com", "-v"])).toBe(
      "audit"
    );
    expect(commandFromArgs(["--offline", "crawl"])).toBe("crawl");
    expect(commandFromArgs(["https://example.com"])).toBeUndefined();
    expect(commandFromArgs(["./site"])).toBeUndefined();
    expect(commandFromArgs([])).toBeUndefined();
  });

  test("an Error reports its class, never its message", () => {
    const error = new TypeError("https://secret.example/private");
    const report = buildCrashReport(error, {
      reference: "cli_000000000000",
      source: "uncaught_exception",
      args: ["audit", "https://secret.example"],
    });
    expect(report.error_type).toBe("TypeError");
    expect(report.command).toBe("audit");
    expect(report.platform).toBe(`${process.platform}-${process.arch}`);
    expect(JSON.stringify(report)).not.toContain("secret.example");
  });

  test("a rejection with a non-Error value reports its type, never its content", () => {
    const report = buildCrashReport("https://secret.example", {
      reference: "cli_000000000000",
      source: "unhandled_rejection",
      args: [],
    });
    expect(report.error_type).toBe("NonError:string");
    expect(report.stack).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("secret.example");
  });

  test("the friendly message carries the reference and points at the issue tracker", () => {
    const text = formatCrashMessage(new Error("boom"), "cli_0123456789ab");
    expect(text).toContain("squirrel hit an unexpected error: boom");
    expect(text).toContain("Reference: cli_0123456789ab");
    expect(text).toContain("github.com/squirrelscan/squirrelscan/issues");
  });
});

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalCwd = process.cwd();

describe("sendCrashReport", () => {
  let project: string;
  let sent: Array<{ url: string; body: Record<string, unknown> }>;

  beforeEach(() => {
    scratch.use(`home-${Date.now()}-${Math.random()}`);
    // A project .squirrel/settings.json above the repo must not opt this run out.
    project = join(scratch.dir, "project");
    mkdirSync(project, { recursive: true });
    process.chdir(project);
    process.env = {
      ...originalEnv,
      SQUIRREL_API_SERVER: "http://localhost:9999",
    };
    delete process.env.NO_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    sent = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      sent.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    process.chdir(originalCwd);
  });

  const report = () =>
    buildCrashReport(new RangeError("secret"), {
      reference: "cli_abcdefabcdef",
      source: "uncaught_exception",
      args: ["audit"],
    });

  test("posts an error event with the reference and stack once the v3 notice was seen", async () => {
    updateSettings({
      telemetry_notice_shown: true,
      telemetry_notice_version: 3,
    });
    await sendCrashReport(report());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("http://localhost:9999/v1/traces");
    const body = sent[0]!.body;
    expect(body.event).toBe("error");
    expect(body.error_type).toBe("RangeError");
    expect(body.reference).toBe("cli_abcdefabcdef");
    expect(body.command).toBe("audit");
    expect(body.source).toBe("uncaught_exception");
    expect(String(body.stack)).toContain("at ");
    expect(body.install_id).toMatch(/[0-9a-f-]{36}/i);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThan(
      16 * 1024
    );
  });

  test("before the v3 notice, the crash is reported without its stack", async () => {
    updateSettings({
      telemetry_notice_shown: true,
      telemetry_notice_version: 2,
    });
    await sendCrashReport(report());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.reference).toBe("cli_abcdefabcdef");
    expect(sent[0]!.body.stack).toBeUndefined();
  });

  test("every opt-out sends nothing", async () => {
    updateSettings({ telemetry_notice_version: 3 });
    process.env.NO_TELEMETRY = "";
    await sendCrashReport(report());
    delete process.env.NO_TELEMETRY;
    process.env.DO_NOT_TRACK = "1";
    await sendCrashReport(report());
    delete process.env.DO_NOT_TRACK;
    updateSettings({ telemetry: false });
    await sendCrashReport(report());
    expect(sent).toHaveLength(0);
  });

  test("an MCP tool that throws returns a tool error with a reference and reports it", async () => {
    updateSettings({
      telemetry_notice_shown: true,
      telemetry_notice_version: 3,
    });
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      const wrapped = wrapToolHandler("boom_tool", () => {
        throw new Error("kaboom");
      });
      const result = (await wrapped({})) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBe(true);
      const text = result.content[0]!.text;
      expect(text).toContain(
        "The boom_tool tool hit an unexpected error: kaboom"
      );
      const reference = /Reference: (cli_[0-9a-f]{12})/.exec(text)?.[1];
      expect(reference).toBeDefined();
      expect(String(errors[0])).toContain(reference!);
      for (let i = 0; i < 50 && sent.length === 0; i++) await Bun.sleep(10);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body.reference).toBe(reference);
      expect(sent[0]!.body.source).toBe("mcp_tool");
      expect(sent[0]!.body.command).toBe("mcp");
    } finally {
      console.error = origError;
    }
  });

  test("an MCP protocol error passes through unreported", async () => {
    const wrapped = wrapToolHandler("proto_tool", () => {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "bad");
    });
    await expect(Promise.resolve(wrapped({}))).rejects.toBeInstanceOf(
      ProtocolError
    );
    await Bun.sleep(30);
    expect(sent).toHaveLength(0);
  });
});

// End to end: a real process with the handlers installed, reporting to a
// local stand-in for the API.
describe("process crash handlers", () => {
  const entry = join(import.meta.dir, "../fixtures/crash/crash-entry.ts");
  const home = mkdtempSync(join(tmpdir(), "squirrel-crash-e2e-"));
  const received: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received.push((await req.json()) as Record<string, unknown>);
      return Response.json({ success: true });
    },
  });
  afterAll(() => {
    void server.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  async function crash(
    mode: string,
    extra: Record<string, string> = {},
    args: string[] = []
  ) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !/^(SQUIRREL|NO_TELEMETRY|DO_NOT_TRACK)/.test(k))
        env[k] = v;
    }
    const proc = Bun.spawn([process.execPath, "run", entry, mode, ...args], {
      cwd: home,
      env: {
        ...env,
        HOME: home,
        SQUIRREL_API_SERVER: `http://localhost:${server.port}`,
        ...extra,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, out, err };
  }

  test("an uncaught exception prints a reference, exits 1 and reports it", async () => {
    received.length = 0;
    const { code, out, err } = await crash("throw");
    expect(code).toBe(1);
    expect(out).toBe("");
    const reference = /Reference: (cli_[0-9a-f]{12})/.exec(err)?.[1];
    expect(reference).toBeDefined();
    expect(received).toHaveLength(1);
    expect(received[0]!.reference).toBe(reference);
    expect(received[0]!.error_type).toBe("RangeError");
    expect(received[0]!.source).toBe("uncaught_exception");
    expect(JSON.stringify(received[0])).not.toContain("secret.example");
  }, 30_000);

  test("an unhandled rejection prints a reference, exits 1 and reports it", async () => {
    received.length = 0;
    const { code, err } = await crash("reject");
    expect(code).toBe(1);
    const reference = /Reference: (cli_[0-9a-f]{12})/.exec(err)?.[1];
    expect(reference).toBeDefined();
    expect(received).toHaveLength(1);
    expect(received[0]!.reference).toBe(reference);
    expect(received[0]!.error_type).toBe("TypeError");
    expect(received[0]!.source).toBe("unhandled_rejection");
  }, 30_000);

  test("a command that throws prints a reference, exits 1 and reports it", async () => {
    received.length = 0;
    const { code, err } = await crash("command");
    expect(code).toBe(1);
    const reference = /Reference: (cli_[0-9a-f]{12})/.exec(err)?.[1];
    expect(reference).toBeDefined();
    expect(received).toHaveLength(1);
    expect(received[0]!.reference).toBe(reference);
    expect(received[0]!.error_type).toBe("SyntaxError");
    expect(received[0]!.source).toBe("command");
    expect(received[0]!.command).toBe("command");
  }, 30_000);

  test("with --offline it prints the reference and exits 1, but sends nothing", async () => {
    received.length = 0;
    const { code, err } = await crash("throw", {}, ["--offline"]);
    expect(code).toBe(1);
    expect(err).toMatch(/Reference: cli_[0-9a-f]{12}/);
    expect(received).toHaveLength(0);
  }, 30_000);

  test("with telemetry off it still prints the reference and exits 1, but sends nothing", async () => {
    received.length = 0;
    const { code, err } = await crash("throw", { NO_TELEMETRY: "1" });
    expect(code).toBe(1);
    expect(err).toMatch(/Reference: cli_[0-9a-f]{12}/);
    expect(received).toHaveLength(0);
  }, 30_000);
});

describe("no third-party DSN in the binary", () => {
  test("the CLI has no Sentry SDK dependency and no DSN in its source", async () => {
    const pkg = await Bun.file(
      join(import.meta.dir, "../../package.json")
    ).json();
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => d.startsWith("@sentry/"))).toEqual([]);
    const src = join(import.meta.dir, "../../src");
    const glob = new Bun.Glob("**/*.ts");
    const hits: string[] = [];
    for await (const file of glob.scan(src)) {
      const text = await Bun.file(join(src, file)).text();
      if (/@sentry\/|ingest(\.[a-z]+)?\.sentry\.io|SENTRY_DSN/.test(text))
        hits.push(file);
    }
    expect(hits).toEqual([]);
  });

  test("the crash reporter stays on the light path: node built-ins only, telemetry loaded lazily", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "../../src/self/crash-reporter.ts")
    ).text();
    const staticImports = source.split("\n").filter((l) => /^import\b/.test(l));
    for (const line of staticImports) expect(line).toMatch(/from "node:/);
    expect(source).toContain('import("./telemetry")');
  });
});
