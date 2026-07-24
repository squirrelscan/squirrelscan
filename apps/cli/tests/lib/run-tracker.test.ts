import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createRunFinalizer,
  finalizeRun,
  markRunning,
  registerRun,
  reportProgress,
  type RegisteredRun,
  resolveRunFinalizeScore,
} from "@/lib/run-tracker";

// run-tracker resolves a credential from SQUIRREL_API_TOKEN (env path of
// resolveCredential) and calls global fetch. We swap both per test and restore
// after. The contract under test: register returns ids or null but NEVER
// throws; markRunning/finalizeRun are fire-and-forget and swallow all failures.
const originalFetch = globalThis.fetch;
const originalToken = process.env.SQUIRREL_API_TOKEN;

beforeEach(() => {
  process.env.SQUIRREL_API_TOKEN = "sqcli_test_token";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) {
    delete process.env.SQUIRREL_API_TOKEN;
  } else {
    process.env.SQUIRREL_API_TOKEN = originalToken;
  }
});

describe("resolveRunFinalizeScore (#1179)", () => {
  test("publish success adopts the server's post-merge score + issues", () => {
    // The #1179 case: local estimate 84, server re-merge 56 → agent_runs must
    // record the SERVER number so it matches the published report.
    expect(
      resolveRunFinalizeScore({
        invalidAudit: false,
        localHealthScore: 84,
        localIssuesFound: 17405,
        serverHealthScore: 56,
        serverIssuesFound: 4949,
      })
    ).toEqual({ healthScore: 56, issuesFound: 4949 });
  });

  test("no publish (server undefined) keeps the local estimate", () => {
    // --no-publish / offline / anonymous: no second surface, the local score stands.
    expect(
      resolveRunFinalizeScore({
        invalidAudit: false,
        localHealthScore: 83,
        localIssuesFound: 120,
      })
    ).toEqual({ healthScore: 83, issuesFound: 120 });
  });

  test("invalid audit forces a null score regardless of the server value", () => {
    expect(
      resolveRunFinalizeScore({
        invalidAudit: true,
        localHealthScore: 90,
        localIssuesFound: 5,
        serverHealthScore: 56,
        serverIssuesFound: 4949,
      })
    ).toEqual({ healthScore: null, issuesFound: 4949 });
  });

  test("an explicit server null score (failed publish-side grade) overrides the local", () => {
    expect(
      resolveRunFinalizeScore({
        invalidAudit: false,
        localHealthScore: 84,
        localIssuesFound: 10,
        serverHealthScore: null,
        serverIssuesFound: 0,
      })
    ).toEqual({ healthScore: null, issuesFound: 0 });
  });
});

