// #1142: unit/integration tests for `squirrel feedback`, which had zero
// coverage after #1119/#1132 added --category branching, the interactive
// category picker, the cached-email flow, and the /v1/feedback payload.
// #370 added the non-interactive paths (--message, piped stdin, --json).
//
// The command lives entirely inside a citty `run({ args })`, so we drive it
// end-to-end (mirroring tests/commands/skills.test.ts) and stub its five seams:
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
//   - @/cli/stdin stdinIsTTY/readStdinText — spyOn, so each test says whether
//     a person is at the terminal and what was piped. The test runner's own
//     stdin is never read.

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
import * as stdinModule from "@/cli/stdin";
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
let authEmailSetting: string | null = null;
// A person at a terminal unless a test says otherwise: the interactive tests
// below predate the piped path and assume one.
let stdinTTY = true;
let stdinText = "";
let stdinTimedOut = false;
let stdinReads = 0;

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
    ...(authEmailSetting
      ? {
          auth: {
            token: "session-token",
            userId: "user_1",
            email: authEmailSetting,
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        }
      : {}),
  });
});

const stdinIsTTYSpy = spyOn(stdinModule, "stdinIsTTY").mockImplementation(
  () => stdinTTY
);
const readStdinTextSpy = spyOn(stdinModule, "readStdinText").mockImplementation(
  async () => {
    stdinReads++;
    return { text: stdinText, timedOut: stdinTimedOut };
  }
);

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
  stdinIsTTYSpy.mockRestore();
  readStdinTextSpy.mockRestore();
});

const originalFetch = globalThis.fetch;
let logSpy: ReturnType<typeof spyOn<Console, "log">>;
let errorSpy: ReturnType<typeof spyOn<Console, "error">>;
let stderrWrites: string[] = [];
let stderrSpy: { mockRestore: () => void };

beforeEach(() => {
  rlAnswers = [];
  rlCloseCount = 0;
  cachedEmailSetting = null;
  installIdSetting = null;
  settingsReadable = true;
  loadThrows = false;
  updatedPatches = [];
  authEmailSetting = null;
  stdinTTY = true;
  stdinText = "";
  stdinTimedOut = false;
  stdinReads = 0;
  stderrWrites = [];
  createInterfaceSpy.mockClear();
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
  stderrSpy = spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array
  ) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ProcessExitSignal(code);
  }) as typeof process.exit);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  logSpy.mockRestore();
  errorSpy.mockRestore();
  stderrSpy.mockRestore();
  (process.exit as unknown as { mockRestore: () => void }).mockRestore();
});

// ── Helpers ──────────────────────────────────────────────────────────────────
type FeedbackRunCtx = Parameters<NonNullable<typeof feedback.run>>[0];

async function runFeedback(
  args: Record<string, string | string[] | boolean | undefined> = {}
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
    .concat(stderrWrites)
    .join("\n");
}

function stderrText(): string {
  return stderrWrites.join("");
}

/** The one JSON object --json printed on stdout. */
function jsonOutput(): Record<string, unknown> {
  const lines = logSpy.mock.calls.map((c) => c.join(" "));
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
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
    expect(stderrText()).toContain("Failed to submit feedback");
    expect(stderrText()).toContain("HTTP 500");
    expect(stderrText()).toContain(FEEDBACK_FALLBACK_URL);
    expect(loggedText()).not.toContain("Thank you for your feedback!");
  });

  test("transport error (fetch rejects) is treated as failure, exits 1", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    rlAnswers = ["user@example.com", "Network is unreachable now", ""];

    const exit = await runFeedback();

    expect(exit?.code).toBe(1);
    expect(stderrText()).toContain(
      "Failed to submit feedback: couldn't reach the squirrelscan API."
    );
    expect(loggedText()).not.toContain("Thank you for your feedback!");
  });

  test("a thrown error mid-flow is caught, shows the fallback URL, and exits 1", async () => {
    loadThrows = true; // loadUserSettings throws before any prompt.
    rlAnswers = [];

    const exit = await runFeedback();

    expect(exit?.code).toBe(1);
    expect(loggedText()).toContain("Unexpected error: settings blew up");
    expect(loggedText()).toContain(FEEDBACK_FALLBACK_URL);
    // Never reached the network on a pre-submit throw.
    expect(lastFetch).toBeNull();
    expect(loggedText()).not.toContain("Failed to submit feedback");
  });
});

