// The agent setup prompt, shared by the docs (docs/agent-setup) and the
// website hero and closing CTA, so every surface hands out the same line and
// shows the same button. Styles live beside this file in agent-prompt.css.

export const AGENT_SETUP_PAGE_URL = "https://docs.squirrelscan.com/agent-setup";
export const AGENT_SETUP_PROMPT_URL = "https://docs.squirrelscan.com/agent-setup/prompt.md";

/** Template form, for copy buttons that resolve `{{url}}` themselves. */
export const AGENT_SETUP_PROMPT_TEMPLATE =
  "Fetch and follow the setup instructions for squirrelscan at {{url}}";

export const AGENT_SETUP_PROMPT = AGENT_SETUP_PROMPT_TEMPLATE.replace(
  "{{url}}",
  AGENT_SETUP_PROMPT_URL,
);

/** Label on the copy button. The prompt itself is not shown: the button copies it. */
export const AGENT_SETUP_LABEL = "Onboard your agent to squirrelscan";

export interface AgentSetupIcon {
  name: string;
  /** Path under the host's public root; both docs and web serve /logo/agents/. */
  src: string;
}

/** The agent marks on the copy button, in display order. */
export const AGENT_SETUP_ICONS: readonly AgentSetupIcon[] = [
  { name: "Claude Code", src: "/logo/agents/claude-code.png" },
  { name: "Codex", src: "/logo/agents/codex.png" },
  { name: "Cursor", src: "/logo/agents/cursor.png" },
  { name: "opencode", src: "/logo/agents/opencode.png" },
];
