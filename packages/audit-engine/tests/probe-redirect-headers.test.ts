// #2831: the soft-404 confirmation and the cloaking probe follow redirects by
// hand, so the audit's custom headers reach only the audited origin, and every
// hop obeys the egress policy. Real loopback servers: a different port is a
// different origin.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import { createHeaderScope } from "@squirrelscan/utils/headers";
import type { EgressPolicy } from "@squirrelscan/utils/public-egress";

import { runCloakingProbe } from "../src/cloaking-probe";
import { probeFetch } from "../src/lib/probe-fetch";
import { confirmSoft404Candidates } from "../src/soft404-confirm";

const SECRET = { "X-Api-Key": "audit-secret", Authorization: "Bearer audit-token" };
const SHELL_HTML = `<!doctype html><html id="__next_error__"><head><meta name="robots" content="noindex"><title>Page Not Found</title></head><body><main><h1>Page Not Found</h1></main></body></html>`;

type Seen = { path: string; apiKey: string | null; auth: string | null };
const siteSeen: Seen[] = [];
const otherSeen: Seen[] = [];
let site: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
let policy: EgressPolicy;

const record = (log: Seen[], req: Request) => {
  const path = new URL(req.url).pathname;
  log.push({ path, apiKey: req.headers.get("x-api-key"), auth: req.headers.get("authorization") });
};

beforeAll(() => {
  other = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      record(otherSeen, req);
      return new Response(SHELL_HTML, { headers: { "content-type": "text/html" } });
    },
  });
  site = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      record(siteSeen, req);
      const path = new URL(req.url).pathname;
      if (path === "/cross") {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${other.port}/landed` },
        });
      }
      if (path === "/meta") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      if (path === "/same") {
        return new Response(null, { status: 302, headers: { location: "/final" } });
      }
      return new Response(SHELL_HTML, { headers: { "content-type": "text/html" } });
    },
  });
  // A LAN audit: private addresses allowed, the site's own origin sent as-is.
  policy = {
    allowPrivateNetwork: true,
    trustTarget: (url) => url.port === String(site.port),
  };
});

afterAll(() => {
  site.stop(true);
  other.stop(true);
});

const reset = () => {
  siteSeen.length = 0;
  otherSeen.length = 0;
};

describe("probeFetch", () => {
  for (const [label, egress] of [
    ["without a policy", undefined],
    ["with a LAN policy", () => policy],
  ] as const) {
    test(`${label}: a cross-origin hop gets none of the custom headers`, async () => {
      reset();
      const res = await probeFetch(
        `http://127.0.0.1:${site.port}/cross`,
        { headers: SECRET },
        typeof egress === "function" ? egress() : egress,
      );
      await res.text();
      expect(siteSeen[0]?.apiKey).toBe("audit-secret");
      expect(otherSeen).toHaveLength(1);
      expect(otherSeen[0]?.apiKey).toBeNull();
      expect(otherSeen[0]?.auth).toBeNull();
    });

    test(`${label}: a same-origin hop keeps them`, async () => {
      reset();
      const res = await probeFetch(
        `http://127.0.0.1:${site.port}/same`,
        { headers: SECRET },
        typeof egress === "function" ? egress() : egress,
      );
      await res.text();
      const final = siteSeen.find((s) => s.path === "/final");
      expect(final?.apiKey).toBe("audit-secret");
      expect(final?.auth).toBe("Bearer audit-token");
    });
  }

  test("a redirect to a metadata address is refused, never requested", async () => {
    reset();
    await expect(
      probeFetch(`http://127.0.0.1:${site.port}/meta`, { headers: SECRET }, policy),
    ).rejects.toThrow();
  });
});

describe("cloaking probe", () => {
  const opts = (egress?: EgressPolicy) => ({
    maxPages: 1,
    recentDays: 14,
    queryVariation: false,
    googlebotUserAgent: "Googlebot",
    defaultUserAgent: "Browser",
    customHeaders: SECRET,
    headerScope: createHeaderScope(`http://127.0.0.1:${site.port}`),
    egress,
  });

  test("cross-origin redirect: the other host sees no custom headers", async () => {
    reset();
    await runCloakingProbe(
      [{ url: `http://127.0.0.1:${site.port}/cross`, reason: "orphan" }],
      opts(policy),
    );
    expect(siteSeen.length).toBeGreaterThan(0);
    expect(otherSeen.length).toBeGreaterThan(0);
    for (const seen of otherSeen) {
      expect(seen.apiKey).toBeNull();
      expect(seen.auth).toBeNull();
    }
  });

  test("same-origin redirect keeps the headers (LAN audit)", async () => {
    reset();
    await runCloakingProbe(
      [{ url: `http://127.0.0.1:${site.port}/same`, reason: "orphan" }],
      opts(policy),
    );
    const finals = siteSeen.filter((s) => s.path === "/final");
    expect(finals.length).toBeGreaterThan(0);
    for (const seen of finals) expect(seen.apiKey).toBe("audit-secret");
  });

  test("metadata redirect is inconclusive, not followed", async () => {
    reset();
    const [probe] = await runCloakingProbe(
      [{ url: `http://127.0.0.1:${site.port}/meta`, reason: "orphan" }],
      opts(policy),
    );
    expect(probe?.defaultStatus).toBe(0);
  });
});

describe("soft-404 confirmation", () => {
  const run = async (path: string) => {
    const url = `http://127.0.0.1:${site.port}${path}`;
    const parsed = parsePage(SHELL_HTML, url);
    await confirmSoft404Candidates([{ url, statusCode: 200, parsed }], {
      userAgent: "test-agent",
      customHeaders: SECRET,
      headerScope: createHeaderScope(`http://127.0.0.1:${site.port}`),
      egress: policy,
    });
    return parsed;
  };

  test("cross-origin redirect: the other host sees no custom headers", async () => {
    reset();
    await run("/cross");
    expect(otherSeen.length).toBeGreaterThan(0);
    expect(otherSeen[0]?.apiKey).toBeNull();
    expect(otherSeen[0]?.auth).toBeNull();
  });

  test("a LAN audit still confirms through a same-site redirect, headers kept", async () => {
    reset();
    const parsed = await run("/same");
    expect(siteSeen.find((s) => s.path === "/final")?.apiKey).toBe("audit-secret");
    expect(parsed.soft404Confirmation).toBeDefined();
    expect(parsed.soft404Confirmation).not.toBe("unconfirmed");
  });
});