describe("registerRun", () => {
  test("returns ids and POSTs the register endpoint on 201", async () => {
    let captured: {
      url: string;
      method?: string;
      body: Record<string, unknown>;
    } | null = null;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      captured = {
        url: input.toString(),
        method: init?.method,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      };
      return new Response(
        JSON.stringify({
          runId: "run_1",
          websiteId: "web_1",
          auditId: "aud_1",
          status: "pending",
        }),
        { status: 201 }
      );
    }) as unknown as typeof fetch;

    const result = await registerRun({
      url: "https://example.com",
      config: { maxPages: 10 },
    });

    expect(result).toEqual({
      runId: "run_1",
      websiteId: "web_1",
      auditId: "aud_1",
      lifecycleBase: "/v1/agent-runs",
      // Fixture response has no pricing-v10 fields → old-server defaults.
      baseCharged: 0,
      balanceAfterBase: null,
    });
    expect(captured!.method).toBe("POST");
    expect(captured!.url).toContain("/v1/agent-runs/register");
    expect(captured!.url).not.toContain("/org/");
    expect(captured!.body.url).toBe("https://example.com");
    expect(captured!.body.mode).toBe("audit");
    // config is JSON-stringified for the API's `config: z.string()` field.
    expect(captured!.body.config).toBe(JSON.stringify({ maxPages: 10 }));
  });

  test("normalizes a scheme-less URL before sending (#855/#816)", async () => {
    let sentUrl: unknown;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      sentUrl = (
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      ).url;
      return new Response(
        JSON.stringify({
          runId: "run_1",
          websiteId: "web_1",
          auditId: "aud_1",
        }),
        { status: 201 }
      );
    }) as unknown as typeof fetch;

    expect(await registerRun({ url: "example.com" })).not.toBeNull();
    // Servers before #855 gate with z.string().url(); a bare domain must gain
    // a scheme or the run silently goes untracked.
    expect(sentUrl).toBe("https://example.com/");
  });

  test("accepts any 2xx (e.g. 200, not just 201)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          runId: "run_2",
          websiteId: "web_2",
          auditId: "aud_2",
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    expect(await registerRun({ url: "https://example.com" })).toEqual({
      runId: "run_2",
      websiteId: "web_2",
      auditId: "aud_2",
      lifecycleBase: "/v1/agent-runs",
      baseCharged: 0,
      balanceAfterBase: null,
    });
  });

  test("captures the pricing-v10 base charge + balance when present", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          runId: "run_3",
          websiteId: "web_3",
          auditId: "aud_3",
          baseCharged: 50,
          balance: { total: 450, monthly: 450, pack: 0 },
        }),
        { status: 201 }
      )) as unknown as typeof fetch;
    const run = await registerRun({ url: "https://example.com" });
    expect(run?.baseCharged).toBe(50);
    expect(run?.balanceAfterBase).toBe(450);
  });

  test("returns null on a non-2xx response", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await registerRun({ url: "https://example.com" })).toBeNull();
  });

  test("returns null on a network error (never throws)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await registerRun({ url: "https://example.com" })).toBeNull();
  });

  test("returns null when the response omits required ids", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ runId: "run_1" }), {
        status: 201,
      })) as unknown as typeof fetch;
    expect(await registerRun({ url: "https://example.com" })).toBeNull();
  });

  test("warns with the server message on a definitive failure code (#816)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "WEBSITE_LIMIT",
            message: "Website limit reached. Contact support if you need more.",
          },
        }),
        { status: 402 }
      )) as unknown as typeof fetch;

    const warnings: string[] = [];
    const result = await registerRun({ url: "https://newsite.com" }, (m) =>
      warnings.push(m)
    );

    expect(result).toBeNull();
    expect(warnings).toEqual([
      "Website limit reached. Contact support if you need more.",
    ]);
  });

  test("warns on other definitive codes too (INSUFFICIENT_CREDITS) (#816)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "INSUFFICIENT_CREDITS",
            message: "Not enough credits",
          },
        }),
        { status: 402 }
      )) as unknown as typeof fetch;

    const warnings: string[] = [];
    await registerRun({ url: "https://example.com" }, (m) => warnings.push(m));
    expect(warnings).toEqual(["Not enough credits"]);
  });

  test("does NOT warn on a transient 5xx — best-effort tracking stays quiet (#816)", async () => {
    globalThis.fetch = (async () =>
      new Response("upstream boom", {
        status: 503,
      })) as unknown as typeof fetch;

    const warnings: string[] = [];
    expect(
      await registerRun({ url: "https://example.com" }, (m) => warnings.push(m))
    ).toBeNull();
    expect(warnings).toEqual([]);
  });

  test("does NOT warn on a network error (status 0) (#816)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const warnings: string[] = [];
    expect(
      await registerRun({ url: "https://example.com" }, (m) => warnings.push(m))
    ).toBeNull();
    expect(warnings).toEqual([]);
  });

  test("does NOT warn on a 429 rate-limit — transient + plain-string error body (#816 review)", async () => {
    // rate-limit.ts returns { error: "<string>" }, 429 — no .code, and a burst
    // of CI runners must not spam a warning on every register.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Rate limit exceeded, retry later" }),
        {
          status: 429,
        }
      )) as unknown as typeof fetch;

    const warnings: string[] = [];
    expect(
      await registerRun({ url: "https://example.com" }, (m) => warnings.push(m))
    ).toBeNull();
    expect(warnings).toEqual([]);
  });

  test("does NOT warn on a generic 4xx without a definitive code (#816 review)", async () => {
    // A backend hiccup the handler maps to 400 INVALID_URL isn't actionable to
    // the user and must stay silent (only the allowlisted codes warn).
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "INVALID_URL",
            message: "Could not resolve a website",
          },
        }),
        { status: 400 }
      )) as unknown as typeof fetch;

    const warnings: string[] = [];
    await registerRun({ url: "https://example.com" }, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });
});

describe("markRunning / finalizeRun", () => {
  test("markRunning PATCHes status=running with startedAt", async () => {
    let captured: {
      url: string;
      method?: string;
      body: Record<string, unknown>;
    } | null = null;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      captured = {
        url: input.toString(),
        method: init?.method,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await markRunning("run_1", "2026-06-16T00:00:00.000Z");

    expect(captured!.method).toBe("PATCH");
    expect(captured!.url).toContain("/v1/agent-runs/run_1");
    expect(captured!.url).not.toContain("/org/");
    expect(captured!.body).toEqual({
      status: "running",
      startedAt: "2026-06-16T00:00:00.000Z",
    });
  });

  test("finalizeRun omits null optionals and rounds/clamps healthScore", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await finalizeRun("run_1", {
      status: "completed",
      completedAt: "2026-06-16T00:01:00.000Z",
      healthScore: 87.6,
      issuesFound: 12,
      reportId: null, // must be omitted, not sent as null
      completionReason: "success",
    });

    expect(body).toEqual({
      status: "completed",
      completedAt: "2026-06-16T00:01:00.000Z",
      healthScore: 88,
      issuesFound: 12,
      completionReason: "success",
    });
    expect("reportId" in body).toBe(false);
  });

  test("finalizeRun attaches partial phaseTimingsMs on a FAILED run (#871)", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await finalizeRun("run_1", {
      status: "failed",
      completedAt: "2026-07-13T00:00:00.000Z",
      completionReason: "error",
      error: "Audit failed: crawl timed out",
      // The wedged-phase field case (#871): a run that crashed mid-crawl
      // still has crawl's partial timing worth surfacing.
      phaseTimingsMs: { crawl: 240_000 },
    });

    expect(body.status).toBe("failed");
    expect(body.config).toEqual({ phaseTimingsMs: { crawl: 240_000 } });
  });

  test("finalizeRun includes reportId + error when present", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await finalizeRun("run_1", {
      status: "completed",
      completedAt: "t",
      reportId: "rep_1",
    });
    expect(body.reportId).toBe("rep_1");
  });

  test("finalizeRun serializes a cancelled/user_cancel terminal state (#332)", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await finalizeRun("run_1", {
      status: "cancelled",
      completedAt: "t",
      completionReason: "user_cancel",
    });
    expect(body).toEqual({
      status: "cancelled",
      completedAt: "t",
      completionReason: "user_cancel",
    });
  });

  test("finalizeRun never throws on a network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    await expect(
      finalizeRun("run_1", {
        status: "failed",
        completedAt: "t",
        completionReason: "error",
        error: "boom",
      })
    ).resolves.toBeUndefined();
  });
});

