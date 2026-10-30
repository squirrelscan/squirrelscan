// Auth login controller - browser OAuth flow

import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { hostname } from "node:os";

import { AGENT_SETUP_PROMPT, AGENT_SETUP_URL } from "@/constants";
import {
  callbackResponseHeaders,
  escapeHtml,
  renderCallbackShell,
} from "@/controllers/auth/callback-page";
import { type Result, ok, err, commandError } from "@/controllers/types";
import { cliApi } from "@/lib/api-client";
import { openBrowser } from "@/lib/browser";
import { DEFAULT_API_URL, getApiUrl } from "@/self/api";
import { loadUserSettings, updateSettings } from "@/self/settings";
import { trackFirstRunEvent } from "@/self/telemetry";

/**
 * When sign-in targets a local/dev API (which may simply not be running),
 * point the user at the production override so the error is actionable.
 */
export function localApiHint(apiUrl: string): string {
  return /localhost|127\.0\.0\.1|::1/.test(apiUrl)
    ? ` The local API may be down — set SQUIRREL_API_SERVER=${DEFAULT_API_URL} to use production.`
    : "";
}

/**
 * Generate PKCE code verifier and challenge
 * The verifier is kept secret by the CLI, only the challenge (SHA-256 hash) is sent to API
 */
function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("hex"); // 64 hex chars
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("hex");
  return { codeVerifier, codeChallenge };
}

/**
 * The success page's inline script (#180), exported so the tests drive the
 * exact source the page ships instead of re-deriving it from the rendered
 * HTML. It reads the prompt out of the DOM via textContent, so no value is
 * ever interpolated into script context; keep it that way.
 */
export const AUTH_SUCCESS_PAGE_SCRIPT = `
                (function () {
                  var prompt = document.getElementById("agent-prompt");
                  var button = document.getElementById("copy-prompt");
                  var status = document.getElementById("copy-status");
                  function say(text) { status.textContent = text; }
                  function selectPrompt() {
                    var selection = window.getSelection && window.getSelection();
                    if (!selection || !document.createRange) return false;
                    var range = document.createRange();
                    range.selectNodeContents(prompt);
                    selection.removeAllRanges();
                    selection.addRange(range);
                    return true;
                  }
                  function fallback() {
                    if (!selectPrompt()) {
                      say("Select the prompt above and copy it.");
                      return;
                    }
                    var copied = false;
                    try { copied = document.execCommand("copy"); } catch (e) {}
                    say(copied ? "Copied." : "Selected. Press ctrl+c, or cmd+c on a mac.");
                  }
                  button.addEventListener("click", function () {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                      navigator.clipboard.writeText(prompt.textContent).then(
                        function () { say("Copied."); },
                        fallback
                      );
                      return;
                    }
                    fallback();
                  });
                })();
              `;

/**
 * The callback success page (#180). Beyond confirming the sign-in it hands the
 * user the agent setup prompt, which is the next thing they want anyway.
 *
 * Nothing here is interpolated except the escaped email: the prompt and the
 * docs link are compile-time constants, and the inline script reads the prompt
 * out of the DOM rather than from a JS string literal, so there is no
 * script-context injection surface at all. The prompt is rendered as plain
 * selectable text, so it is copyable by hand when the clipboard API is not.
 */
export function renderAuthSuccessPage(email: string): string {
  return renderCallbackShell({
    title: "Signed in to squirrelscan",
    script: AUTH_SUCCESS_PAGE_SCRIPT,
    glyph: "check",
    pill: "Signed in",
    body: `    <h1>You're in</h1>
    <p>Signed in as <strong>${escapeHtml(email)}</strong>.</p>
    <p>You can close this window and return to your terminal.</p>
    <div class="agent">
      <h2>Use squirrelscan with your AI agent</h2>
      <p>Paste this into your coding agent. It reads the setup docs, wires up the CLI and MCP, and audits this project.</p>
      <code id="agent-prompt">${escapeHtml(AGENT_SETUP_PROMPT)}</code>
      <div class="actions">
        <button id="copy-prompt" type="button">Copy prompt</button>
        <a href="${escapeHtml(AGENT_SETUP_URL)}">View the agent setup</a>
        <span class="status" id="copy-status" role="status" aria-live="polite"></span>
      </div>
    </div>`,
  });
}

interface LoginOptions {
  deviceName?: string;
  version: string;
}

interface LoginResult {
  email: string;
  name: string | null;
}

interface SessionResponse {
  sessionId: string;
  authUrl: string;
  expiresAt: string;
}

export interface SessionStatusResponse {
  status: "pending" | "completed" | "expired" | "consumed";
  token?: string;
  expiresAt?: string;
  user?: {
    id: string;
    email: string;
    name: string | null;
  };
}

