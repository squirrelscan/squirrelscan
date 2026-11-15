// #1090: `squirrel support` through the real entry point, the way an agent
// runs it: no TTY, flags or a pipe, the result read from --json. A local stub
// stands in for the API, and every run gets a scratch HOME.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-support-cli-"));
const TID = "00000000-0000-0000-0000-000000000001";

interface Received {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  auth: string | null;
}
let received: Received[] = [];
let createStatus = 201;

const row = {
  id: TID,
  ref: "ABCDE",
  type: "bug",
  subject: "Crash on pricing",
  status: "in_progress",
  isUserRead: false,
  lastMessageAt: "2026-01-02T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
};

const api = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const text = await req.text();
    received.push({
      method: req.method,
      path: url.pathname + url.search,
      body: text ? JSON.parse(text) : null,
      auth: req.headers.get("authorization"),
    });
    if (req.method === "POST" && url.pathname === "/v1/support/tickets") {
      return createStatus === 201
        ? Response.json({ id: TID, ref: "ABCDE" }, { status: 201 })
        : Response.json(
            { error: "Too many tickets" },
            { status: createStatus }
          );
    }
    if (req.method === "GET" && url.pathname === "/v1/support/tickets") {
      return Response.json({ data: [row], total: 1 });
    }
    if (url.pathname === `/v1/support/tickets/${TID}/messages`) {
      return Response.json({ id: "m1" }, { status: 201 });
    }
    if (url.pathname === `/v1/support/tickets/${TID}/read`) {
      return Response.json({});
    }
    if (url.pathname === `/v1/support/tickets/${TID}`) {
      return Response.json({
        ticket: row,
        messages: [
          {
            id: "m1",
            role: "user",
            authorName: "Me",
            body: "It broke.",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "m2",
            role: "admin",
            authorName: "Nik",
            body: "Fixed soon.",
            createdAt: "2026-01-02T00:00:00Z",
          },
        ],
      });
    }
    return Response.json({}, { status: 404 });
  },
});

afterAll(() => {
  void api.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  received = [];
  createStatus = 201;
});

let homes = 0;

function cleanEnv(home: string, token: string | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
      continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    SQUIRREL_API_SERVER: api.url.origin,
    SQUIRREL_NO_UPDATE: "1",
    NO_TELEMETRY: "1",
    NO_COLOR: "1",
    ...(token ? { SQUIRREL_API_TOKEN: token } : {}),
  };
}

