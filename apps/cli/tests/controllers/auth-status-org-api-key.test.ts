// `/v1/auth/whoami` is the CLI-SESSION identity endpoint: it accepts only the
// `sqcli_…` token `squirrel auth login` issues and refuses an `sq_…` org API key
// at the prefix. So a key that authenticates fine for audits, publishing and MCP
// still 401s here, and the generic wording told the user their key was
// "invalid, revoked, expired, or wrong environment" — none of which is true.
// These tests pin the message that explains what actually happened.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runAuthStatus } from "@/controllers/auth/status";

const API_KEY_ENV = "SQUIRRELSCAN_API_KEY"; // pragma: allowlist secret
const API_SERVER_ENV = "SQUIRREL_API_SERVER";

// Module-level env snapshot is safe: `bun test` runs the tests in a file
// sequentially in one process, so each beforeEach/afterEach pair completes
// before the next test starts. Restore is unconditional so a failing assertion
// still leaves SQUIRREL_API_SERVER as the rest of the suite expects it.
let server: ReturnType<typeof Bun.serve> | null = null;
const saved: Record<string, string | undefined> = {};

/** Serve a fixed status on /v1/auth/whoami and point the CLI at it. */
function serveWhoami(status: number, body?: unknown) {
  const payload = body ?? { error: "nope" };
  server = Bun.serve({
    port: 0,
    fetch: () => Response.json(payload, { status }),
  });
  process.env[API_SERVER_ENV] = `http://127.0.0.1:${server.port}`;
}

beforeEach(() => {
  for (const key of [API_KEY_ENV, API_SERVER_ENV, "SQUIRREL_API_TOKEN"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  server?.stop(true);
  server = null;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("auth status with an org API key the identity endpoint refuses", () => {
  test("explains that the endpoint wants a login token, and does not call the key invalid", async () => {
    process.env[API_KEY_ENV] = "sq_notarealkeynotarealkeynotareal"; // pragma: allowlist secret
    serveWhoami(401);

    const result = await runAuthStatus();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("API_KEY_NOT_VERIFIABLE");

    const message = result.error.message;
    // Names the credential and the command that produces a usable one.
    expect(message).toContain(API_KEY_ENV);
    expect(message).toContain("squirrel auth login");
    // Says what is actually going on, rather than accusing the key.
    expect(message).toContain("cannot verify");
    expect(message).not.toContain("was rejected by");
    // The secret never appears in output.
    expect(message).not.toContain("notarealkey");
  });

  test("a dev-environment key gets the same explanation", async () => {
    process.env[API_KEY_ENV] = "sq_dev_notarealkeynotarealkeynot"; // pragma: allowlist secret
    serveWhoami(401);

    const result = await runAuthStatus();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("API_KEY_NOT_VERIFIABLE");
  });

  test("a login token that is genuinely rejected still reports as rejected", async () => {
    // Regression guard: the new branch keys on the sq_ prefix, so the existing
    // fail-closed wording for a real dead credential must be untouched.
    process.env[API_KEY_ENV] = "sqcli_notarealtokennotarealtoken"; // pragma: allowlist secret
    serveWhoami(401);

    const result = await runAuthStatus();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TOKEN_INVALID");
    expect(result.error.message).toContain("was rejected by");
  });

  test("a non-401 failure is still a plain API error", async () => {
    process.env[API_KEY_ENV] = "sq_notarealkeynotarealkeynotareal"; // pragma: allowlist secret
    serveWhoami(500);

    const result = await runAuthStatus();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("API_ERROR");
  });

  test("an org API key the endpoint DOES accept reports normally", async () => {
    // Forward compatibility: if the identity endpoint ever accepts org keys,
    // nothing here suppresses the successful answer.
    process.env[API_KEY_ENV] = "sq_notarealkeynotarealkeynotareal"; // pragma: allowlist secret
    serveWhoami(200, {
      user: { id: "u_1", email: "dev@example.com", name: "Dev" },
      authSource: "api-key",
      apiKey: { name: "ci", scopes: ["audits:write"], keyEnv: "production" },
      org: { id: "org_1", name: "Example" },
    });

    const result = await runAuthStatus();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.source).toBe("env");
    expect(result.data.apiKey?.scopes).toEqual(["audits:write"]);
    expect(result.data.org?.id).toBe("org_1");
  });
});
