// squirrel keys - manage org API keys (mint headless/CI credentials without
// leaving the terminal; wraps POST/GET/DELETE /v1/organizations/:id/api-keys)

import { defineCommand } from "citty";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { promptForInput } from "@/cli/prompt";
import {
  detectShellRc,
  rcAlreadyExports,
  SHELL_APPEND_MARKER,
  shellExportLine,
  type ShellKind,
} from "@/controllers/keys/shell";
import { API_TOKEN_ENV_VAR, warnIfSessionUnreadable } from "@/self/credentials";
import { safeExit } from "@/self/updater";

import { fmt } from "../format";

/** `nikz (Nik Cubrilovic) - <id>`: the slug and id AC #1971 asks every org
 * mention to carry, so a key is never attributed to an org by name alone. */
function orgLine(slug: string, name: string | null, id: string): string {
  const label = slug || id;
  const named = name && name !== label ? `${label} (${name})` : label;
  return `${fmt.bold(named)} ${fmt.dim(id)}`;
}

const keysCreate = defineCommand({
  meta: {
    name: "create",
    description:
      "Mint an org API key for headless / CI use (requires a login session)",
  },
  args: {
    name: {
      type: "string",
      description: "Key name (default: cli-<hostname>-<yyyymmdd>)",
    },
    org: {
      type: "string",
      description:
        "Organization slug or id to mint for (required when you belong to more than one)",
    },
    scopes: {
      type: "string",
      description: "Comma-separated scopes (default: full access)",
    },
    "expires-days": {
      type: "string",
      description: "Days until expiry (default: never)",
    },
    shell: {
      type: "boolean",
      description:
        "Append the export line to your shell rc file (shows the line, asks to confirm)",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  async run({ args }) {
    warnIfSessionUnreadable();
    const { createApiKey, exportLine } =
      await import("@/controllers/keys/create");

    // --json is machine output; --shell is an interactive prompt. Mixing them
    // would interleave JSON with prompts (and print the secret twice).
    if (args.json && args.shell) {
      console.error("Error: --json and --shell cannot be combined.");
      return safeExit(1);
    }

    let expiresDays: number | undefined;
    if (args["expires-days"] !== undefined) {
      const parsed = Number(args["expires-days"]);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error(
          `Error: --expires-days must be a positive number (got "${args["expires-days"]}").`
        );
        return safeExit(1);
      }
      expiresDays = parsed;
    }

    // Preflight --shell BEFORE minting: a failed TTY/platform/duplicate check
    // must not leave a freshly minted live secret behind.
    const shellTarget = args.shell ? await preflightShellRc() : null;

    const result = await createApiKey({
      name: args.name,
      org: args.org,
      scopes: args.scopes
        ? args.scopes
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      expiresDays,
    });

    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      return safeExit(1);
    }

    const key = result.data;

    if (args.json) {
      console.log(JSON.stringify(key));
      return;
    }

    console.log(
      `\n${fmt.green("✓")} Created API key ${fmt.bold(key.name)} (${key.prefix}…)`
    );
    console.log(`  Org: ${orgLine(key.orgSlug, key.orgName, key.orgId)}`);
    console.log(`  Scopes: ${key.scopes.join(", ")}`);
    console.log(
      `  Expires: ${key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : "never"}`
    );

    if (shellTarget) {
      await appendExportToShellRc(shellTarget, key.token);
      return;
    }

    console.log(
      `\n${fmt.yellow("Save this key now")} (it will not be shown again):`
    );
    console.log(`  ${exportLine(key.token)}`);
  },
});

interface ShellRcPlan {
  shell: ShellKind;
  rcPath: string;
}

/**
 * Validate everything `--shell` needs (TTY, supported platform, no existing
 * export in the rc file) BEFORE a key is minted. Exits on failure so the
 * command never creates a secret it can't deliver.
 */
async function preflightShellRc(): Promise<ShellRcPlan> {
  if (!process.stdin.isTTY) {
    console.error(
      "Error: --shell requires an interactive terminal to confirm the rc-file change. Re-run without --shell and export the key manually."
    );
    return safeExit(1);
  }

  const target = detectShellRc(process.env.SHELL ?? "", (rel) =>
    existsSync(join(homedir(), rel))
  );
  if (!target) {
    console.error(
      "Error: --shell isn't supported on this platform. Re-run without --shell and add the export to your shell profile manually."
    );
    return safeExit(1);
  }

  const rcPath = join(homedir(), target.rcFile);
  if (
    existsSync(rcPath) &&
    rcAlreadyExports(readFileSync(rcPath, "utf8"), API_TOKEN_ENV_VAR)
  ) {
    console.error(
      `Error: ${rcPath} already exports ${API_TOKEN_ENV_VAR}. Remove that line first (look for "${SHELL_APPEND_MARKER}"), then re-run.`
    );
    return safeExit(1);
  }

  return { shell: target.shell, rcPath };
}

/**
 * `--shell`: shows the exact line + target rc file, requires interactive
 * confirmation, then appends (NEVER overwrites). Preconditions were verified
 * by preflightShellRc before the key was minted.
 */
