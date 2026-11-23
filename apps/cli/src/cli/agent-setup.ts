// The agent setup pointer printed after a successful `squirrel auth login`
// (#180). The browser callback page offers the same prompt; both read it from
// AGENT_SETUP_PROMPT so the two surfaces can never drift. Headless and SSH
// users only ever see this one.

import {
  AGENT_SETUP_PROMPT,
  AGENT_SETUP_URL,
  DASHBOARD_URL,
} from "@/constants";

import { fmt } from "./format";

/** Lines to print after sign-in, in order. Pure: the caller does the I/O. */
export function agentSetupLines(): string[] {
  return [
    "",
    "Set up your coding agent: paste this prompt into it.",
    `  ${fmt.cyan(AGENT_SETUP_PROMPT)}`,
    fmt.dim(`  Or read it yourself first: ${AGENT_SETUP_URL}`),
  ];
}

/**
 * Pointer to the dashboard onboarding (repo#4976). Plain text only: no prompt,
 * no browser launch, so non-interactive and --yes runs print it and move on.
 * The dashboard detects the first CLI sign-in or published audit by itself.
 */
export function dashboardHandoffLines(): string[] {
  return [
    "",
    `Finish onboarding in the dashboard: ${fmt.cyan(DASHBOARD_URL)}`,
    fmt.dim(
      "  It picks up your sign-in and your first published audit on its own."
    ),
  ];
}