describe("createRunFinalizer (#332)", () => {
  const run: RegisteredRun = {
    runId: "run_1",
    websiteId: "web_1",
    auditId: "aud_1",
    lifecycleBase: "/v1/agent-runs",
    baseCharged: 50,
    balanceAfterBase: 450,
  };

  // Count PATCH calls + capture each path so the once-guard + id are observable.
  function trackPatches(): { paths: string[] } {
    const paths: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      paths.push(input.toString());
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    return { paths };
  }

  test("once-guard: a second call no-ops the PATCH", async () => {
    const { paths } = trackPatches();
    const finalize = createRunFinalizer(Promise.resolve(run));

    await finalize({ status: "completed", completedAt: "t" });
    await finalize({ status: "failed", completedAt: "t" });

    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("/v1/agent-runs/run_1");
    expect(paths[0]).not.toContain("/org/");
  });

  test("register race: resolves the id from an in-flight register, PATCHes once", async () => {
    const { paths } = trackPatches();
    // Register still pending when the finalizer is first invoked (the interrupt
    // window the fix targets) — it must await the id, not no-op on a null id.
    let resolveRegister!: (r: RegisteredRun | null) => void;
    const registerPromise = new Promise<RegisteredRun | null>((resolve) => {
      resolveRegister = resolve;
    });
    const finalize = createRunFinalizer(registerPromise);

    const inFlight = finalize({
      status: "cancelled",
      completedAt: "t",
      completionReason: "user_cancel",
    });
    expect(paths).toHaveLength(0); // nothing sent while register is pending
    resolveRegister(run);
    await inFlight;

    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("/v1/agent-runs/run_1");
  });

  test("no registered run: silently no-ops", async () => {
    const { paths } = trackPatches();
    const finalize = createRunFinalizer(Promise.resolve(null));
    await finalize({ status: "failed", completedAt: "t" });
    expect(paths).toHaveLength(0);
  });

  test("never throws when register rejects", async () => {
    trackPatches();
    const finalize = createRunFinalizer(
      Promise.reject(new Error("register died"))
    );
    await expect(
      finalize({ status: "failed", completedAt: "t" })
    ).resolves.toBeUndefined();
  });
});

describe("org API key (sq_) → org-scoped lifecycle routes (#280)", () => {
  // An org API key can't use the userId-scoped routes (they rejectApiKey); the
  // tracker must target the `/org/*` twins that authorize by orgId.
  const ORG_KEY = `sq_${"a".repeat(40)}`;

  beforeEach(() => {
    process.env.SQUIRREL_API_TOKEN = ORG_KEY;
  });

  test("registerRun POSTs /v1/agent-runs/org/register", async () => {
    let url = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      url = input.toString();
      return new Response(
        JSON.stringify({ runId: "r", websiteId: "w", auditId: "a" }),
        { status: 201 }
      );
    }) as unknown as typeof fetch;

    const result = await registerRun({ url: "https://example.com" });
    expect(url).toContain("/v1/agent-runs/org/register");
    // The org base is threaded into RegisteredRun so finalize/markRunning reuse it.
    expect(result?.lifecycleBase).toBe("/v1/agent-runs/org");
  });

  test("markRunning PATCHes the org-scoped run path", async () => {
    let url = "";
    let method = "";
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      url = input.toString();
      method = init?.method ?? "";
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await markRunning("run_1", "t");
    expect(method).toBe("PATCH");
    expect(url).toContain("/v1/agent-runs/org/run_1");
  });

  test("reportProgress POSTs the org-scoped progress path", async () => {
    let url = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      url = input.toString();
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await reportProgress("run_1", {
      pagesFetched: 1,
      pagesTotal: 2,
      pagesFailed: 0,
    });
    expect(url).toContain("/v1/agent-runs/org/run_1/progress");
  });

  test("finalizeRun PATCHes the org-scoped run path", async () => {
    let url = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      url = input.toString();
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await finalizeRun("run_1", { status: "completed", completedAt: "t" });
    expect(url).toContain("/v1/agent-runs/org/run_1");
  });
});