// ── Non-interactive: --message (#370) ────────────────────────────────────────
describe("squirrel feedback — --message", () => {
  test("sends without a prompt and exits 0, even with no TTY", async () => {
    stdinTTY = false;
    cachedEmailSetting = "agent@example.com";

    const exit = await runFeedback({
      message: "  The sitemap rule misfires on gzip sitemaps  ",
      category: "bug_report",
    });

    expect(exit).toBeNull();
    // No readline interface, so no prompt, and stdin was never read.
    expect(createInterfaceSpy).not.toHaveBeenCalled();
    expect(stdinReads).toBe(0);
    expect(lastFetch!.body).toMatchObject({
      email: "agent@example.com",
      feedback: "The sitemap rule misfires on gzip sitemaps",
      category: "bug_report",
      source: "cli",
      client_version: CLI_VERSION,
      metadata: { platform: process.platform, arch: process.arch },
    });
    expect(loggedText()).toContain("Thank you for your feedback!");
  });

  test("on a TTY too: --message never prompts", async () => {
    stdinTTY = true;
    cachedEmailSetting = "human@example.com";

    const exit = await runFeedback({ message: "Quick note from a person" });

    expect(exit).toBeNull();
    expect(createInterfaceSpy).not.toHaveBeenCalled();
    expect(lastFetch!.body!.feedback).toBe("Quick note from a person");
    expect(lastFetch!.body).not.toHaveProperty("category");
  });

  test("--email wins over the cached email and is NOT saved (an agent's address must not become a person's default)", async () => {
    cachedEmailSetting = "old@example.com";

    await runFeedback({
      message: "Email from the flag",
      email: "new@example.com",
    });

    expect(lastFetch!.body!.email).toBe("new@example.com");
    expect(updatedPatches).toHaveLength(0);
  });

  test("with no --email and no cached one, the signed-in account's email is used and not saved", async () => {
    authEmailSetting = "account@example.com";

    await runFeedback({ message: "Signed in, never typed an email" });

    expect(lastFetch!.body!.email).toBe("account@example.com");
    expect(updatedPatches).toHaveLength(0);
  });

  test("the cached email beats the account email", async () => {
    cachedEmailSetting = "cached@example.com";
    authEmailSetting = "account@example.com";

    await runFeedback({ message: "Which email wins here" });

    expect(lastFetch!.body!.email).toBe("cached@example.com");
  });

  test("no email anywhere: exits 1 naming --email, sends nothing", async () => {
    const exit = await runFeedback({ message: "Nobody to reply to" });

    expect(exit?.code).toBe(1);
    expect(lastFetch).toBeNull();
    expect(stderrText()).toContain("Pass --email <address>");
    expect(stderrText()).toContain(FEEDBACK_FALLBACK_URL);
  });

  test("an invalid --email exits 1 without prompting", async () => {
    const exit = await runFeedback({
      message: "Bad address on the flag",
      email: "not-an-email",
    });

    expect(exit?.code).toBe(1);
    expect(lastFetch).toBeNull();
    expect(createInterfaceSpy).not.toHaveBeenCalled();
    expect(stderrText()).toContain(
      '"not-an-email" is not a valid email address.'
    );
  });

  test("an unknown --category exits 1 listing the valid ones (no picker to fall back to)", async () => {
    cachedEmailSetting = "agent@example.com";

    const exit = await runFeedback({
      message: "Some feedback",
      category: "banana",
    });

    expect(exit?.code).toBe(1);
    expect(lastFetch).toBeNull();
    expect(stderrText()).toContain('Unknown category "banana"');
    expect(stderrText()).toContain("bug_report, feature_request");
  });

  test("text under 5 characters after trimming exits 1", async () => {
    cachedEmailSetting = "agent@example.com";

    const exit = await runFeedback({ message: "  hi  " });

    expect(exit?.code).toBe(1);
    expect(lastFetch).toBeNull();
    expect(stderrText()).toContain("at least 5 characters");
  });

  test("an empty --message exits 1 as missing text", async () => {
    cachedEmailSetting = "agent@example.com";

    const exit = await runFeedback({ message: "" });

    expect(exit?.code).toBe(1);
    expect(stderrText()).toContain("No feedback text.");
  });

  test("text over 5000 characters is cut, sent, and flagged", async () => {
    cachedEmailSetting = "agent@example.com";

    const exit = await runFeedback({ message: "x".repeat(6000), json: true });

    expect(exit).toBeNull();
    expect((lastFetch!.body!.feedback as string).length).toBe(5000);
    expect(jsonOutput()).toEqual({ ok: true, category: null, truncated: true });
  });
});

