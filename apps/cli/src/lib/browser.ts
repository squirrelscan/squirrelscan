// Opening a URL in the user's default browser.
//
// Lifted out of controllers/auth/login.ts so `squirrel credits --upgrade` can
// reuse it: importing it from the login controller would drag the whole OAuth
// callback server into an unrelated command.

/**
 * Reject anything that isn't http(s) before it reaches a platform opener —
 * `open`/`xdg-open` will happily launch other schemes and their handlers.
 */
export function normalizeBrowserUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Authentication URL must use HTTP or HTTPS");
  }
  return url.toString();
}

/** Open a URL in the default browser. */
export async function openBrowser(url: string): Promise<void> {
  const safeUrl = normalizeBrowserUrl(url);
  const { platform } = process;

  let command: string;
  let args: string[];

  if (platform === "darwin") {
    command = "open";
    args = [safeUrl];
  } else if (platform === "win32") {
    // Do not pass the API-provided URL through cmd.exe: shell metacharacters in
    // the URL would otherwise be interpreted as commands. Explorer delegates
    // HTTP(S) URLs to the default browser without invoking a command shell.
    command = "explorer.exe";
    args = [safeUrl];
  } else {
    // Linux
    command = "xdg-open";
    args = [safeUrl];
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
