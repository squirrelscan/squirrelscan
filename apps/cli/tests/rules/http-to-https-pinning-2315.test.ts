// #2315: security/http-to-https through the request tool the audit controller
// installs. With own-host pinning on (`ownHostProbeEgress`), the probe's name
// is resolved through the policy's resolver, a link-local or metadata answer
// is refused before anything is sent, and the request connects to the checked
// address with the original Host. With pinning off (SQUIRREL_NO_HOST_PINNING,
// an environment proxy) there is no policy and the probe goes out by name.

import type { RuleContext } from "@squirrelscan/rules";

import { setRequestAsync } from "@squirrelscan/rules";
import { httpToHttpsRule } from "@squirrelscan/rules/security/http-to-https";
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";

import { ownHostProbeEgress } from "@/crawl/pin-own-hosts";
import { installRuleRequestTool } from "@/tools/request";

const HOST = "site.example.com";
const BASE = `https://${HOST}/`;
const PUBLIC_ADDRESS = "93.184.215.14";

interface Sent {
  url: string;
  host: string | null;
}

let fetchSpy: ReturnType<typeof spyOn> | undefined;

/** Records every request: http:// redirects to https://, which answers 200. */
function recordFetch(): Sent[] {
  const sent: Sent[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = typeof input === "string" ? input : String(input);
    const host = new Headers(init?.headers).get("host");
    sent.push({ url, host });
    const u = new URL(url);
    if (u.protocol === "https:") return new Response("<html></html>");
    return new Response(null, {
      status: 301,
      headers: { location: `https://${host ?? u.host}${u.pathname}` },
    });
  }) as typeof fetch);
  return sent;
}

function resolverFor(answers: string[]): {
  resolve: (name: string) => Promise<string[]>;
  lookups: string[];
} {
  const lookups: string[] = [];
  return {
    lookups,
    resolve: async (name) => {
      lookups.push(name);
      return answers;
    },
  };
}

function ctx(): RuleContext {
  return {
    site: { baseUrl: BASE, pages: [] },
    options: {},
  } as unknown as RuleContext;
}

const ENV_KEYS = [
  "SQUIRREL_NO_HOST_PINNING",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function clearPinningEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

afterAll(() => {
  setRequestAsync(() => {
    throw new Error("requestAsync not injected");
  });
});

describe("security/http-to-https with own-host pinning (#2315)", () => {
  test("pinned: connects to the checked address with the original Host", async () => {
    clearPinningEnv();
    const sent = recordFetch();
    const { resolve, lookups } = resolverFor([PUBLIC_ADDRESS]);
    const egress = ownHostProbeEgress(resolve);
    expect(egress).toBeDefined();
    installRuleRequestTool({ egress });
    const { checks } = await httpToHttpsRule.run(ctx());
    expect(lookups).toContain(HOST);
    // The http:// probe, then the https:// hop it redirected to: both pinned.
    expect(sent.map((r) => new URL(r.url).protocol)).toEqual([
      "http:",
      "https:",
    ]);
    for (const r of sent) {
      expect(new URL(r.url).hostname).toBe(PUBLIC_ADDRESS);
      expect(r.host).toBe(HOST);
    }
    expect(checks[0]!.status).toBe("pass");
  });

  for (const answers of [
    ["169.254.169.254"],
    ["fd00:ec2::254"],
    [PUBLIC_ADDRESS, "169.254.169.254"],
  ]) {
    test(`pinned: a host that resolves to ${answers.join(" + ")} gets no probe`, async () => {
      clearPinningEnv();
      const sent = recordFetch();
      const { resolve } = resolverFor(answers);
      installRuleRequestTool({ egress: ownHostProbeEgress(resolve) });
      const { checks } = await httpToHttpsRule.run(ctx());
      expect(sent).toHaveLength(0);
      // Nothing verified: neither a pass nor an accusation.
      expect(checks[0]!.status).toBe("info");
    });
  }

  test("pinned with --offline: the own host is still probed, at the checked address", async () => {
    clearPinningEnv();
    const sent = recordFetch();
    const { resolve } = resolverFor([PUBLIC_ADDRESS]);
    installRuleRequestTool({
      ownSiteHost: HOST,
      egress: ownHostProbeEgress(resolve),
    });
    const { checks } = await httpToHttpsRule.run(ctx());
    expect(sent).toHaveLength(2);
    for (const r of sent) expect(new URL(r.url).hostname).toBe(PUBLIC_ADDRESS);
    expect(checks[0]!.status).toBe("pass");
  });

  for (const [label, key, value] of [
    ["SQUIRREL_NO_HOST_PINNING", "SQUIRREL_NO_HOST_PINNING", "1"],
    ["an environment proxy", "HTTPS_PROXY", "http://proxy.example.com:3128"],
  ] as const) {
    test(`not pinned (${label}): no policy, the probe goes out by name`, async () => {
      clearPinningEnv();
      process.env[key] = value;
      const { resolve, lookups } = resolverFor(["169.254.169.254"]);
      const egress = ownHostProbeEgress(resolve);
      expect(egress).toBeUndefined();
      const sent = recordFetch();
      installRuleRequestTool(egress ? { egress } : {});
      const { checks } = await httpToHttpsRule.run(ctx());
      expect(lookups).toHaveLength(0);
      expect(sent.map((r) => r.url)).toEqual([
        `http://${HOST}/`,
        `https://${HOST}/`,
      ]);
      for (const r of sent) expect(r.host).toBeNull();
      expect(checks[0]!.status).toBe("pass");
    });
  }
});