// ── Non-interactive: piped stdin (#370) ──────────────────────────────────────
describe("squirrel feedback — piped stdin", () => {
  test("no --message and no TTY: the piped text is sent, trimmed", async () => {
    stdinTTY = false;
    stdinText = "Piped from an agent\n";
    cachedEmailSetting = "agent@example.com";

    const exit = await runFeedback({ category: "bug_report" });

    expect(exit).toBeNull();
    expect(stdinReads).toBe(1);
    expect(createInterfaceSpy).not.toHaveBeenCalled();
    expect(lastFetch!.body).toMatchObject({
      feedback: "Piped from an agent",
      category: "bug_report",
    });
  });

  test("multi-line piped text keeps its lines", async () => {
    stdinTTY = false;
    stdinText = "Line one\nLine two\n";
    cachedEmailSetting = "agent@example.com";

    await runFeedback();

    expect(lastFetch!.body!.feedback).toBe("Line one\nLine two");
  });

  test("--message wins over piped stdin, which is left unread", async () => {
    stdinTTY = false;
    stdinText = "This should be ignored";
    cachedEmailSetting = "agent@example.com";

    await runFeedback({ message: "The flag text" });

    expect(stdinReads).toBe(0);
    expect(lastFetch!.body!.feedback).toBe("The flag text");
  });

  test("empty stdin exits 1 naming both ways in", async () => {
    stdinTTY = false;
    stdinText = "";
    cachedEmailSetting = "agent@example.com";

    const exit = await runFeedback();

    expect(exit?.code).toBe(1);
    expect(lastFetch).toBeNull();
    expect(stderrText()).toContain("--message");
    expect(stderrText()).toContain("pipe it on stdin");
  });
});

