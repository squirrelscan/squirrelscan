// auth login — actionable error hints (#1 of the auth/cloud guardrails).

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentSetupLines } from "@/cli/agent-setup";
import { AGENT_SETUP_PROMPT, AGENT_SETUP_URL } from "@/constants";
import {
  localApiHint,
  normalizeBrowserUrl,
  renderAuthSuccessPage,
  renderCallbackPage,
  type SessionStatusResponse,
} from "@/controllers/auth/login";
import { DEFAULT_API_URL } from "@/self/api";

describe("auth/login — localApiHint", () => {
  test("points local/dev targets at the production override", () => {
    for (const url of [
      "https://api.squirrelscan.localhost",
      "http://localhost:4001",
      "http://127.0.0.1:8787/v1",
      "http://[::1]:8787/v1",
    ]) {
      const hint = localApiHint(url);
      expect(hint).toContain(`SQUIRREL_API_SERVER=${DEFAULT_API_URL}`);
      expect(hint).toContain("local API may be down");
    }
  });

  test("is empty for a production/remote target (no misleading hint)", () => {
    for (const url of [
      DEFAULT_API_URL,
      "https://api.squirrelscan.com",
      "https://api.example.com",
    ]) {
      expect(localApiHint(url)).toBe("");
    }
  });
});

describe("auth/login — browser URL validation", () => {
  test("accepts HTTP(S) authentication URLs", () => {
    expect(normalizeBrowserUrl("https://example.com/login?a=1")).toBe(
      "https://example.com/login?a=1"
    );
  });

  test("rejects shell-like and executable URL schemes", () => {
    expect(() => normalizeBrowserUrl("javascript:alert(1)")).toThrow(
      "must use HTTP or HTTPS"
    );
    expect(() => normalizeBrowserUrl("file:///tmp/payload")).toThrow(
      "must use HTTP or HTTPS"
    );
  });
});

describe("auth/login — agent setup on the callback success page (#180)", () => {
  const page = renderAuthSuccessPage("dev@example.com");

  test("offers the prompt, a copy button and the docs link", () => {
    expect(page).toContain("Use squirrelscan with your AI agent");
    expect(page).toContain(">Copy prompt<");
    expect(page).toContain(`href="${AGENT_SETUP_URL}"`);
    expect(page).toContain("view the agent setup");
  });

  test("prints the prompt as a plain text node, copyable without JS at all", () => {
    expect(page).toContain(
      `<code id="agent-prompt">${AGENT_SETUP_PROMPT}</code>`
    );
  });

  test("falls back to selecting that text when the clipboard API is missing", () => {
    // Guarded call, then a selection of the prompt node: neither a bare
    // navigator.clipboard.writeText() nor a silent no-op on refusal.
    expect(page).toContain(
      "navigator.clipboard && navigator.clipboard.writeText"
    );
    expect(page).toContain("range.selectNodeContents(prompt)");
    expect(page).toContain("Press ctrl+c");
  });

  test("carries the prompt exactly once, never as a script string literal", () => {
    // The inline script reads prompt.textContent instead, so the constant is
    // never parsed in JS context. Interpolating it into the script would
    // reintroduce the injection surface this asserts away.
    expect(page.split(AGENT_SETUP_PROMPT)).toHaveLength(2);
    expect(page).toContain("prompt.textContent");
  });

  test("escapes the email rather than trusting the API response", () => {
    const hostile = renderAuthSuccessPage(
      'evil"<img src=x onerror=alert(1)>@example.com'
    );
    expect(hostile).not.toContain("<img");
    expect(hostile).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(hostile).toContain("evil&quot;");
  });

  test("only a completed sign-in with a token gets the block", () => {
    const bare: SessionStatusResponse[] = [
      { status: "pending" },
      { status: "expired" },
      { status: "consumed" },
      // "completed" with no token yet is still a wait, not a sign-in.
      { status: "completed" },
    ];
    for (const status of bare) {
      const { html } = renderCallbackPage(status);
      expect(html).not.toContain("Use squirrelscan with your AI agent");
      expect(html).not.toContain(AGENT_SETUP_PROMPT);
    }

    const done = renderCallbackPage({
      status: "completed",
      token: "tok",
      user: { id: "u1", email: "dev@example.com", name: null },
    });
    expect(done.code).toBe(200);
    expect(done.html).toContain(AGENT_SETUP_PROMPT);
  });

  test("serves the same status codes and pages as before for the rest", () => {
    expect(renderCallbackPage({ status: "expired" })).toMatchObject({
      code: 410,
    });
    expect(renderCallbackPage({ status: "expired" }).html).toContain(
      "Session Expired"
    );
    expect(renderCallbackPage({ status: "consumed" })).toMatchObject({
      code: 410,
    });
    expect(renderCallbackPage({ status: "consumed" }).html).toContain(
      "Login Session Already Used"
    );
    const pending = renderCallbackPage({ status: "pending" });
    expect(pending.code).toBe(202);
    expect(pending.html).toContain("Waiting for authentication...");
    // The pending page reloads itself; that is what makes polling work.
    expect(pending.html).toContain('http-equiv="refresh"');
  });
});

