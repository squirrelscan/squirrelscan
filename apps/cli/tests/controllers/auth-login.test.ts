// auth login — actionable error hints (#1 of the auth/cloud guardrails).

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentSetupLines } from "@/cli/agent-setup";
import { AGENT_SETUP_PROMPT, AGENT_SETUP_URL } from "@/constants";
import {
  AUTH_SUCCESS_PAGE_SCRIPT,
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
    expect(page).toContain("View the agent setup");
  });

  test("prints the prompt as a plain text node, copyable without JS at all", () => {
    expect(page).toContain(
      `<code id="agent-prompt">${AGENT_SETUP_PROMPT}</code>`
    );
  });

  test("ships the exact script the tests drive, not a copy of it", () => {
    // Byte-identity between the page and AUTH_SUCCESS_PAGE_SCRIPT is what
    // makes the behavioural tests below evidence about the shipped page.
    expect(page).toContain(AUTH_SUCCESS_PAGE_SCRIPT);
    expect(page).toContain(`<script>${AUTH_SUCCESS_PAGE_SCRIPT}</script>`);
  });

  test("renders exactly the ids its script asks for", () => {
    for (const id of [PROMPT_ID, BUTTON_ID, STATUS_ID]) {
      expect(page).toContain(`id="${id}"`);
      expect(AUTH_SUCCESS_PAGE_SCRIPT).toContain(`getElementById("${id}")`);
    }
  });

  test("carries the prompt exactly once, never as a script string literal", () => {
    // The inline script reads prompt.textContent instead, so the constant is
    // never parsed in JS context. Interpolating it into the script would
    // reintroduce the injection surface this asserts away.
    expect(page.split(AGENT_SETUP_PROMPT)).toHaveLength(2);
    expect(AUTH_SUCCESS_PAGE_SCRIPT).toContain("prompt.textContent");
    expect(AUTH_SUCCESS_PAGE_SCRIPT).not.toContain(AGENT_SETUP_PROMPT);
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
      "Session expired"
    );
    expect(renderCallbackPage({ status: "consumed" })).toMatchObject({
      code: 410,
    });
    expect(renderCallbackPage({ status: "consumed" }).html).toContain(
      "This sign-in link was already used"
    );
    const pending = renderCallbackPage({ status: "pending" });
    expect(pending.code).toBe(202);
    expect(pending.html).toContain("Waiting for authentication...");
    // The pending page reloads itself; that is what makes polling work.
    expect(pending.html).toContain('http-equiv="refresh"');
  });
});

