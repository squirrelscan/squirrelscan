// #1090: the shared support-ticket client. Pure helpers plus ref resolution
// against a stubbed api (the `api` seam), so nothing touches the network.

import { describe, expect, test } from "bun:test";

import type { ApiResult } from "@/lib/api-client";

import {
  BODY_MAX_LENGTH,
  DOCTOR_MAX_LENGTH,
  SUBJECT_MAX_LENGTH,
  buildTicketMetadata,
  clampText,
  describeSupportFailure,
  getSupportThread,
  isOrgApiKey,
  type NewTicketInput,
  type SupportErrorCode,
  prepareNewTicket,
  renderThreadMarkdown,
  replyToSupportTicket,
  resolveTicketId,
  ticketWaitingOn,
  validateReply,
  viewSupportTicket,
} from "@/lib/support";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

interface Call {
  path: string;
  method: string;
  body?: unknown;
}

/** An api whose answers come from `routes`, keyed by "METHOD path". */
function fakeApi(routes: Record<string, unknown>): {
  api: {
    request: <T>(
      path: string,
      init?: Record<string, unknown>
    ) => Promise<ApiResult<T>>;
  };
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    api: {
      request: (async (path: string, init: Record<string, unknown> = {}) => {
        const method = String(init.method ?? "GET");
        calls.push({ path, method, body: init.body });
        const key = `${method} ${path}`;
        if (!(key in routes)) return { ok: false, status: 404, data: null };
        return { ok: true, status: 200, data: routes[key] };
      }) as never,
    },
  };
}

const ticket = (n: number, ref: string) => ({
  id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
  ref,
  type: "bug",
  subject: `Ticket ${ref}`,
  status: "new",
  isUserRead: true,
  lastMessageAt: null,
  createdAt: "2026-01-01T00:00:00Z",
});

describe("ticketWaitingOn", () => {
  test("staff spoke last on an open ticket: waiting on you", () => {
    expect(
      ticketWaitingOn({ status: "in_progress", isUserRead: true }, [
        { role: "user" },
        { role: "admin" },
      ])
    ).toBe("you");
  });
  test("the user spoke last: waiting on support", () => {
    expect(
      ticketWaitingOn({ status: "new", isUserRead: true }, [
        { role: "admin" },
        { role: "user" },
      ])
    ).toBe("support");
  });
  test("an unseen reply is waiting on you, even with no messages loaded", () => {
    expect(ticketWaitingOn({ status: "in_progress", isUserRead: false })).toBe(
      "you"
    );
    expect(ticketWaitingOn({ status: "closed", isUserRead: false })).toBe(
      "you"
    );
  });
  test("closed and seen is closed", () => {
    expect(
      ticketWaitingOn({ status: "closed", isUserRead: true }, [
        { role: "admin" },
      ])
    ).toBe("closed");
  });
  test("a list row with nothing unseen is waiting on support", () => {
    expect(ticketWaitingOn({ status: "new", isUserRead: true })).toBe(
      "support"
    );
  });
});

describe("clampText", () => {
  test("trims and leaves short text alone", () => {
    expect(clampText("  hello  ", 10)).toEqual({
      text: "hello",
      truncated: false,
    });
  });
  test("cuts long text and reports it", () => {
    const r = clampText("a".repeat(BODY_MAX_LENGTH + 50), BODY_MAX_LENGTH);
    expect(r.text).toHaveLength(BODY_MAX_LENGTH);
    expect(r.truncated).toBe(true);
  });
  test("never splits a surrogate pair", () => {
    const r = clampText("a".repeat(9) + "😀", 10);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe("a".repeat(9));
  });
});