async function appendExportToShellRc(
  plan: ShellRcPlan,
  token: string
): Promise<void> {
  const line = shellExportLine(plan.shell, API_TOKEN_ENV_VAR, token);

  console.log(`\nAbout to append to ${fmt.bold(plan.rcPath)}:`);
  console.log(`  ${line}`);

  const answer = await promptForInput("Append this line? [y/N] ");
  if (answer.trim().toLowerCase() !== "y") {
    console.log(
      "Skipped. Copy the line above into your shell config manually: the key will not be shown again."
    );
    return;
  }

  // Fish users may have no ~/.config/fish yet — appendFileSync won't create it.
  mkdirSync(dirname(plan.rcPath), { recursive: true });
  appendFileSync(plan.rcPath, `\n${line}\n`);
  console.log(
    `Appended to ${plan.rcPath}. Restart your shell or run: source ${plan.rcPath}`
  );
}

const keysList = defineCommand({
  meta: {
    name: "list",
    description: "List org API keys (requires a login session)",
  },
  args: {
    org: {
      type: "string",
      description:
        "Only show keys for this organization slug or id (default: every org you belong to)",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  async run({ args }) {
    warnIfSessionUnreadable();
    const { listApiKeys } = await import("@/controllers/keys/list");
    const result = await listApiKeys(
      args.org !== undefined ? { org: args.org } : {}
    );

    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      return safeExit(1);
    }

    const { orgs } = result.data;

    if (args.json) {
      // Flat array of keys, each stamped with its org — the shape a script
      // wants when the whole point is telling two orgs' keys apart.
      console.log(
        JSON.stringify(
          orgs.flatMap((entry) =>
            entry.keys.map((key) => ({
              ...key,
              orgId: entry.org.id,
              orgSlug: entry.org.slug,
              orgName: entry.org.name,
            }))
          )
        )
      );
      return;
    }

    if (orgs.every((entry) => entry.keys.length === 0 && !entry.error)) {
      console.log("No API keys yet. Create one with `squirrel keys create`.");
      return;
    }

    for (const entry of orgs) {
      console.log(
        `${fmt.bold(entry.org.slug || entry.org.id)}${entry.org.name ? ` ${fmt.dim(entry.org.name)}` : ""}  ${fmt.dim(entry.org.id)}`
      );
      if (entry.error) {
        console.log(`  ${fmt.yellow(entry.error)}\n`);
        continue;
      }
      if (entry.keys.length === 0) {
        console.log(`  ${fmt.dim("(no keys)")}\n`);
        continue;
      }
      for (const key of entry.keys) {
        const status = key.revokedAt
          ? fmt.dim("revoked")
          : key.expiresAt && new Date(key.expiresAt) < new Date()
            ? fmt.yellow("expired")
            : fmt.green("active");
        console.log(
          `  ${key.prefix}…  ${fmt.bold(key.name ?? "(unnamed)")}  ${status}`
        );
        console.log(
          `    Scopes: ${key.scopes.length ? key.scopes.join(", ") : fmt.dim("(none)")}`
        );
        console.log(
          `    Created: ${new Date(key.createdAt).toLocaleDateString()}` +
            (key.lastUsedAt
              ? `  Last used: ${new Date(key.lastUsedAt).toLocaleDateString()}`
              : "")
        );
        if (key.expiresAt) {
          console.log(
            `    Expires: ${new Date(key.expiresAt).toLocaleDateString()}`
          );
        }
      }
      console.log("");
    }
  },
});

const keysRevoke = defineCommand({
  meta: {
    name: "revoke",
    description:
      "Revoke an org API key by prefix or id (requires a login session)",
  },
  args: {
    id: {
      type: "positional",
      description: "Key prefix (from `squirrel keys list`) or full id",
      required: true,
    },
    org: {
      type: "string",
      description:
        "Only search this organization slug or id (default: every org you belong to)",
    },
    force: {
      type: "boolean",
      description: "Skip confirmation prompt",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  async run({ args }) {
    warnIfSessionUnreadable();
    const { findKeyToRevoke, revokeApiKey } =
      await import("@/controllers/keys/revoke");

    const found = await findKeyToRevoke(
      String(args.id),
      args.org !== undefined ? { org: args.org } : {}
    );
    if (!found.ok) {
      console.error(`Error: ${found.error.message}`);
      return safeExit(1);
    }

    const { org, key } = found.data;

    if (!args.force) {
      // Name the org in the confirmation: with several orgs in play, the key
      // name alone does not tell you whose credential you are about to kill.
      console.log(
        `About to revoke ${fmt.bold(key.name ?? key.prefix)} (${key.prefix}…) from ${orgLine(org.slug, org.name, org.id)}.`
      );
      const answer = await promptForInput("Continue? [y/N] ");
      if (answer.trim().toLowerCase() !== "y") {
        console.log("Cancelled.");
        return;
      }
    }

    const result = await revokeApiKey(org.id, key);
    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      return safeExit(1);
    }

    if (args.json) {
      console.log(
        JSON.stringify({
          ...result.data,
          orgId: org.id,
          orgSlug: org.slug,
          orgName: org.name,
        })
      );
      return;
    }
    console.log(
      `✓ Revoked ${result.data.name ?? result.data.prefix} (${result.data.prefix}…) from ${org.slug || org.id}`
    );
  },
});

export const keys = defineCommand({
  meta: {
    name: "keys",
    description: "Manage org API keys",
  },
  subCommands: {
    create: keysCreate,
    list: keysList,
    revoke: keysRevoke,
  },
});