async function support(
  args: string[],
  {
    stdin,
    token = "sqcli_test",
  }: { stdin?: string; token?: string | null } = {}
) {
  const home = join(scratch, `home-${homes++}`);
  const proc = Bun.spawn([process.execPath, "run", entry, "support", ...args], {
    env: cleanEnv(home, token),
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

describe("squirrel support", () => {
  test("logged out: says so and exits 1, with no request", async () => {
    const r = await support(["list"], { token: null });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Not logged in. Run `squirrel auth login`");
    expect(received).toHaveLength(0);
  });

  test("logged out with --json: one JSON object on stdout, exit 1", async () => {
    const r = await support(["list", "--json"], { token: null });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({
      ok: false,
      code: "not_logged_in",
    });
  });

  test("new --json: sends type, subject, message, source cli and metadata", async () => {
    const r = await support([
      "new",
      "--type",
      "bug",
      "--subject",
      "Crash on pricing",
      "-m",
      "It exits with code 2.",
      "--run-id",
      "run_1",
      "--json",
    ]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      ok: true,
      ref: "ABCDE",
      id: TID,
      doctor_attached: false,
    });
    expect(received).toHaveLength(1);
    expect(received[0]!.auth).toBe("Bearer sqcli_test");
    expect(received[0]!.body).toMatchObject({
      type: "bug",
      subject: "Crash on pricing",
      message: "It exits with code 2.",
      source: "cli",
      metadata: { source: "cli", runId: "run_1" },
    });
    expect(received[0]!.body!.metadata).not.toHaveProperty("doctor");
  });

  test("new reads the message from stdin and prints the view hint", async () => {
    const r = await support(
      ["new", "--type", "other", "--subject", "A question"],
      { stdin: "Piped in, long enough.\n" }
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("ABCDE");
    expect(r.out).toContain("squirrel support view ABCDE");
    expect(received[0]!.body!.message).toBe("Piped in, long enough.");
  });

  test("new --attach-doctor puts diagnostics in metadata, not the body", async () => {
    const r = await support([
      "new",
      "--type",
      "bug",
      "--subject",
      "With doctor",
      "-m",
      "Please look at this.",
      "--attach-doctor",
      "--json",
    ]);
    expect(r.code).toBe(0);
    const body = received[0]!.body!;
    expect(String((body.metadata as Record<string, unknown>).doctor)).toContain(
      "Passed:"
    );
    expect(body.message).toBe("Please look at this.");
  });

  test("new with a bad type or short message fails before any request", async () => {
    const badType = await support([
      "new",
      "--type",
      "nope",
      "--subject",
      "abc",
      "-m",
      "long enough text",
      "--json",
    ]);
    expect(badType.code).toBe(1);
    expect(JSON.parse(badType.out)).toMatchObject({
      ok: false,
      code: "invalid_type",
    });
    const noSubject = await support([
      "new",
      "--type",
      "bug",
      "-m",
      "long enough text",
      "--json",
    ]);
    expect(JSON.parse(noSubject.out)).toMatchObject({
      ok: false,
      code: "subject_required",
    });
    expect(received).toHaveLength(0);
  });

  test("new surfaces a rate limit and exits 1", async () => {
    createStatus = 429;
    const r = await support([
      "new",
      "--type",
      "bug",
      "--subject",
      "abc",
      "-m",
      "long enough text",
      "--json",
    ]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({
      ok: false,
      code: "rate_limited",
      status: 429,
    });
  });

  test("list --json carries waitingOn; the table says who is up", async () => {
    const json = await support(["list", "--status", "in_progress", "--json"]);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out);
    expect(parsed.tickets[0]).toMatchObject({ ref: "ABCDE", waitingOn: "you" });
    expect(received[0]!.path).toBe(
      "/v1/support/tickets?status=in_progress&limit=20"
    );

    const table = await support(["list"]);
    expect(table.out).toContain("ABCDE");
    expect(table.out).toContain("waiting on you");
  });

  test("list rejects an unknown status", async () => {
    const r = await support(["list", "--status", "weird", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).code).toBe("invalid_status");
  });

  test("view resolves a ref, prints the thread, then marks it read", async () => {
    const r = await support(["view", "abcde"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("It broke.");
    expect(r.out).toContain("Fixed soon.");
    expect(received.at(-1)).toMatchObject({
      method: "POST",
      path: `/v1/support/tickets/${TID}/read`,
    });
  });

  test("view --markdown and --json", async () => {
    const md = await support(["view", "ABCDE", "--markdown"]);
    expect(md.out).toContain("# [ABCDE] Crash on pricing");
    const json = await support(["view", "ABCDE", "--json"]);
    expect(JSON.parse(json.out)).toMatchObject({ ok: true, waitingOn: "you" });
  });

  test("view of an unknown ref exits 1", async () => {
    const r = await support(["view", "ZZZZZ", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: "not_found" });
  });

  test("reply posts the message; an empty reply is refused", async () => {
    const r = await support(["reply", "ABCDE", "-m", "More detail.", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, id: "m1" });
    expect(received.at(-1)).toMatchObject({
      method: "POST",
      path: `/v1/support/tickets/${TID}/messages`,
      body: { message: "More detail." },
    });

    received = [];
    const empty = await support(["reply", "ABCDE", "--json"], {
      stdin: "  \n",
    });
    expect(empty.code).toBe(1);
    expect(received).toHaveLength(0);
  });
});
