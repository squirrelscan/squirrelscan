// The "Onboard your agent" pill: the one definition of its copy, marks and
// icons. The docs' <CopyPrompt> (components/CopyPrompt.astro) and the website's
// AgentSetupPrompt (apps/web in the private monorepo) both import this file and
// ../onboard.css, so the two cannot drift: change the pill here, not there.

export const AGENT_PILL_LABEL = "Onboard your agent to squirrelscan";
export const AGENT_PILL_COPY = "Copy prompt";
export const AGENT_PILL_COPIED = "Copied";
export const AGENT_PILL_TITLE = "Copies a one-line prompt that sets your agent up for squirrelscan";
// How long the pill reads "Copied" before it reverts.
export const AGENT_PILL_COPIED_MS = 2000;

// Site-root paths: the docs and the website both serve /logo/agents/*.
export const AGENT_PILL_MARKS = [
  "/logo/agents/claude-code.png",
  "/logo/agents/codex.png",
  "/logo/agents/cursor.png",
  "/logo/agents/opencode.png",
] as const;

// 24x24 stroke icons (lucide "copy" and "check"), as path data so React and
// Astro render the same SVG.
export const AGENT_PILL_ICON_COPY = [
  "M8 8m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z",
  "M16 8v-2a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2",
] as const;
export const AGENT_PILL_ICON_CHECK = ["M5 12l5 5l10 -10"] as const;
