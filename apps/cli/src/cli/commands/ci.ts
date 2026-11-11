// squirrel ci - audit a deployed URL in the cloud and fail on findings new since the previous audit
//
// Starts a cloud run for a website (so it appears in that website's audit history), waits for it,
// and exits 2 when the comparison with the previous completed audit has new findings at or above
// --fail-on-new. The flow lives in `@/ci/new-findings-gate`; this file is arguments and wiring.

import { defineCommand } from "citty";

import {
  type GateDeps,
  FAIL_ON_SEVERITIES,
  isFailOnSeverity,
  runNewFindingsGate,
} from "@/ci/new-findings-gate";
import { warnIfSessionUnreadable } from "@/self/credentials";
import { safeExit } from "@/self/updater";

const DEFAULT_TIMEOUT_MINUTES = 30;
const POLL_INTERVAL_MS = 5000;
/** One API call's timeout: the start call dispatches a crawler, so it gets longer than a read. */
const REQUEST_TIMEOUT_MS = 60_000;

export const ci = defineCommand({
  meta: {
    name: "ci",
    description:
      "Audit a deployed URL in the cloud and fail on findings new since the previous audit",
  },
  args: {
    url: {
      type: "positional",
      description: "The deployed URL to audit",
      required: true,
    },
    website: {
      type: "string",
      description:
        "The website id the audit belongs to (its history is the baseline)",
      required: true,
    },
    "fail-on-new": {
      type: "string",
      description: `Fail when there are new findings at or above this severity: ${FAIL_ON_SEVERITIES.join(", ")}`,
      default: "error",
    },
    "max-pages": {
      type: "string",
      description: "Page limit for the cloud audit",
    },
    timeout: {
      type: "string",
      description: `Minutes to wait for the audit (default ${DEFAULT_TIMEOUT_MINUTES})`,
    },
    json: {
      type: "boolean",
      description: "Print the result as one JSON object on stdout",
    },
  },
  async run({ args }) {
    const failOn = String(args["fail-on-new"] ?? "error");
    if (!isFailOnSeverity(failOn)) {
      console.error(
        `squirrel ci: --fail-on-new must be one of ${FAIL_ON_SEVERITIES.join(", ")} (got "${failOn}")`
      );
      return safeExit(1);
    }

    let url: URL;
    try {
      url = new URL(String(args.url));
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("not http(s)");
    } catch {
      console.error(`squirrel ci: "${String(args.url)}" is not an http(s) URL`);
      return safeExit(1);
    }

    const websiteId = String(args.website ?? "").trim();
    if (!websiteId) {
      console.error("squirrel ci: --website <id> is required");
      return safeExit(1);
    }

    const positiveInt = (
      raw: unknown,
      flag: string
    ): number | undefined | null => {
      if (raw === undefined) return undefined;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        console.error(
          `squirrel ci: --${flag} must be a whole number of at least 1`
        );
        return null;
      }
      return n;
    };
    const maxPages = positiveInt(args["max-pages"], "max-pages");
    const timeoutMinutes = positiveInt(args.timeout, "timeout");
    if (maxPages === null || timeoutMinutes === null) return safeExit(1);

    warnIfSessionUnreadable();
    const { resolveCredential } = await import("@/self/credentials");
    if (!resolveCredential()) {
      console.error(
        "squirrel ci: no credential. Set SQUIRRELSCAN_API_KEY to an org API key with the audits:read and audits:write scopes."
      );
      return safeExit(1);
    }

    const { cliApi } = await import("@/lib/api-client");
    const deps: GateDeps = {
      request: (method, path, body) =>
        cliApi.request(path, {
          method,
          auth: "required",
          timeoutMs: REQUEST_TIMEOUT_MS,
          ...(body !== undefined ? { body } : {}),
        }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    };

    const result = await runNewFindingsGate(deps, {
      url: url.toString(),
      websiteId,
      failOn,
      ...(maxPages !== undefined ? { maxPages } : {}),
      timeoutMs: (timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000,
      pollIntervalMs: POLL_INTERVAL_MS,
      json: Boolean(args.json),
    });
    return safeExit(result.code);
  },
});
