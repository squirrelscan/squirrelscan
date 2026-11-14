// security/http-to-https through the REAL injected request function (#1269).
// installRuleRequestTool is what the audit controller calls; the rule's probe
// goes followRedirects -> requestAsync -> that function -> a local Bun.serve.

import type { RuleContext } from "@squirrelscan/rules";

import { setRequestAsync } from "@squirrelscan/rules";
import { httpToHttpsRule } from "@squirrelscan/rules/security/http-to-https";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";

import { installRuleRequestTool } from "@/tools/request";

type Mode = "redirect" | "plain" | "slow";
let mode: Mode = "plain";
let server: ReturnType<typeof Bun.serve>;
let base = "";

function ctx(
  pageCount: number,
  options: Record<string, unknown> = {}
): RuleContext {
  const pages = Array.from({ length: pageCount }, (_, i) => ({
    url: `${base}/p${i}`,
    statusCode: 200,
  }));
  return { site: { baseUrl: base, pages }, options } as unknown as RuleContext;
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (mode === "slow") await Bun.sleep(600);
      if (mode === "redirect" || mode === "slow") {
        return new Response(null, {
          status: 301,
          headers: {
            Location: `https://127.0.0.1:${server.port}${u.pathname}`,
          },
        });
      }
      return new Response("<html></html>", { status: 200 });
    },
  });
  // Same port, https scheme: the rule rewrites the scheme and keeps the port.
  base = `https://127.0.0.1:${server.port}`;
  installRuleRequestTool();
});

afterEach(() => {
  mode = "plain";
});

afterAll(async () => {
  await server.stop(true);
  setRequestAsync(() => {
    throw new Error("requestAsync not injected");
  });
});

describe("security/http-to-https with the injected request function", () => {
  test("http URLs that do not redirect fail", async () => {
    mode = "plain";
    const { checks } = await httpToHttpsRule.run(ctx(2));
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.items?.length).toBe(3); // base + 2 pages
    expect(checks[0]!.details?.partial).toBe(false);
  });

  test("correct redirects pass", async () => {
    mode = "redirect";
    const { checks } = await httpToHttpsRule.run(ctx(2));
    expect(checks[0]!.status).toBe("pass");
    expect(checks[0]!.details?.redirected).toBe(3);
  });

  test("a budget hit reports partial coverage instead of a clean result", async () => {
    mode = "slow";
    const { checks } = await httpToHttpsRule.run(
      ctx(14, { sampleLimit: 15, probeBudgetMs: 1000 })
    );
    const check = checks[0]!;
    expect(check.details?.partial).toBe(true);
    expect(Number(check.details?.notProbed)).toBeGreaterThan(0);
    expect(check.status).not.toBe("pass");
    expect(check.message).toContain("partial coverage");
  }, 30_000);

  test("probeBudgetMs and sampleLimit are validated options", () => {
    const parsed = (
      httpToHttpsRule.meta.optionsSchema as {
        parse(v: unknown): Record<string, number>;
      }
    ).parse({});
    expect(parsed.probeBudgetMs).toBe(20000);
    expect(parsed.sampleLimit).toBe(20);
  });

  test("--offline refuses a hop to another host", async () => {
    installRuleRequestTool({ ownSiteHost: "example.invalid" });
    try {
      mode = "plain";
      const { checks } = await httpToHttpsRule.run(ctx(0));
      expect(checks[0]!.status).toBe("info"); // nothing verifiable
    } finally {
      installRuleRequestTool();
    }
  });
});