/**
 * Load the page's own inline script as a real module, wrapped so its three
 * globals arrive as parameters. Nothing is interpolated into `script`: it is
 * sliced straight out of the rendered page. (A data: URL would be tidier, but
 * Bun's resolver rejects one this long with NameTooLong.)
 *
 * Its own directory per call, so a parallel run cannot delete the file out
 * from under another import, and each call gets a fresh module rather than a
 * path-cached one.
 */
async function loadPageScript(
  script: string
): Promise<{ boot: (w: unknown, d: unknown, n: unknown) => void }> {
  const dir = await mkdtemp(join(tmpdir(), "squirrel-auth-page-"));
  try {
    const file = join(dir, "page.mjs");
    await Bun.write(
      file,
      `export function boot(window, document, navigator) {${script}}`
    );
    return (await import(file)) as {
      boot: (w: unknown, d: unknown, n: unknown) => void;
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Runs the page's own inline script against a stub DOM and clicks the button,
 * so the copy path is exercised rather than grepped for. `clipboard` picks
 * which browser the button meets: one that copies, one that refuses (Safari
 * outside a user gesture, a page without permission), and one with no
 * clipboard API at all.
 */
async function clickCopyPrompt(opts: {
  clipboard: "ok" | "refuses" | "absent";
  execCommand: boolean;
}): Promise<{
  copied: string | null;
  status: string;
  selected: string | null;
}> {
  const page = renderAuthSuccessPage("dev@example.com");
  const script = page.slice(
    page.indexOf("<script>") + "<script>".length,
    page.indexOf("</script>")
  );

  let copied: string | null = null;
  let clicked: (() => void) | undefined;
  const node = (text: string) => ({
    textContent: text,
    addEventListener: (_type: string, fn: () => void) => {
      clicked = fn;
    },
  });
  const prompt = node(AGENT_SETUP_PROMPT);
  const button = node("Copy prompt");
  const status = node("");

  const selection = {
    range: null as { node: typeof prompt | null } | null,
    removeAllRanges() {
      this.range = null;
    },
    addRange(range: { node: typeof prompt | null }) {
      this.range = range;
    },
  };
  const win = { getSelection: () => selection };
  const doc = {
    getElementById: (id: string) =>
      ({
        "agent-prompt": prompt,
        "copy-prompt": button,
        "copy-status": status,
      })[id],
    createRange: () => {
      const range: {
        node: typeof prompt | null;
        selectNodeContents(n: typeof prompt): void;
      } = {
        node: null,
        selectNodeContents(n) {
          range.node = n;
        },
      };
      return range;
    },
    execCommand: (command: string) => {
      if (!opts.execCommand) throw new Error("execCommand is not a function");
      if (command !== "copy" || !selection.range?.node) return false;
      copied = selection.range.node.textContent;
      return true;
    },
  };
  const nav =
    opts.clipboard === "absent"
      ? {}
      : {
          clipboard: {
            writeText: (text: string) => {
              if (opts.clipboard === "refuses") {
                return Promise.reject(new Error("NotAllowedError"));
              }
              copied = text;
              return Promise.resolve();
            },
          },
        };

  const { boot } = await loadPageScript(script);
  boot(win, doc, nav);
  clicked?.();
  await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    copied,
    status: status.textContent,
    selected: selection.range?.node?.textContent ?? null,
  };
}

describe("auth/login — the copy prompt button (#180)", () => {
  test("copies the prompt when the clipboard API is available", async () => {
    const result = await clickCopyPrompt({
      clipboard: "ok",
      execCommand: true,
    });
    expect(result.copied).toBe(AGENT_SETUP_PROMPT);
    expect(result.status).toBe("Copied.");
  });

  test("falls back to execCommand when the clipboard API refuses", async () => {
    const result = await clickCopyPrompt({
      clipboard: "refuses",
      execCommand: true,
    });
    expect(result.copied).toBe(AGENT_SETUP_PROMPT);
    expect(result.selected).toBe(AGENT_SETUP_PROMPT);
  });

  test("selects the prompt and says so when nothing can copy for you", async () => {
    const result = await clickCopyPrompt({
      clipboard: "absent",
      execCommand: false,
    });
    expect(result.copied).toBeNull();
    // The user is not left staring at a dead button: the text is selected and
    // the status names the keystroke.
    expect(result.selected).toBe(AGENT_SETUP_PROMPT);
    expect(result.status).toContain("Press ctrl+c");
  });
});

describe("auth login — agent setup in the terminal (#180)", () => {
  const output = agentSetupLines().join("\n");

  test("prints the same prompt constant the browser page shows", () => {
    expect(output).toContain(AGENT_SETUP_PROMPT);
    expect(output).toContain(AGENT_SETUP_URL);
  });

  test("names it as something to paste, so SSH users know what it is for", () => {
    expect(output).toContain("paste this prompt");
  });
});