describe("auth/login - the branded callback pages (#1286)", () => {
  const completed = (email: string) =>
    renderCallbackPage({
      status: "completed",
      token: "tok",
      user: { id: "u1", email, name: null },
    }).html;
  const pages: Record<string, string> = {
    success: completed("dev@example.com"),
    expired: renderCallbackPage({ status: "expired" }).html,
    consumed: renderCallbackPage({ status: "consumed" }).html,
    pending: renderCallbackPage({ status: "pending" }).html,
  };

  for (const [name, html] of Object.entries(pages)) {
    describe(name, () => {
      test("wears the shell: mark, wordmark, viewport, both colour schemes", () => {
        expect(html).toContain("<svg");
        expect(html).toContain("<span>squirrelscan</span>");
        expect(html).toContain('name="viewport"');
        expect(html).toContain("prefers-color-scheme: dark");
        expect(html).toContain('<html lang="en">');
      });

      test("loads nothing: no links, scripts by src, imports, images or remote urls", () => {
        expect(html).not.toMatch(/<link\b/i);
        expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
        expect(html).not.toMatch(/<img\b/i);
        expect(html).not.toMatch(/@import/i);
        expect(html).not.toMatch(/url\(/i);
        // The only absolute URLs are the setup link, the prompt text and the SVG namespace (never fetched).
        const urls = html.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
        for (const url of urls) {
          expect([
            AGENT_SETUP_URL,
            `${AGENT_SETUP_URL}/prompt.md`,
            "http://www.w3.org/2000/svg",
          ]).toContain(url);
        }
      });

      test("pins the same with a CSP, and only the page's own script is allowed", () => {
        const csp =
          /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(
            html
          )?.[1];
        expect(csp).toBeDefined();
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("base-uri 'none'");
        if (name === "success") {
          // The hash of the bytes the page emits, not of the constant it was built from.
          const emitted = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
          expect(emitted).toBeDefined();
          const hash = createHash("sha256").update(emitted!).digest("base64");
          expect(csp).toContain(`script-src 'sha256-${hash}'`);
        } else {
          expect(csp).toContain("script-src 'none'");
          expect(html).not.toContain("<script>");
        }
      });

      test("copy: no em-dashes, lowercase product name, sentence case headings", () => {
        expect(html).not.toContain("\u2014");
        expect(html).not.toMatch(/Squirrelscan|SquirrelScan/);
        for (const heading of html.match(/<h[12]>([^<]+)<\/h[12]>/g) ?? []) {
          const text = heading.slice(4, -5); // between <hN> and </hN>
          // Sentence case: no word after the first starts with a capital, bar names.
          expect(
            text
              .split(" ")
              .slice(1)
              .filter((w) => /^[A-Z]/.test(w) && w !== "AI")
          ).toEqual([]);
        }
      });
    });
  }

  test("a hostile email cannot inject markup, attributes or script", () => {
    const hostile = completed(
      `</strong><script>alert(1)</script><img src=x onerror=alert(2)>"'@example.com`
    );
    expect(hostile).not.toContain("<img");
    expect(hostile.match(/<script\b/gi)).toHaveLength(1);
    expect(hostile).not.toContain("alert(1)</script>");
    expect(hostile).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(hostile).toContain("&quot;&#39;@example.com");
  });

  test("the email is the only interpolated value: the rest of the page is the same for any email", () => {
    const strip = (html: string, email: string) => html.replace(email, "EMAIL");
    expect(strip(completed("a@example.com"), "a@example.com")).toBe(
      strip(completed("bb@example.org"), "bb@example.org")
    );
  });

  test("the waiting page still reloads itself, the others do not", () => {
    expect(pages.pending).toContain('<meta http-equiv="refresh" content="1">');
    expect(pages.expired).not.toContain('http-equiv="refresh"');
    expect(pages.success).not.toContain('http-equiv="refresh"');
  });
});

describe("auth/login - callback response headers (#1286)", () => {
  const statuses: Array<[string, SessionStatusResponse]> = [
    [
      "success",
      {
        status: "completed",
        token: "tok",
        user: { id: "u1", email: "dev@example.com", name: null },
      },
    ],
    ["expired", { status: "expired" }],
    ["consumed", { status: "consumed" }],
    ["pending", { status: "pending" }],
  ];

  for (const [name, status] of statuses) {
    test(`${name}: security headers on the response`, () => {
      const { html, headers } = renderCallbackPage(status);
      expect(headers["Content-Type"]).toBe("text/html; charset=utf-8");
      expect(headers["X-Frame-Options"]).toBe("DENY");
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["Referrer-Policy"]).toBe("no-referrer");
      expect(headers["Cache-Control"]).toBe("no-store");
      const csp = headers["Content-Security-Policy"]!;
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("default-src 'none'");
      // The header and the page's meta policy agree on the script source, so
      // both together allow exactly the page's own script (or none).
      const meta =
        /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(
          html
        )?.[1];
      const scriptSrc = (policy: string) =>
        /script-src [^;]+/.exec(policy)?.[0];
      expect(scriptSrc(csp)).toBe(scriptSrc(meta!));
      expect(meta).not.toContain("frame-ancestors");
      expect(html).toContain('<meta name="referrer" content="no-referrer">');
    });
  }

  test("the real loopback server sends them on 200, 410, 404 and 500 responses", async () => {
    const { startCallbackServer } = await import("@/controllers/auth/login");
    const { createServer } = await import("node:net");
    const freePort = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const port = (probe.address() as { port: number }).port;
        probe.close(() => resolve(port));
      });
    });
    let apiStatus: Record<string, unknown> | "down" = {
      status: "completed",
      token: "tok",
      user: { id: "u1", email: "dev@example.com", name: null },
    };
    const api = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        apiStatus === "down"
          ? new Response("nope", { status: 500 })
          : Response.json(apiStatus),
    });
    const callback = startCallbackServer(
      freePort,
      "session",
      "verifier",
      `http://127.0.0.1:${api.port}`,
      () => {},
      () => {}
    );
    try {
      const get = (path: string) =>
        fetch(`http://127.0.0.1:${freePort}${path}`);
      const expectHardened = (res: Response, type: string) => {
        expect(res.headers.get("content-type")).toBe(type);
        expect(res.headers.get("x-frame-options")).toBe("DENY");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("referrer-policy")).toBe("no-referrer");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("content-security-policy")).toContain(
          "frame-ancestors 'none'"
        );
      };
      const ok = await get("/callback");
      expect(ok.status).toBe(200);
      expectHardened(ok, "text/html; charset=utf-8");
      // The script the CSP header allows is the one the page emits.
      const html = await ok.text();
      const emitted = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
      expect(ok.headers.get("content-security-policy")).toContain(
        `'sha256-${createHash("sha256").update(emitted).digest("base64")}'`
      );

      apiStatus = { status: "expired" };
      const gone = await get("/callback");
      expect(gone.status).toBe(410);
      expectHardened(gone, "text/html; charset=utf-8");

      expectHardened(await get("/elsewhere"), "text/plain; charset=utf-8");
      const missing = await get("/elsewhere");
      expect(missing.status).toBe(404);

      apiStatus = "down";
      const broken = await get("/callback");
      expect(broken.status).toBe(500);
      expectHardened(broken, "text/plain; charset=utf-8");
    } finally {
      callback.close();
      void api.stop(true);
    }
  });
});

/**
 * The ids the page's script reaches for. Kept here so the stub DOM below can
 * refuse anything else; `renders exactly the ids its script asks for` ties
 * them back to the markup, so renaming one in the page fails loudly instead
 * of handing the script an undefined node.
 */
const PROMPT_ID = "agent-prompt";
const BUTTON_ID = "copy-prompt";
const STATUS_ID = "copy-status";

/**
 * Load the page's own inline script as a real module, wrapped so its three
 * globals arrive as parameters. The source is AUTH_SUCCESS_PAGE_SCRIPT itself,
 * imported from the controller: no slicing or re-parsing of rendered HTML, so
 * what runs here is byte-identical to what the page serves. (A data: URL would
 * be tidier, but Bun's resolver rejects one this long with NameTooLong.)
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
  const elements: Record<string, typeof prompt> = {
    [PROMPT_ID]: prompt,
    [BUTTON_ID]: button,
    [STATUS_ID]: status,
  };
  const doc = {
    getElementById: (id: string) => {
      // Loud, not undefined: an id the page renamed would otherwise surface as
      // a confusing "cannot read textContent of undefined" three frames later.
      const element = elements[id];
      if (!element) throw new Error(`script asked for unstubbed id: ${id}`);
      return element;
    },
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

  const { boot } = await loadPageScript(AUTH_SUCCESS_PAGE_SCRIPT);
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
    // The live region reports the same success as the clipboard path: a copy
    // that worked must never look like one that only selected the text.
    expect(result.status).toBe("Copied.");
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
