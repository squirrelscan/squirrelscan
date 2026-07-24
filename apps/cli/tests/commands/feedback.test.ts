// #1142: unit/integration tests for `squirrel feedback`, which had zero
// coverage after #1119/#1132 added --category branching, the interactive
// category picker, the cached-email flow, and the /v1/feedback payload.
//
// The command lives entirely inside a citty `run({ args })`, so we drive it
// end-to-end (mirroring tests/commands/skills.test.ts) and stub its four seams:
//   - node:readline `createInterface` — spyOn the module namespace (cross-module
//     live-binding propagation is proven to work in Bun for built-ins here), so
//     `rl.question` replays a scripted answer queue instead of blocking on real
//     stdin. NO real tty, NO hang.
//   - @/self/settings loadUserSettings/updateSettings — spyOn (NOT mock.module,
//     which leaks process-wide per #1037): loadUserSettings returns controlled
//     settings so we never read the real ~/.squirrel, and updateSettings is
//     captured instead of writing to disk. getInstallId is left real — it reads
//     loadUserSettings().data.id, which our stub controls.
//   - globalThis.fetch — swapped per test (the repo's api-client pattern) so the
//     REAL cliApi transport runs (URL join, auth:"none", JSON body) but no
//     network call happens; the request is captured for payload assertions.
//   - process.exit — throws a ProcessExitSignal so control flow halts exactly
//     where production would (a no-op mock would fall through past `exit(1)`).

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import * as readlineModule from "node:readline";

import { feedback } from "@/cli/commands/feedback";
import { err, ok } from "@/controllers/types";
import * as settingsModule from "@/self/settings";
import { DEFAULT_SETTINGS } from "@/self/settings";

import { version as CLI_VERSION } from "../../package.json";

const FEEDBACK_FALLBACK_URL = "https://squirrelscan.com/feedback";
const FEEDBACK_PATH = "/v1/feedback";

// ── Mutable state the top-level stubs read; reset in beforeEach ──────────────
let rlAnswers: string[] = [];
let rlCloseCount = 0;
let cachedEmailSetting: string | null = null;
let installIdSetting: string | null = null;
let settingsReadable = true;
let loadThrows = false;
let updatedPatches: Array<Partial<typeof DEFAULT_SETTINGS>> = [];

interface CapturedFetch {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}
let lastFetch: CapturedFetch | null = null;
let fetchResponder: () => Response = () =>
  new Response(JSON.stringify({ ok: true }), { status: 200 });

// process.exit is typed `never`; a plain no-op would let execution fall through
// the code the command believes is unreachable after `exit(1)`. Throw instead so
// control flow stops exactly where it does in production (skills.test precedent).
class ProcessExitSignal extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

// ── Top-level spies (call-time; safe to set before feedback.run is invoked) ──
const createInterfaceSpy = spyOn(
  readlineModule,
  "createInterface"
).mockImplementation((() => ({
  question: (q: string, cb: (answer: string) => void) => {
    if (rlAnswers.length === 0) {
      // Loud, terminating failure instead of an infinite validation loop when
      // a scenario under-provisions its answer queue.
      throw new Error(`readline answer queue exhausted at prompt: ${q}`);
    }
    cb(rlAnswers.shift()!);
  },
  close: () => {
    rlCloseCount++;
  },
})) as unknown as typeof readlineModule.createInterface);

const loadUserSettingsSpy = spyOn(
  settingsModule,
  "loadUserSettings"
).mockImplementation(() => {
  if (loadThrows) throw new Error("settings blew up");
  if (!settingsReadable) {
    return err({ code: "SETTINGS_UNREADABLE", message: "corrupt settings" });
  }
  return ok({
    ...DEFAULT_SETTINGS,
    user_feedback_email: cachedEmailSetting,
    id: installIdSetting,
  });
});

const updateSettingsSpy = spyOn(
  settingsModule,
  "updateSettings"
).mockImplementation((patch) => {
  updatedPatches.push(patch);
  return ok({ ...DEFAULT_SETTINGS, ...patch });
});

afterAll(() => {
  createInterfaceSpy.mockRestore();
  loadUserSettingsSpy.mockRestore();
  updateSettingsSpy.mockRestore();
});

const originalFetch = globalThis.fetch;
let logSpy: ReturnType<typeof spyOn<Console, "log">>;
let errorSpy: ReturnType<typeof spyOn<Console, "error">>;

beforeEach(() => {
  rlAnswers = [];
  rlCloseCount = 0;
  cachedEmailSetting = null;
  installIdSetting = null;
  settingsReadable = true;
  loadThrows = false;
  updatedPatches = [];
  lastFetch = null;
  fetchResponder = () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 });

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    lastFetch = {
      url: input.toString(),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body != null ? JSON.parse(String(init.body)) : null,
    };
    return fetchResponder();
  }) as unknown as typeof fetch;

  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ProcessExitSignal(code);
  }) as typeof process.exit);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  logSpy.mockRestore();
  errorSpy.mockRestore();
  (process.exit as unknown as { mockRestore: () => void }).mockRestore();
});