describe("buildTicketMetadata", () => {
  test("carries source, version, platform and the given ids", () => {
    const m = buildTicketMetadata({
      source: "mcp",
      runId: " run_1 ",
      ruleId: "core/title",
    });
    expect(m.source).toBe("mcp");
    expect(m.platform).toBe(`${process.platform}-${process.arch}`);
    expect(m.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(m.runId).toBe("run_1");
    expect(m.ruleId).toBe("core/title");
    expect("reportId" in m).toBe(false);
    expect("doctor" in m).toBe(false);
  });
  test("caps the doctor text", () => {
    const m = buildTicketMetadata({
      source: "cli",
      doctor: "x".repeat(DOCTOR_MAX_LENGTH * 2),
    });
    expect(m.doctor).toHaveLength(DOCTOR_MAX_LENGTH);
  });
});

describe("prepareNewTicket", () => {
  const base = {
    type: "bug",
    subject: "Audit crashed",
    body: "It exited with code 2 on /pricing.",
    source: "cli" as const,
  };
  test("builds the payload with structured metadata, not prose", () => {
    const r = prepareNewTicket({ ...base, doctor: "[OK] fine" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).toMatchObject({
      type: "bug",
      subject: "Audit crashed",
      message: "It exited with code 2 on /pricing.",
      source: "cli",
      metadata: { source: "cli", doctor: "[OK] fine" },
    });
    expect(r.payload.message).not.toContain("[OK]");
    expect(r.truncated).toEqual({ subject: false, body: false });
  });
  test("clamps instead of rejecting, and says so", () => {
    const r = prepareNewTicket({
      ...base,
      subject: "s".repeat(SUBJECT_MAX_LENGTH + 5),
      body: "b".repeat(BODY_MAX_LENGTH + 5),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.subject).toHaveLength(SUBJECT_MAX_LENGTH);
    expect(r.payload.message).toHaveLength(BODY_MAX_LENGTH);
    expect(r.truncated).toEqual({ subject: true, body: true });
  });
  test.each<[Partial<NewTicketInput>, SupportErrorCode]>([
    [{ type: "nope" }, "invalid_type"],
    [{ subject: "  " }, "subject_required"],
    [{ subject: "ab" }, "subject_too_short"],
    [{ body: "" }, "message_required"],
    [{ body: "short" }, "message_too_short"],
  ])("rejects %o as %s", (patch, code) => {
    const r = prepareNewTicket({ ...base, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });
});

describe("resolveTicketId", () => {
  test("an id is used as is, with no request", async () => {
    const { api, calls } = fakeApi({});
    const r = await resolveTicketId(UUID, api);
    expect(r.data?.id).toBe(UUID);
    expect(calls).toHaveLength(0);
  });

  test("a ref is found case-insensitively across pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      ticket(i, `A${String(i).padStart(4, "0")}`)
    );
    const page2 = [ticket(500, "XK4Q2")];
    const { api, calls } = fakeApi({
      "GET /v1/support/tickets?limit=100": { data: page1, total: 101 },
      "GET /v1/support/tickets?limit=100&offset=100": {
        data: page2,
        total: 101,
      },
    });
    const r = await resolveTicketId("xk4q2", api);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ id: page2[0]!.id, ref: "XK4Q2" });
    expect(calls).toHaveLength(2);
  });

  test("an unknown ref is a 404 after the last page", async () => {
    const { api, calls } = fakeApi({
      "GET /v1/support/tickets?limit=100": {
        data: [ticket(1, "AAAAA")],
        total: 1,
      },
    });
    const r = await resolveTicketId("ZZZZZ", api);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  test("something that is neither ref nor id is a 404 with no request", async () => {
    const { api, calls } = fakeApi({});
    expect((await resolveTicketId("not a ref!", api)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("an API failure while paging carries its status", async () => {
    const api = {
      request: (async () => ({
        ok: false,
        status: 403,
        data: { error: "no" },
      })) as never,
    };
    expect((await resolveTicketId("ABCDE", api)).status).toBe(403);
  });
});

describe("thread calls", () => {
  const thread = {
    ticket: {
      ...ticket(7, "ABCDE"),
      isUserRead: false,
      name: "N",
      email: "e@x.y",
    },
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
        body: "Try again.",
        createdAt: "2026-01-02T00:00:00Z",
      },
    ],
  };
  const id = thread.ticket.id;

  test("viewSupportTicket fetches by id then marks it read", async () => {
    const { api, calls } = fakeApi({
      "GET /v1/support/tickets?limit=100": { data: [thread.ticket], total: 1 },
      [`GET /v1/support/tickets/${id}`]: thread,
      [`POST /v1/support/tickets/${id}/read`]: {},
    });
    const r = await viewSupportTicket("abcde", api);
    expect(r.ok).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/support/tickets?limit=100",
      `GET /v1/support/tickets/${id}`,
      `POST /v1/support/tickets/${id}/read`,
    ]);
  });

  test("getSupportThread does not mark read; a missing ticket is not marked either", async () => {
    const { api, calls } = fakeApi({
      [`GET /v1/support/tickets/${UUID}`]: thread,
    });
    await getSupportThread(UUID, api);
    expect(calls.some((c) => c.path.endsWith("/read"))).toBe(false);
    const missing = fakeApi({});
    const r = await viewSupportTicket(UUID, missing.api);
    expect(r.status).toBe(404);
    expect(missing.calls.some((c) => c.path.endsWith("/read"))).toBe(false);
  });

  test("replyToSupportTicket posts the message to the resolved id", async () => {
    const { api, calls } = fakeApi({
      [`POST /v1/support/tickets/${UUID}/messages`]: { id: "m9" },
    });
    const r = await replyToSupportTicket(UUID, "more detail", api);
    expect(r.data).toEqual({ id: "m9" });
    expect(calls[0]!.body).toEqual({ message: "more detail" });
  });

  test("renderThreadMarkdown names the ref, status, waiting-on and each author", () => {
    const md = renderThreadMarkdown(thread);
    expect(md).toContain("# [ABCDE] Ticket ABCDE");
    expect(md).toContain("waiting on you");
    expect(md).toContain("## You, 2026-01-01T00:00:00Z");
    expect(md).toContain("## Nik (support), 2026-01-02T00:00:00Z");
    expect(md).not.toContain("\u2014");
  });
});

describe("validateReply and failure text", () => {
  test("an empty reply is refused, a long one is cut", () => {
    expect(validateReply("   ").ok).toBe(false);
    const r = validateReply("x".repeat(BODY_MAX_LENGTH + 1));
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
  });
  test("describeSupportFailure covers the statuses an agent will hit", () => {
    const f = (status: number, data: unknown = null) =>
      describeSupportFailure({ ok: false, status, data });
    expect(f(0)).toContain("Couldn't reach");
    expect(f(401)).toContain("squirrel auth login");
    expect(f(403)).toContain("org API keys are not accepted");
    expect(f(403, { error: "Forbidden by policy" })).toBe(
      "Forbidden by policy"
    );
    expect(f(429)).toContain("5 an hour");
    expect(f(500)).toBe("Request failed (HTTP 500).");
  });
  test("isOrgApiKey separates sq_ keys from sqcli_ logins", () => {
    expect(isOrgApiKey("sq_abc")).toBe(true);
    expect(isOrgApiKey("sq_dev_abc")).toBe(true);
    expect(isOrgApiKey("sqcli_abc")).toBe(false);
  });
});
