// The cloud's org role matrix refuses a viewer or billing member's publish with
// a bare `error: "forbidden_role"` and the reason beside it. The CLI must say
// that, not report an error with no code and no message.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { publishReport } from "../../src/controllers/report/publish";
import { API_TOKEN_ENV_VAR } from "../../src/self/credentials";
import { publishReportShape } from "../helpers/publish-report-shape";
import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

isolateSquirrelHome("squirrel-pub-role-refusal");

const originalToken = process.env[API_TOKEN_ENV_VAR];
const originalFetch = globalThis.fetch;
let respond: () => Response;

beforeAll(() => {
  process.env[API_TOKEN_ENV_VAR] = "sq_live_test_token_for_role_refusal";
});
afterAll(() => {
  if (originalToken === undefined) delete process.env[API_TOKEN_ENV_VAR];
  else process.env[API_TOKEN_ENV_VAR] = originalToken;
});
beforeEach(() => {
  globalThis.fetch = (async () => respond()) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("a publish the org's role matrix refuses", () => {
  test("says the role refused it, with the server's reason and what to do", async () => {
    respond = () =>
      Response.json(
        {
          error: "forbidden_role",
          message:
            "Your role (viewer) in this organization does not include audits:write",
          role: "viewer",
          missing_scope: "audits:write",
        },
        { status: 403 }
      );
    const result = await publishReport(publishReportShape(5));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("forbidden_role");
    expect(result.error.message).toContain("Your role (viewer)");
    expect(result.error.message).toContain("--no-publish");
  });

  test("another bare-string error still names the status and the error", async () => {
    respond = () =>
      Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    const result = await publishReport(publishReportShape(5));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("API_ERROR");
    expect(result.error.message).toContain("429");
    expect(result.error.message).toContain("Rate limit exceeded");
  });
});
