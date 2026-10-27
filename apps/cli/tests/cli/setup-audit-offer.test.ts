// `squirrel setup` ends in a first-audit offer (#1195). The URL parser is the
// pure part; the non-interactive path must never block or run an audit.
// os.homedir is mocked (Bun ignores a later process.env.HOME, see
// uninstall.test.ts).

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as realOs from "node:os";
import { join } from "node:path";

const realHomedir = realOs.homedir;
function osModule(homedirFn: () => string): Record<string, unknown> {
  const patched = { ...realOs, homedir: homedirFn };
  return { ...patched, default: patched };
}

let home = "";
mock.module("node:os", () => osModule(() => home));
afterAll(() => {
  mock.module("node:os", () => osModule(realHomedir));
});

const { offerFirstAudit, parseAuditTarget, runSetup } =
  await import("@/cli/commands/setup");
const { createTheme } = await import("@/cli/theme");

describe("parseAuditTarget", () => {
  test("accepts a URL or a bare host", () => {
    expect(parseAuditTarget("https://example.com")).toBe(
      "https://example.com/"
    );
    expect(parseAuditTarget("  example.com ")).toBe("https://example.com/");
    expect(parseAuditTarget("http://example.com/a?b=1")).toBe(
      "http://example.com/a?b=1"
    );
    // Local dev servers: bare localhost and IPs default to http.
    expect(parseAuditTarget("localhost:3000")).toBe("http://localhost:3000/");
    expect(parseAuditTarget("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
    expect(parseAuditTarget("https://localhost:3000")).toBe(
      "https://localhost:3000/"
    );
  });

  test("rejects blanks, words, other schemes and spaces", () => {
    for (const bad of [
      "",
      "   ",
      "yes",
      "n",
      "ftp://example.com",
      "javascript:alert(1)",
      "my site.com",
      "https://",
    ]) {
      expect(parseAuditTarget(bad)).toBeNull();
    }
  });
});

describe("setup first-audit offer", () => {
  const originalEnv = { ...process.env };
  const originalLog = console.log;
  const originalFetch = globalThis.fetch;
  let lines: string[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(realOs.tmpdir(), "squirrel-setup-offer-"));
    process.env = { ...originalEnv, HOME: home, NO_TELEMETRY: "1" };
    lines = [];
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    // Any network call here would mean an audit ran: fail loudly.
    globalThis.fetch = (async () => {
      throw new Error("unexpected network call");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    rmSync(home, { recursive: true, force: true });
  });

  test("--yes prints the audit command and returns without asking", async () => {
    await runSetup({ yes: true, dryRun: false });
    expect(lines.join("\n")).toContain("squirrel audit https://your-site.com");
  });

  test("--dry-run prints the audit command and returns without asking", async () => {
    await runSetup({ yes: false, dryRun: true });
    expect(lines.join("\n")).toContain("squirrel audit https://your-site.com");
  });
});

describe("offerFirstAudit", () => {
  const originalLog = console.log;
  const t = createTheme(process.stdout);
  let events: string[] = [];
  const track = (event: string) => void events.push(event);

  beforeEach(() => {
    events = [];
    console.log = () => {};
  });
  afterEach(() => {
    console.log = originalLog;
  });

  function asker(answers: string[], interactive = true) {
    const queue = [...answers];
    return {
      interactive,
      confirm: async () => true,
      line: async () => queue.shift() ?? "",
    };
  }

  test("a typed site is accepted and returned", async () => {
    const target = await offerFirstAudit(
      t,
      asker(["example.com"]),
      false,
      track
    );
    expect(target).toBe("https://example.com/");
    expect(events).toEqual(["setup_audit_accepted"]);
  });

  test("enter skips and reports declined", async () => {
    expect(await offerFirstAudit(t, asker([""]), false, track)).toBeNull();
    expect(events).toEqual(["setup_audit_declined"]);
  });

  test("a malformed answer gets one retry, then skips", async () => {
    expect(
      await offerFirstAudit(t, asker(["nope", "still nope"]), false, track)
    ).toBeNull();
    expect(events).toEqual(["setup_audit_declined"]);
  });

  test("a malformed answer then a good one is accepted", async () => {
    expect(
      await offerFirstAudit(t, asker(["nope", "example.com"]), false, track)
    ).toBe("https://example.com/");
    expect(events).toEqual(["setup_audit_accepted"]);
  });

  test("non-interactive and dry-run never ask and emit nothing", async () => {
    expect(
      await offerFirstAudit(t, asker(["example.com"], false), false, track)
    ).toBeNull();
    expect(
      await offerFirstAudit(t, asker(["example.com"]), true, track)
    ).toBeNull();
    expect(events).toEqual([]);
  });
});
