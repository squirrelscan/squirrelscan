// The agent setup pointer printed after a successful `squirrel auth login`
// (#180). The browser callback page offers the same prompt; both read it from
// AGENT_SETUP_PROMPT so the two surfaces can never drift. Headless and SSH
// users only ever see this one.

import { AGENT_SETUP_PROMPT, AGENT_SETUP_URL } from "@/constants";

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