// ── Helpers ──────────────────────────────────────────────────────────────────
type FeedbackRunCtx = Parameters<NonNullable<typeof feedback.run>>[0];

async function runFeedback(
  args: { category?: string } = {}
): Promise<ProcessExitSignal | null> {
  try {
    await feedback.run?.({
      args,
      cmd: feedback,
      rawArgs: [],
      data: undefined,
    } as unknown as FeedbackRunCtx);
    return null;
  } catch (e) {
    if (e instanceof ProcessExitSignal) return e;
    throw e;
  }
}

function loggedText(): string {
  return logSpy.mock.calls
    .map((c) => c.join(" "))
    .concat(errorSpy.mock.calls.map((c) => c.join(" ")))
    .join("\n");
}

// ── Happy path + payload shape ───────────────────────────────────────────────
describe("squirrel feedback — submission", () => {
  test("no --category, no cached email: prompts email/feedback/category, posts, thanks", async () => {
    rlAnswers = ["user@example.com", "This is genuinely useful feedback", ""];

    const exit = await runFeedback();

    expect(exit).toBeNull();
    expect(lastFetch).not.toBeNull();
    expect(lastFetch!.url.endsWith(FEEDBACK_PATH)).toBe(true);
    expect(lastFetch!.method).toBe("POST");
    expect(lastFetch!.body).toMatchObject({
      email: "user@example.com",
      feedback: "This is genuinely useful feedback",
      source: "cli",
      client_version: CLI_VERSION,
      metadata: { platform: process.platform, arch: process.arch },
    });
    expect(loggedText()).toContain("Thank you for your feedback!");
    expect(rlCloseCount).toBeGreaterThanOrEqual(1);
  });

  test("payload omits category and install_id when neither is present", async () => {
    installIdSetting = null;
    rlAnswers = ["user@example.com", "Some feedback text here", ""];

    await runFeedback();

    expect(lastFetch!.body).not.toHaveProperty("category");
    expect(lastFetch!.body).not.toHaveProperty("install_id");
  });

  test("payload includes install_id when settings carry an id", async () => {
    installIdSetting = "install_abc123";
    rlAnswers = ["user@example.com", "Feedback with install id", ""];

    await runFeedback();

    expect(lastFetch!.body!.install_id).toBe("install_abc123");
  });

  test("posts with auth:none — no Authorization header even when an API key is set", async () => {
    process.env.SQUIRRELSCAN_API_KEY = "sq_live_shouldnotleak";
    rlAnswers = ["user@example.com", "Anonymous feedback works", ""];

    try {
      await runFeedback();
    } finally {
      delete process.env.SQUIRRELSCAN_API_KEY;
    }

    const headerKeys = Object.keys(lastFetch!.headers).map((k) =>
      k.toLowerCase()
    );
    expect(headerKeys).not.toContain("authorization");
    expect(lastFetch!.headers["Content-Type"]).toBe("application/json");
  });
});

// ── --category branching (#1119/#1132) ───────────────────────────────────────
describe("squirrel feedback — --category flag", () => {
  test("valid --category skips the picker and lands in the payload", async () => {
    // Only email + feedback are prompted (no category prompt).
    rlAnswers = ["user@example.com", "Reporting a bug I hit"];

    const exit = await runFeedback({ category: "bug_report" });

    expect(exit).toBeNull();
    expect(lastFetch!.body!.category).toBe("bug_report");
    // The picker header must NOT have been shown.
    expect(loggedText()).not.toContain("Category (optional):");
  });

  test("unknown --category warns then falls through to the interactive picker", async () => {
    // email, feedback, then the picker prompt (skip with empty).
    rlAnswers = ["user@example.com", "Feedback after a bad category", ""];

    const exit = await runFeedback({ category: "banana" });

    expect(exit).toBeNull();
    expect(loggedText()).toContain('Unknown category "banana"');
    expect(loggedText()).toContain("Category (optional):");
    expect(lastFetch!.body).not.toHaveProperty("category");
  });

  test("absent --category shows the picker and a numeric choice maps to a category", async () => {
    rlAnswers = ["user@example.com", "Requesting a new feature", "2"];

    await runFeedback();

    // FEEDBACK_CATEGORIES[1] === "feature_request"
    expect(lastFetch!.body!.category).toBe("feature_request");
  });
});

// ── Interactive category picker validation ───────────────────────────────────
describe("squirrel feedback — category picker", () => {
  test("out-of-range number re-prompts, then a valid number is accepted", async () => {
    rlAnswers = ["user@example.com", "Something worked really well", "99", "3"];

    await runFeedback();

    expect(loggedText()).toContain("Enter a number 1-7");
    // FEEDBACK_CATEGORIES[2] === "what_worked"
    expect(lastFetch!.body!.category).toBe("what_worked");
  });

  test("non-numeric input re-prompts, then a valid number is accepted", async () => {
    rlAnswers = ["user@example.com", "Feedback with a typo first", "abc", "1"];

    await runFeedback();

    expect(loggedText()).toContain("Enter a number 1-7");
    expect(lastFetch!.body!.category).toBe("bug_report");
  });

  test("empty input skips the category (payload has none)", async () => {
    rlAnswers = ["user@example.com", "No category for this one", ""];

    await runFeedback();

    expect(lastFetch!.body).not.toHaveProperty("category");
  });
});