// ── --json (#370) ────────────────────────────────────────────────────────────
describe("squirrel feedback — --json", () => {
  test("success prints exactly one JSON object and exits 0", async () => {
    cachedEmailSetting = "agent@example.com";

    const exit = await runFeedback({
      message: "JSON please",
      category: "tool_ergonomics",
      json: true,
    });

    expect(exit).toBeNull();
    expect(jsonOutput()).toEqual({
      ok: true,
      category: "tool_ergonomics",
      truncated: false,
    });
    expect(stderrText()).toBe("");
  });

  test("an API failure prints ok:false with the status and fallback URL, exits 1", async () => {
    cachedEmailSetting = "agent@example.com";
    fetchResponder = () => new Response("nope", { status: 503 });

    const exit = await runFeedback({ message: "This will 503", json: true });

    expect(exit?.code).toBe(1);
    expect(jsonOutput()).toEqual({
      ok: false,
      code: "submit_failed",
      error: "Failed to submit feedback: the API answered HTTP 503.",
      status: 503,
      fallback_url: FEEDBACK_FALLBACK_URL,
    });
    // No themed error block alongside the JSON.
    expect(stderrText()).toBe("");
  });

  test("a 429 is reported as rate_limited", async () => {
    cachedEmailSetting = "agent@example.com";
    fetchResponder = () => new Response("slow down", { status: 429 });

    const exit = await runFeedback({
      message: "Too many of these",
      json: true,
    });

    expect(exit?.code).toBe(1);
    expect(jsonOutput()).toMatchObject({
      ok: false,
      code: "rate_limited",
      status: 429,
    });
  });

  test("an unreachable API is status 0", async () => {
    cachedEmailSetting = "agent@example.com";
    globalThis.fetch = (() =>
      Promise.reject(new Error("network down"))) as unknown as typeof fetch;

    const exit = await runFeedback({
      message: "Offline right now",
      json: true,
    });

    expect(exit?.code).toBe(1);
    expect(jsonOutput()).toMatchObject({
      ok: false,
      code: "submit_failed",
      status: 0,
    });
  });

  test("validation failures are JSON too, with a code", async () => {
    const exit = await runFeedback({ message: "No email known", json: true });

    expect(exit?.code).toBe(1);
    expect(jsonOutput()).toMatchObject({
      ok: false,
      code: "email_required",
      fallback_url: FEEDBACK_FALLBACK_URL,
    });
    expect(stderrText()).toBe("");
  });

  test("an unexpected throw is still one JSON object", async () => {
    loadThrows = true;

    const exit = await runFeedback({
      message: "Settings will throw",
      json: true,
    });

    expect(exit?.code).toBe(1);
    expect(jsonOutput()).toMatchObject({
      ok: false,
      code: "unexpected",
      error: "Unexpected error: settings blew up",
    });
  });

  test("on a TTY with no --message, --json refuses to prompt", async () => {
    stdinTTY = true;
    cachedEmailSetting = "agent@example.com";

    const exit = await runFeedback({ json: true });

    expect(exit?.code).toBe(1);
    expect(createInterfaceSpy).not.toHaveBeenCalled();
    expect(lastFetch).toBeNull();
    expect(jsonOutput()).toMatchObject({ ok: false, code: "message_required" });
  });
});

// ── --run-id / --website-id (#370) ───────────────────────────────────────────
describe("squirrel feedback — run and website ids", () => {
  test("both ids travel in the payload metadata", async () => {
    cachedEmailSetting = "agent@example.com";

    await runFeedback({
      message: "About a specific run",
      "run-id": "run_abc123",
      "website-id": "web_xyz789",
    });

    expect(lastFetch!.body!.metadata).toEqual({
      platform: process.platform,
      arch: process.arch,
      run_id: "run_abc123",
      website_id: "web_xyz789",
    });
  });

  test("the interactive flow forwards them too", async () => {
    rlAnswers = ["user@example.com", "Typed about a run", ""];

    await runFeedback({ "run-id": "run_typed" });

    expect(lastFetch!.body!.metadata).toMatchObject({ run_id: "run_typed" });
  });

  test("no ids: metadata carries neither key", async () => {
    cachedEmailSetting = "agent@example.com";

    await runFeedback({ message: "Not about any run" });

    expect(lastFetch!.body!.metadata).not.toHaveProperty("run_id");
    expect(lastFetch!.body!.metadata).not.toHaveProperty("website_id");
  });

  test("a blank or oversized id exits 1 before sending", async () => {
    cachedEmailSetting = "agent@example.com";

    const blank = await runFeedback({
      message: "Blank run id",
      "run-id": " ",
      json: true,
    });
    expect(blank?.code).toBe(1);
    expect(jsonOutput()).toMatchObject({ code: "invalid_run_id" });

    logSpy.mockClear();
    const long = await runFeedback({
      message: "Huge website id",
      "website-id": "w".repeat(129),
      json: true,
    });
    expect(long?.code).toBe(1);
    expect(jsonOutput()).toMatchObject({ code: "invalid_website_id" });
    expect(lastFetch).toBeNull();
  });
});

