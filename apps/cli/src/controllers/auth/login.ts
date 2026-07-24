// Auth login controller - browser OAuth flow

import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { hostname } from "node:os";

import { type Result, ok, err, commandError } from "@/controllers/types";
import { cliApi } from "@/lib/api-client";
import { DEFAULT_API_URL, getApiUrl } from "@/self/api";
import { loadUserSettings, updateSettings } from "@/self/settings";

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
 * Escape a string for interpolation into the callback page HTML. The email
 * comes from the API response — almost certainly benign, but never trust
 * interpolated input even on a 127.0.0.1-only page.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

interface SessionStatusResponse {
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

/**
 * Open a URL in the default browser
 */
async function openBrowser(url: string): Promise<void> {
  const { platform } = process;

  let command: string;
  let args: string[];

  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    // Linux
    command = "xdg-open";
    args = [url];
  }

  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    child.on("error", reject);
    // Don't wait for close - browser stays open
    setTimeout(resolve, 500);
  });
}

/**
 * Start a local HTTP server to receive the callback
 */
function startCallbackServer(
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
          // Poll session status with code_verifier for PKCE verification
          const statusRes = await fetch(
            `${apiUrl}/v1/auth/sessions/${sessionId}?code_verifier=${encodeURIComponent(codeVerifier)}`
          );
          const status = (await statusRes.json()) as SessionStatusResponse;

          if (status.status === "completed" && status.token && status.user) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Authentication Successful</title>
              <style>
                body {
                  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                  display: flex;
                  justify-content: center;
                  align-items: center;
                  height: 100vh;
                  margin: 0;
                  background: #f5f5f4;
                }
                .container {
                  text-align: center;
                  padding: 40px;
                  background: white;
                  border-radius: 8px;
                  box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                }
                h1 { color: #22c55e; margin-bottom: 10px; }
                p { color: #666; }
              </style>
            </head>
            <body>
              <div class="container">
                <h1>Authentication Successful!</h1>
                <p>Signed in as ${escapeHtml(status.user.email)}</p>
                <p>You can close this window and return to the terminal.</p>
              </div>
            </body>
            </html>
          `);
            onComplete(status);
          } else if (status.status === "expired") {
            res.writeHead(410, { "Content-Type": "text/html" });
            res.end(`
            <!DOCTYPE html>
            <html>
            <head><title>Session Expired</title></head>
            <body style="font-family: sans-serif; text-align: center; padding: 40px;">
              <h1>Session Expired</h1>
              <p>Please run 'squirrel auth login' again.</p>
            </body>
            </html>
          `);
            onError(new Error("Session expired"));
          } else if (status.status === "consumed") {
            // Token was already retrieved once (one-time read) — a bare
            // retry would poll forever. Terminal: tell the user to re-login.
            res.writeHead(410, { "Content-Type": "text/html" });
            res.end(`
            <!DOCTYPE html>
            <html>
            <head><title>Session Already Used</title></head>
            <body style="font-family: sans-serif; text-align: center; padding: 40px;">
              <h1>Login Session Already Used</h1>
              <p>Please run 'squirrel auth login' again.</p>
            </body>
            </html>
          `);
            onError(
              new Error(
                "Login session already used — run 'squirrel auth login' again"
              )
            );
          } else {
            // Still pending - try again
            res.writeHead(202, { "Content-Type": "text/html" });
            res.end(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Waiting...</title>
              <meta http-equiv="refresh" content="1">
            </head>
            <body style="font-family: sans-serif; text-align: center; padding: 40px;">
              <h1>Waiting for authentication...</h1>
              <p>Please complete sign-in in your browser.</p>
            </body>
            </html>
          `);
          }
        } catch (error) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal error");
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      } else {
        res.writeHead(404);
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