// ── Email prompt + cached-email flow ─────────────────────────────────────────
describe("squirrel feedback — email handling", () => {
  test("cached email is used on empty input and NOT re-saved", async () => {
    cachedEmailSetting = "cached@example.com";
    // Empty email uses the cached value; then feedback, then skip category.
    rlAnswers = ["", "Using my cached email address", ""];

    await runFeedback();

    expect(lastFetch!.body!.email).toBe("cached@example.com");
    // email === cachedEmail → no write.
    expect(updatedPatches).toHaveLength(0);
  });

  test("a new email is persisted for next time via updateSettings", async () => {
    cachedEmailSetting = "old@example.com";
    rlAnswers = ["new@example.com", "Changing my email this time", ""];

    await runFeedback();

    expect(lastFetch!.body!.email).toBe("new@example.com");
    expect(updatedPatches).toEqual([
      { user_feedback_email: "new@example.com" },
    ]);
  });

  test("invalid email re-prompts until a valid one is entered", async () => {
    rlAnswers = [
      "not-an-email",
      "still@bad@",
      "valid@example.com",
      "Retry email feedback",
      "",
    ];

    const exit = await runFeedback();

    expect(exit).toBeNull();
    expect(loggedText()).toContain("Invalid email address.");
    expect(lastFetch!.body!.email).toBe("valid@example.com");
  });

  test("empty email with no cached value re-prompts as required", async () => {
    cachedEmailSetting = null;
    rlAnswers = ["", "you@example.com", "Email was required first", ""];

    await runFeedback();

    expect(loggedText()).toContain("Email is required.");
    expect(lastFetch!.body!.email).toBe("you@example.com");
  });

  test("unreadable settings (not a throw): no cached email, submission still succeeds", async () => {
    settingsReadable = false;
    rlAnswers = ["fresh@example.com", "Works without readable settings", ""];

    const exit = await runFeedback();

    expect(exit).toBeNull();
    expect(lastFetch!.body!.email).toBe("fresh@example.com");
  });
});

// ── Feedback-text validation ─────────────────────────────────────────────────
describe("squirrel feedback — feedback text", () => {
  test("text under 5 chars re-prompts until long enough", async () => {
    rlAnswers = ["user@example.com", "hi", "now this is long enough", ""];

    const exit = await runFeedback();

    expect(exit).toBeNull();
    expect(loggedText()).toContain("Feedback must be at least 5 characters.");
    expect(lastFetch!.body!.feedback).toBe("now this is long enough");
  });

  test("surrounding whitespace is trimmed from the submitted feedback", async () => {
    rlAnswers = ["user@example.com", "   trimmed feedback body   ", ""];

    await runFeedback();

    expect(lastFetch!.body!.feedback).toBe("trimmed feedback body");
  });
});

// ── API failure + fallback URL + exit codes ──────────────────────────────────
describe("squirrel feedback — failure handling", () => {
  test("non-2xx response prints the fallback URL and exits 1", async () => {
    fetchResponder = () => new Response("nope", { status: 500 });
    rlAnswers = ["user@example.com", "This submission will 500", ""];

    const exit = await runFeedback();

    expect(exit?.code).toBe(1);
    // The command's exit(1) throws our signal, which its own try/catch re-catches
    // and re-exits, so a second "Error:" line also fires; assert the meaningful
    // first console.error line here.
    expect(errorSpy.mock.calls[0]!.join(" ")).toContain(
      "Failed to submit feedback"
    );
    expect(errorSpy.mock.calls[0]!.join(" ")).toContain(FEEDBACK_FALLBACK_URL);
  });

  test("transport error (fetch rejects) is treated as failure, exits 1", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    rlAnswers = ["user@example.com", "Network is unreachable now", ""];

    const exit = await runFeedback();

    expect(exit?.code).toBe(1);
    expect(errorSpy.mock.calls[0]!.join(" ")).toContain(
      "Failed to submit feedback"
    );
    expect(loggedText()).not.toContain("Thank you for your feedback!");
  });

  test("a thrown error mid-flow is caught, shows the fallback URL, and exits 1", async () => {
    loadThrows = true; // loadUserSettings throws before any prompt.
    rlAnswers = [];

    const exit = await runFeedback();

    expect(exit?.code).toBe(1);
    expect(loggedText()).toContain("Error: settings blew up");
    expect(loggedText()).toContain(FEEDBACK_FALLBACK_URL);
    // Never reached the network on a pre-submit throw.
    expect(lastFetch).toBeNull();
    expect(loggedText()).not.toContain("Failed to submit feedback");
  });
});