// ── Interactive flow stays for people (#370) ────────────────────────────────
describe("squirrel feedback — interactive on a TTY", () => {
  test("no --message on a TTY prompts and never reads stdin", async () => {
    stdinTTY = true;
    rlAnswers = ["user@example.com", "Typed by a person", ""];

    const exit = await runFeedback();

    expect(exit).toBeNull();
    expect(createInterfaceSpy).toHaveBeenCalled();
    expect(stdinReads).toBe(0);
    expect(lastFetch!.body!.feedback).toBe("Typed by a person");
  });

  test("a valid --email skips only the email prompt", async () => {
    rlAnswers = ["Feedback after a flag email", ""];

    await runFeedback({ email: "flag@example.com" });

    expect(lastFetch!.body!.email).toBe("flag@example.com");
    expect(lastFetch!.body!.feedback).toBe("Feedback after a flag email");
  });
});

// ── Text from bare words and repeated flags (#370 review) ────────────────────
describe("squirrel feedback — text on the command line", () => {
  test("bare words are the text: `squirrel feedback the sitemap was missed`", async () => {
    stdinTTY = true;
    cachedEmailSetting = "agent@example.com";

    const exit = await runFeedback({ _: ["the", "sitemap", "was", "missed"] });

    expect(exit).toBeNull();
    expect(createInterfaceSpy).not.toHaveBeenCalled();
    expect(lastFetch!.body!.feedback).toBe("the sitemap was missed");
  });

  test("an unquoted -m keeps the words after its first", async () => {
    cachedEmailSetting = "agent@example.com";

    await runFeedback({ message: "the", _: ["sitemap", "was", "missed"] });

    expect(lastFetch!.body!.feedback).toBe("the sitemap was missed");
  });

  test("repeated -m flags are paragraphs", async () => {
    cachedEmailSetting = "agent@example.com";

    await runFeedback({ message: ["First paragraph", "Second paragraph"] });

    expect(lastFetch!.body!.feedback).toBe(
      "First paragraph\n\nSecond paragraph"
    );
  });

  test("a repeated --email or --category takes the last value", async () => {
    await runFeedback({
      message: "Flags given twice",
      email: ["first@example.com", "second@example.com"],
      category: ["other", "bug_report"],
    });

    expect(lastFetch!.body!.email).toBe("second@example.com");
    expect(lastFetch!.body!.category).toBe("bug_report");
  });

  test("the no-text error says how to pass text that starts with a dash", async () => {
    cachedEmailSetting = "agent@example.com";

    const exit = await runFeedback({ message: "", json: true });

    expect(exit?.code).toBe(1);
    expect(jsonOutput().error).toContain('--message="..."');
  });
});

describe("squirrel feedback — stdin that never closes", () => {
  test("silence on an open pipe ends in message_required, naming the wait", async () => {
    stdinTTY = false;
    stdinText = "";
    stdinTimedOut = true;
    cachedEmailSetting = "agent@example.com";

    const exit = await runFeedback({ json: true });

    expect(exit?.code).toBe(1);
    expect(lastFetch).toBeNull();
    expect(jsonOutput()).toMatchObject({ ok: false, code: "message_required" });
    expect(jsonOutput().error).toContain(
      "Nothing arrived on stdin for 5 seconds"
    );
  });

  test("text that arrived before the pipe went quiet is sent", async () => {
    stdinTTY = false;
    stdinText = "Written but never closed";
    stdinTimedOut = true;
    cachedEmailSetting = "agent@example.com";

    const exit = await runFeedback();

    expect(exit).toBeNull();
    expect(lastFetch!.body!.feedback).toBe("Written but never closed");
  });
});

describe("squirrel feedback — interactive email default", () => {
  test("signed in with nothing saved: Enter takes the account email, which is then saved", async () => {
    authEmailSetting = "account@example.com";
    rlAnswers = ["", "Signed in and pressed Enter", ""];

    await runFeedback();

    expect(lastFetch!.body!.email).toBe("account@example.com");
    expect(updatedPatches).toEqual([
      { user_feedback_email: "account@example.com" },
    ]);
  });
});