/**
 * Resolve the browser auth URL for CLI login.
 *
 * By default we use the URL returned by the API session endpoint.
 * If SQUIRREL_AUTH_URL is provided, we keep the API path/query and swap the base.
 */
function resolveBrowserAuthUrl(apiAuthUrl: string): string {
  const override = process.env.SQUIRREL_AUTH_URL;
  if (!override) return apiAuthUrl;

  try {
    const apiUrl = new URL(apiAuthUrl);
    const overrideUrl = new URL(override);
    const pathname =
      overrideUrl.pathname === "/" ? apiUrl.pathname : overrideUrl.pathname;
    const resolved = new URL(`${pathname}${apiUrl.search}`, overrideUrl.origin);
    return resolved.toString();
  } catch {
    // Fall back to API-provided URL if override is malformed.
    return apiAuthUrl;
  }
}

/**
 * Find an available port for the callback server
 */
async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error("Could not get port"));
      }
    });
    server.on("error", reject);
  });
}

// Moved to lib/browser.ts so non-auth commands can open a URL without pulling
// in this module's callback server. Re-exported: existing callers and tests
// import normalizeBrowserUrl from here.
export { normalizeBrowserUrl } from "@/lib/browser";

export function fetchSessionStatus(
  apiUrl: string,
  sessionId: string,
  codeVerifier: string
): Promise<Response> {
  return fetch(`${apiUrl}/v1/auth/sessions/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codeVerifier }),
  });
}

/**
 * The page the callback server serves for a given session status. Pure, so
 * each of the four is testable on its own: only a completed sign-in with a
 * token gets the success page and the agent setup block (#180). A "completed"
 * status without one is still a wait, exactly as before.
 */
export function renderCallbackPage(status: SessionStatusResponse): {
  code: number;
  html: string;
  /** Response headers: content type, CSP with frame-ancestors, no framing, no sniffing, no referrer, no caching. */
  headers: Record<string, string>;
} {
  const page = renderCallbackPageHtml(status);
  return {
    ...page,
    headers: callbackResponseHeaders(
      page.code === 200 ? { script: AUTH_SUCCESS_PAGE_SCRIPT } : {}
    ),
  };
}

function renderCallbackPageHtml(status: SessionStatusResponse): {
  code: number;
  html: string;
} {
  if (status.status === "completed" && status.token && status.user) {
    return { code: 200, html: renderAuthSuccessPage(status.user.email) };
  }

  if (status.status === "expired") {
    return {
      code: 410,
      html: renderCallbackShell({
        title: "Session expired",
        glyph: "hourglass",
        pill: "Session expired",
        problem: true,
        body: `    <h1>That sign-in timed out</h1>
    <p>Run <code class="inline">squirrel auth login</code> again to start a fresh one.</p>`,
      }),
    };
  }

  if (status.status === "consumed") {
    // Token was already retrieved once (one-time read) - a bare retry would
    // poll forever. Terminal: tell the user to re-login.
    return {
      code: 410,
      html: renderCallbackShell({
        title: "Sign-in link already used",
        glyph: "lock",
        pill: "Already used",
        problem: true,
        body: `    <h1>This sign-in link was already used</h1>
    <p>Each sign-in link works once. Run <code class="inline">squirrel auth login</code> again to get a new one.</p>`,
      }),
    };
  }

  // Still pending - try again
  return {
    code: 202,
    html: renderCallbackShell({
      title: "Waiting for sign-in",
      refresh: true,
      glyph: "dots",
      pill: "Waiting",
      body: `    <h1>Waiting for authentication...</h1>
    <p>Finish signing in in your browser. This page checks again every second.</p>`,
    }),
  };
}

/** Start a local HTTP server to receive the callback. Exported for the header tests. */
export function startCallbackServer(
  port: number,
  sessionId: string,
  codeVerifier: string,
  apiUrl: string,
  onComplete: (data: SessionStatusResponse) => void,
  onError: (error: Error) => void
): { server: ReturnType<typeof createServer>; close: () => void } {
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // Handle callback request
      if (req.url?.startsWith("/callback")) {
        try {
          const statusRes = await fetchSessionStatus(
            apiUrl,
            sessionId,
            codeVerifier
          );
          const status = (await statusRes.json()) as SessionStatusResponse;

          const page = renderCallbackPage(status);
          res.writeHead(page.code, page.headers);
          res.end(page.html);

          if (status.status === "completed" && status.token && status.user) {
            onComplete(status);
          } else if (status.status === "expired") {
            onError(new Error("Session expired"));
          } else if (status.status === "consumed") {
            onError(
              new Error(
                "Login session already used — run 'squirrel auth login' again"
              )
            );
          }
        } catch (error) {
          res.writeHead(
            500,
            callbackResponseHeaders({
              contentType: "text/plain; charset=utf-8",
            })
          );
          res.end("Internal error");
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      } else {
        res.writeHead(
          404,
          callbackResponseHeaders({ contentType: "text/plain; charset=utf-8" })
        );
        res.end("Not found");
      }
    }
  );

  server.listen(port, "127.0.0.1");

  return {
    server,
    close: () => server.close(),
  };
}

/**
 * Run the auth login flow
 */
export async function runAuthLogin(
  opts: LoginOptions
): Promise<Result<LoginResult>> {
  const apiUrl = getApiUrl();
  const deviceName = opts.deviceName ?? hostname();

  // Check if already authenticated
  const settings = loadUserSettings();
  if (settings.ok && settings.data.auth?.token) {
    // Verify the token is still valid
    try {
      const whoamiRes = await fetch(`${apiUrl}/v1/auth/whoami`, {
        headers: cliApi.headers(settings.data.auth.token),
      });

      if (whoamiRes.ok) {
        const data = (await whoamiRes.json()) as {
          user: { email: string; name: string | null };
        };
        return ok({
          email: data.user.email,
          name: data.user.name,
        });
      }
    } catch {
      // Token invalid, proceed with login
    }
  }

  // Find available port
  let port: number;
  try {
    port = await findAvailablePort();
  } catch {
    return err(commandError("PORT_ERROR", "Failed to find available port"));
  }

  // Generate PKCE codes - verifier stays secret, only challenge is sent
  const { codeVerifier, codeChallenge } = generatePKCE();

  // Create auth session
  let sessionResponse: SessionResponse;
  let browserAuthUrl = "";
  try {
    const res = await fetch(`${apiUrl}/v1/auth/sessions`, {
      method: "POST",
      headers: cliApi.headers(),
      body: JSON.stringify({ port, deviceName, codeChallenge }),
    });

    if (!res.ok) {
      // 5xx → the auth server is down or you're pointed at a local/dev API
      // that isn't running; 4xx → the request itself was rejected.
      const detail =
        res.status >= 500
          ? `Couldn't reach the auth server at ${apiUrl} (HTTP ${res.status}).${localApiHint(apiUrl)}`
          : `Sign-in was rejected by ${apiUrl} (HTTP ${res.status}). Try again, or contact support.`;
      return err(commandError("SESSION_ERROR", detail));
    }

    sessionResponse = (await res.json()) as SessionResponse;
    browserAuthUrl = resolveBrowserAuthUrl(sessionResponse.authUrl);
  } catch (error) {
    // fetch threw → DNS / connection refused / timeout. Name the target server
    // and the override so the user isn't left guessing which API failed.
    return err(
      commandError(
        "NETWORK_ERROR",
        `Couldn't reach the auth server at ${apiUrl}: ${(error as Error).message}.${localApiHint(apiUrl)}`
      )
    );
  }

  console.log("Opening browser to authenticate...");
  console.log(`If browser doesn't open, visit: ${browserAuthUrl}`);

  // Start callback server and wait for completion
  return new Promise((resolve) => {
    let resolved = false;
    const timeout = setTimeout(
      () => {
        if (!resolved) {
          resolved = true;
          callbackServer.close();
          resolve(
            err(commandError("TIMEOUT", "Authentication timed out (5 minutes)"))
          );
        }
      },
      5 * 60 * 1000
    ); // 5 minute timeout

    const callbackServer = startCallbackServer(
      port,
      sessionResponse.sessionId,
      codeVerifier,
      apiUrl,
      async (data) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);

        // Save auth state to settings
        const saveResult = await updateSettings({
          auth: {
            token: data.token!,
            userId: data.user!.id,
            email: data.user!.email,
            name: data.user!.name,
            expiresAt: data.expiresAt!,
          },
        });

        // Give time for success page to load
        setTimeout(() => {
          callbackServer.close();
        }, 2000);

        if (!saveResult.ok) {
          resolve(
            err(commandError("SAVE_ERROR", "Failed to save authentication"))
          );
          return;
        }

        // The session is saved, so this event carries the user (and sends
        // nothing at all when telemetry is off).
        trackFirstRunEvent("login_completed", saveResult.data);

        resolve(
          ok({
            email: data.user!.email,
            name: data.user!.name,
          })
        );
      },
      (error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        callbackServer.close();
        resolve(err(commandError("AUTH_ERROR", error.message)));
      }
    );

    // Open browser after server is ready
    openBrowser(browserAuthUrl).catch(() => {
      // Ignore browser open errors - user can open manually
    });
  });
}
