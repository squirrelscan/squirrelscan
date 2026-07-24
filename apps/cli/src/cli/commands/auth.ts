// squirrel auth - authentication commands

import { defineCommand } from "citty";

import { DASHBOARD_URL, STATUS_REQUEST_TIMEOUT_MS } from "@/constants";
import {
  API_TOKEN_ENV_VAR,
  activeEnvTokenVar,
  warnIfSessionUnreadable,
} from "@/self/credentials";
import { safeExit } from "@/self/updater";

import { version } from "../../../package.json";
import { fmt } from "../format";

/**
 * Warn when an env token (SQUIRRELSCAN_API_KEY or the SQUIRREL_API_TOKEN
 * alias) is set: it shadows the login session at runtime. login/logout still
 * operate on the session, but cloud calls use the env token.
 */
function warnEnvTokenShadowing(): void {
  const envVar = activeEnvTokenVar();
  if (!envVar) return;
  console.error(
    `${fmt.yellow("Note:")} ${envVar} is set — it takes precedence over a logged-in session for all cloud calls.`
  );
}

const authLogin = defineCommand({
  meta: {
    name: "login",
    description: "Authenticate with squirrelscan",
  },
  args: {
    "device-name": {
      type: "string",
      alias: "d",
      description: "Name for this device (default: hostname)",
    },
  },
  async run({ args }) {
    warnEnvTokenShadowing();
    const { runAuthLogin } = await import("@/controllers/auth/login");
    const result = await runAuthLogin({
      deviceName: args["device-name"],
      version,
    });

    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      return safeExit(1);
    }

    console.log(`\nAuthenticated as ${result.data.email}`);
    const envVar = activeEnvTokenVar();
    if (envVar) {
      console.log(
        fmt.dim(
          `  ${envVar} is set and will be used instead of this session until you unset it.`
        )
      );
    }
  },
});

const authLogout = defineCommand({
  meta: {
    name: "logout",
    description: "Sign out and revoke token",
  },
  async run() {
    warnEnvTokenShadowing();
    const { runAuthLogout } = await import("@/controllers/auth/logout");
    const result = await runAuthLogout();

    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      return safeExit(1);
    }

    console.log("Signed out successfully");
    const envVar = activeEnvTokenVar();
    if (envVar) {
      console.log(
        fmt.dim(
          `  ${envVar} is still set — cloud calls continue to use it. Unset it to fully sign out.`
        )
      );
    }
  },
});

async function runStatusCommand(jsonOutput: boolean): Promise<void> {
  // Without this, a corrupt/unreadable settings.json makes resolveCredential()
  // return null (same as genuinely logged out), so `auth status`/`whoami`
  // would silently print "Not signed in" instead of hinting at the real
  // problem — exactly the silent-degrade-to-anonymous case #805/#1062 covers,
  // and arguably the single most relevant command for it.
  warnIfSessionUnreadable();
  const { runAuthStatus } = await import("@/controllers/auth/status");
  const result = await runAuthStatus();

  if (!result.ok) {
    if (result.error.code === "NOT_AUTHENTICATED") {
      if (jsonOutput) {
        console.log(JSON.stringify({ authenticated: false }));
      } else {
        console.log(
          `Not signed in — run ${fmt.bold("squirrel auth login")} to unlock cloud features.`
        );
        console.log(
          `${fmt.dim(`Or set ${API_TOKEN_ENV_VAR} with an org API key for headless / CI use.`)}`
        );
        console.log(`${fmt.dim("Dashboard:")} ${fmt.cyan(DASHBOARD_URL)}`);
      }
      return;
    }
    console.error(`Error: ${result.error.message}`);
    return safeExit(1);
  }

  const { source, user, token, apiKey, org, shadowedLoginEmail } = result.data;

  if (jsonOutput) {
    console.log(
      JSON.stringify({
        authenticated: true,
        source,
        ...(shadowedLoginEmail ? { shadowedLoginEmail } : {}),
        user,
        token: {
          deviceName: token.deviceName,
          expiresAt: token.expiresAt,
        },
        ...(apiKey ? { apiKey } : {}),
        ...(org ? { org } : {}),
      })
    );
    return;
  }

  const sourceLabel =
    source === "env"
      ? `${activeEnvTokenVar() ?? API_TOKEN_ENV_VAR} env var`
      : "logged-in session";
  if (user.email) {
    console.log(`Authenticated as ${user.email}`);
  } else {
    console.log("Authenticated");
  }
  console.log(`  Source: ${sourceLabel}`);
  if (org) {
    console.log(`  Org: ${org.name ?? org.id}`);
  }
  if (apiKey) {
    if (apiKey.name) console.log(`  Key: ${apiKey.name}`);
    console.log(
      `  Scopes: ${apiKey.scopes.length ? apiKey.scopes.join(", ") : fmt.dim("(none)")}`
    );
    if (apiKey.keyEnv) console.log(`  Key env: ${apiKey.keyEnv}`);
  }
  if (token.deviceName) {
    console.log(`  Device: ${token.deviceName}`);
  }
  if (token.expiresAt) {
    console.log(`  Expires: ${new Date(token.expiresAt).toLocaleDateString()}`);
  }
  if (source === "env" && shadowedLoginEmail) {
    console.log(
      fmt.dim(
        `  Shadowing logged-in session (${shadowedLoginEmail}). Unset ${activeEnvTokenVar() ?? API_TOKEN_ENV_VAR} to use it.`
      )
    );
  }

  // Best-effort balance line — auth status must not fail (or stall) if the
  // API is down: short timeout, single attempt.
  try {
    const { createCloudClientFromSettings } = await import("@/tools/cloud");
    const client = createCloudClientFromSettings({
      timeoutMs: STATUS_REQUEST_TIMEOUT_MS,
      maxAttempts: 1,
    });
    if (client) {
      const { balance } = await client.getBalance();
      console.log(`  Credits: ${balance.total.toLocaleString("en-US")}`);
    }
  } catch {
    // ignore — balance is informational here; `squirrel credits` has the full view
  }
  console.log(`  Dashboard: ${fmt.cyan(DASHBOARD_URL)}`);
}

const statusArgs = {
  json: {
    type: "boolean" as const,
    description: "Output as JSON",
  },
};

const authStatus = defineCommand({
  meta: {
    name: "status",
    description: "Show authentication status (source, scopes, org)",
  },
  args: statusArgs,
  async run({ args }) {
    await runStatusCommand(Boolean(args.json));
  },
});

// `whoami` is an alias for `status` — the conventional name for "who am I
// authenticated as", and what the API endpoint (`/v1/auth/whoami`) is called.
const authWhoami = defineCommand({
  meta: {
    name: "whoami",
    description: "Show the active credential (source, scopes, org)",
  },
  args: statusArgs,
  async run({ args }) {
    await runStatusCommand(Boolean(args.json));
  },
});

export const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Authentication commands",
  },
  subCommands: {
    login: authLogin,
    logout: authLogout,
    status: authStatus,
    whoami: authWhoami,
  },
});
