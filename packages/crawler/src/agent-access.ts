import { Effect } from "effect";
import { byteLength, truncateToBytes } from "@squirrelscan/utils/bytes";
import { readBodyCapped } from "@squirrelscan/utils/response-body";

import { BUDGET_EXHAUSTED_ERROR, budgetedTimeoutMs, safeFetchWithDeadline } from "./deadline";

import type { PhaseBudget } from "./deadline";
import type {
  AgentAccessData,
  AgentAccessProbe,
  AgentAccessUserAgent,
} from "@squirrelscan/core-contracts";

const PROBE_TIMEOUT_MS = 15_000;
const AGENT_ACCESS_MAX_BYTES = 512 * 1024;

// Realistic vendor UA strings so a site's bot rules trigger as they would in the wild.
const GPTBOT_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot";
const CLAUDE_USER_UA = "Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)";

interface ProbeIdentity {
  label: AgentAccessUserAgent;
  ua: string;
}

// Bot-challenge / interstitial markers. Returns the first signal that matched.
export function detectChallenge(headers: Headers, body: string): string | null {
  if (headers.get("cf-mitigated") === "challenge") return "cf-mitigated";
  const head = body.slice(0, 4_096);
  if (head.includes("challenge-platform")) return "challenge-platform";
  if (head.includes("__cf_chl_")) return "__cf_chl_";
  if (head.includes("Just a moment")) return "just-a-moment";
  return null;
}

// Pay-per-crawl / x402 payment-wall markers. Returns the first signal that matched.
export function detectPayment(status: number, headers: Headers, body: string): string | null {
  if (headers.has("crawler-price")) return "crawler-price";
  if (headers.has("crawler-charged")) return "crawler-charged";
  if (status === 402) {
    const head = body.slice(0, 4_096);
    if (head.includes("x402Version") || /"accepts"\s*:/.test(head)) return "x402-body";
    return "http-402";
  }
  const head = body.slice(0, 4_096);
  if (head.includes("x402Version")) return "x402-body";
  return null;
}

const unreachableProbe = (identity: ProbeIdentity, error: string): AgentAccessProbe => ({
  userAgent: identity.label,
  userAgentString: identity.ua,
  status: 0,
  bodySize: 0,
  challenged: false,
  challengeSignal: null,
  paymentRequired: false,
  paymentSignal: null,
  error,
});

async function probeOne(
  homeUrl: string,
  identity: ProbeIdentity,
  customHeaders?: Record<string, string>,
  budget?: PhaseBudget,
): Promise<AgentAccessProbe> {
  const timeoutMs = budgetedTimeoutMs(budget, PROBE_TIMEOUT_MS);
  if (timeoutMs === null) return unreachableProbe(identity, BUDGET_EXHAUSTED_ERROR);
  try {
    // #1395: manual redirects — per-hop scheme allowlist + strip secret
    // customHeaders on cross-origin redirects (native redirect:"follow" leaks them).
    // The probe identity's User-Agent is on the allowlist, so it survives the hop.
    return await safeFetchWithDeadline(
      homeUrl,
      {
        // A configured custom User-Agent (any casing) must not replace the probe
        // identity — the whole point is fetching as browser/GPTBot/Claude-User.
        headers: {
          Accept: "text/html,*/*",
          ...Object.fromEntries(
            Object.entries(customHeaders ?? {}).filter(([k]) => k.toLowerCase() !== "user-agent"),
          ),
          "User-Agent": identity.ua,
        },
        redirect: "follow",
      },
      timeoutMs,
      async (response) => {
        const raw = await readBodyCapped(response, AGENT_ACCESS_MAX_BYTES);
        const body = truncateToBytes(raw, AGENT_ACCESS_MAX_BYTES);
        const challengeSignal = detectChallenge(response.headers, body);
        const paymentSignal = detectPayment(response.status, response.headers, body);
        return {
          userAgent: identity.label,
          userAgentString: identity.ua,
          status: response.status,
          bodySize: byteLength(body),
          challenged: challengeSignal !== null,
          challengeSignal,
          paymentRequired: paymentSignal !== null,
          paymentSignal,
          error: null,
        };
      },
    );
  } catch (e) {
    return unreachableProbe(identity, (e as Error).message);
  }
}

// Fetch the homepage as a browser, GPTBot, and Claude-User once per audit so
// rules can compare access parity + spot bot-blocking / pay-per-crawl walls.
export function probeAgentAccess(
  baseUrl: string,
  browserUserAgent: string,
  customHeaders?: Record<string, string>,
  budget?: PhaseBudget,
): Effect.Effect<AgentAccessData, never, never> {
  const homeUrl = new URL("/", baseUrl).toString();
  const identities: ProbeIdentity[] = [
    { label: "browser", ua: browserUserAgent },
    { label: "gptbot", ua: GPTBOT_UA },
    { label: "claude-user", ua: CLAUDE_USER_UA },
  ];
  return Effect.promise(async () => {
    const probes = await Promise.all(
      identities.map((id) => probeOne(homeUrl, id, customHeaders, budget)),
    );
    return { probes };
  });
}
