import { describe, expect, test } from "bun:test";

import {
  AGENT_PILL_COPIED,
  AGENT_PILL_COPY,
  AGENT_PILL_ICON_CHECK,
  AGENT_PILL_ICON_COPY,
  AGENT_PILL_LABEL,
  AGENT_PILL_MARKS,
} from "../components/agent-pill";

const docs = new URL("../", import.meta.url);
const read = (path: string) => Bun.file(new URL(path, docs)).text();

// The pill has ONE definition (components/agent-pill.ts + onboard.css), used by
// the docs' CopyPrompt shadow and by apps/web in the private monorepo. These
// tests fail if a second copy of the styles or the copy appears here.
describe("agent pill single source", () => {
  test("CopyPrompt shadow renders the shared constants, not literals", async () => {
    const astro = await read("components/CopyPrompt.astro");
    for (const name of [
      "AGENT_PILL_LABEL",
      "AGENT_PILL_COPY",
      "AGENT_PILL_COPIED",
      "AGENT_PILL_MARKS",
      "AGENT_PILL_ICON_COPY",
      "AGENT_PILL_ICON_CHECK",
    ]) {
      expect(astro).toContain(name);
    }
    expect(astro).not.toContain(AGENT_PILL_LABEL);
    expect(astro).not.toContain("/logo/agents/");
  });

  test("onboard.css styles only the shared markup (no tangly built-in selectors)", async () => {
    const css = await read("onboard.css");
    expect(css).not.toContain("tangly-copy-prompt");
    for (const cls of ["sq-onboard-label", "sq-onboard-marks", "sq-onboard-copy"]) {
      expect(css).toContain(`.${cls}`);
    }
  });

  test("no page carries its own pill markup or label", async () => {
    for (const page of ["index.mdx", "quickstart.mdx", "agent-setup/index.mdx"]) {
      const mdx = await read(page);
      expect(mdx).toContain("<CopyPrompt ");
      expect(mdx).not.toContain("sq-onboard");
      expect(mdx).not.toContain("icons=");
      expect(mdx).not.toContain("label=");
    }
  });

  test("shared copy reads as specified", () => {
    expect(AGENT_PILL_COPY).toBe("Copy prompt");
    expect(AGENT_PILL_COPIED).toBe("Copied");
    expect(AGENT_PILL_MARKS.length).toBe(4);
    expect(AGENT_PILL_ICON_COPY.length).toBeGreaterThan(0);
    expect(AGENT_PILL_ICON_CHECK.length).toBeGreaterThan(0);
  });
});
