// The cloud link checker refuses to request a link whose public-looking name
// resolves to a private address, and says so with `egressRefused` (sent with
// `wafBlocked`, so an older CLI reads the link as unverifiable). This CLI
// checks such a link itself, under the audit's own egress policy: an audit of
// a site on a private network reaches it, a public site's audit refuses it
// locally too. The refusal itself is never a broken link (squirrelscan/repo#2873).

import type { EgressPolicy } from "@squirrelscan/utils/public-egress";

import { checkExternalLinks } from "@squirrelscan/audit-engine/external-checker";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { resolveDeadLinksBulkChecker } from "@/audit/cloud";
import { getDefaultConfig } from "@/config";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

let requested: string[] = [];

/** A link target on loopback, named by a public-looking name that resolves there. */
function serveTarget(): string {
  requested = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      requested.push(new URL(req.url).pathname);
      return new Response("target", { status: 200 });
    },
  });
  servers.push(server);
  return `http://intranet-app.example.com:${server.port}`;
}

/** The cloud's answer for a link it refused to request, as a current server sends it. */
const refused = (url: string, flag = true) => ({
  url,
  ok: false,
  status: null,
  error: null,
  redirectUrl: null,
  fromCache: false,
  wafBlocked: true,
  wafProvider: "unknown",
  unverifiedReason: "unreachable",
  ...(flag ? { egressRefused: true } : {}),
});

async function check(
  url: string,
  answer: (url: string) => object,
  egress: EgressPolicy
) {
  const spend: Array<[number, number]> = [];
  const client = {
    deadLinks: async (req: { urls: string[] }) => ({
      results: req.urls.map((u) => answer(u)),
      charged: 0,
    }),
  } as never;
  const config = getDefaultConfig();
  config.cloud.enabled = true;
  const checker = await resolveDeadLinksBulkChecker({
    client,
    config,
    auditId: "audit-1",
    externalLinkCount: 1,
    getRunId: () => "run-1",
    onSpend: (units, credits) => spend.push([units, credits]),
  });
  expect(checker).not.toBeNull();
  const [result] = await Effect.runPromise(
    checkExternalLinks([url], null, {
      concurrency: 1,
      timeoutMs: config.external_links.timeout_ms,
      userAgent: "squirrel-test",
      bulkChecker: checker!,
      egress,
    })
  );
  return { result, spend };
}

const resolveToLoopback = async () => ["127.0.0.1"];

describe("a link the cloud refused to request (egressRefused)", () => {
  test("an audit of a site on a private network checks it locally, with its own status", async () => {
    const url = `${serveTarget()}/page`;
    const { result, spend } = await check(url, refused, {
      allowPrivateNetwork: true,
      resolve: resolveToLoopback,
    });
    expect(result?.status).toBe(200);
    expect(result?.wafBlocked).toBeUndefined();
    expect(requested).toEqual(["/page"]);
    // Not an answer the service gave, so not counted as one.
    expect(spend).toEqual([[0, 0]]);
  });

  test("a public site's audit refuses it locally too: never requested, never broken", async () => {
    const url = `${serveTarget()}/page`;
    const { result } = await check(url, refused, {
      allowPrivateNetwork: false,
      resolve: resolveToLoopback,
    });
    expect(requested).toEqual([]);
    // Refused by this audit's own policy: reported as not requested, not broken.
    expect(result).toMatchObject({ refused: true, status: null, error: null });
  });

  test("an answer without the flag (an older server) stays unverifiable, and is not re-checked", async () => {
    const url = `${serveTarget()}/page`;
    const { result, spend } = await check(url, (u) => refused(u, false), {
      allowPrivateNetwork: true,
      resolve: resolveToLoopback,
    });
    expect(result?.wafBlocked).toBe(true);
    expect(result?.unverifiedReason).toBe("unreachable");
    expect(result?.status).toBeNull();
    expect(requested).toEqual([]);
    expect(spend).toEqual([[1, 0]]);
  });
});
