import {
  loadPlugins,
  type PluginManifestItem,
  type PluginRegistrySnapshot,
  type SquirrelPlugin,
} from "@squirrelscan/rules";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { PluginAllowEntry } from "@/self/types";

import { getSettingsPath } from "@/self/paths";
import { loadUserSettings } from "@/self/settings";

// Plugin rule packs for `squirrel audit` (#1599).
//
// The security model, in one place: a plugin is code, so naming it in
// `squirrel.toml` (which a cloned repository controls) never runs it. The
// USER-level `~/.squirrel/settings.json` pins each approved plugin to one file:
// `{ id, entry (absolute path), sha256 (of the file's bytes) }`. The project
// config only SELECTS among pinned files. A plugin loads when the config's entry,
// after realpath, is the pinned path (also realpath'd) AND the file's SHA-256
// equals the pin. Nothing else is read for the decision: not a bare id, not the
// project's `.squirrel/settings.json`, not an env var, not the config file.
//
// What is imported is what was hashed: the bytes are read once, hashed, written to
// a private temp copy and imported from there, so a swap of the original between
// the check and the import runs nothing different. Residual risk: the copy is a
// single file, so a plugin must be self-contained (bundle its dependencies); a
// relative or package import in it does not resolve and fails the load, and such
// files would not be covered by the hash anyway. The copy sits in a 0700 temp
// directory that is deleted once the plugin has been imported; anything else
// running as the same user could still touch it in that window, but the same user
// can already edit settings.json, so that boundary is not a new one.

export interface ConfiguredPlugins {
  snapshot: PluginRegistrySnapshot;
  /** One line per plugin that was named but not loaded, saying why. */
  notices: string[];
}

const EMPTY: PluginRegistrySnapshot = { rules: [], listeners: new Map() };
const SHA256_HEX = /^[0-9a-f]{64}$/i;

interface PluginsSection {
  enabled?: boolean;
  items?: PluginManifestItem[];
}

export interface LoadConfiguredPluginsOptions {
  /** Where relative `entry` paths resolve from: the directory of the config file that named them. */
  baseDir: string;
  settingsPath?: string;
  /** Where the verified copy of each plugin is written. Defaults to the OS temp dir. */
  tmpRoot?: string;
  /** Test seam: runs after a plugin file's hash is verified and before it is imported. */
  afterVerify?: (id: string, file: string) => void;
}

/** The user-level allowlist. A settings file that cannot be read allows nothing. */
export function readPluginAllowlist(settingsPath: string = getSettingsPath()): {
  entries: PluginAllowEntry[];
  error?: string;
} {
  const result = loadUserSettings(settingsPath);
  if (!result.ok) return { entries: [], error: result.error.message };
  return { entries: result.data.plugin_allowlist ?? [] };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The exact allowlist entry that approves this file, as it would be written in settings.json. */
export function pinLine(id: string, entry: string, sha256: string): string {
  return JSON.stringify({ id, entry, sha256 });
}

interface PluginFile {
  /** The entry with symlinks resolved: the path a pin is compared to. */
  real: string;
  bytes: Uint8Array;
  sha256: string;
}

/** Resolve a config `entry` (a path or a `file:` URL) to a real file and read its bytes once. */
function readPluginFile(
  entry: string,
  baseDir: string
): PluginFile | { error: string } {
  try {
    const lexical = entry.startsWith("file:")
      ? fileURLToPath(entry)
      : isAbsolute(entry)
        ? entry
        : resolve(baseDir, entry);
    const real = realpathSync(lexical);
    const bytes = readFileSync(real);
    return { real, bytes, sha256: sha256Hex(bytes) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

type Verdict = { kind: "ok" } | { kind: "refused"; reason: string };

/**
 * Compare one plugin file to the allowlist. Only an object entry with the same
 * id, an absolute pinned path that resolves to this file, and the file's own
 * SHA-256 approves it. The reason names what to change, in the user's terms.
 */
function judge(
  id: string,
  file: PluginFile,
  allow: PluginAllowEntry[],
  settingsPath: string
): Verdict {
  const add = `Read the file first, then add this to "plugin_allowlist" in ${settingsPath}: ${pinLine(id, file.real, file.sha256)} (the hash is \`shasum -a 256 ${JSON.stringify(file.real)}\`).`;
  const quotedId = JSON.stringify(id);
  const mine = allow.filter((a) => (typeof a === "string" ? a : a.id) === id);
  if (mine.length === 0) {
    return {
      kind: "refused",
      reason: `Plugin ${quotedId} is named in the config but is not allowlisted in ${settingsPath}, so it was not loaded. ${add}`,
    };
  }

  let changed: string | undefined;
  const problems: string[] = [];
  for (const a of mine) {
    if (typeof a === "string") {
      problems.push(
        `a bare id in plugin_allowlist no longer approves a plugin (it approved any file a config named)`
      );
      continue;
    }
    if (!a.entry || !isAbsolute(a.entry)) {
      problems.push(
        a.entry
          ? `the pinned entry ${JSON.stringify(a.entry)} must be an absolute path`
          : `the allowlist entry has no "entry" path`
      );
      continue;
    }
    if (!a.sha256 || !SHA256_HEX.test(a.sha256)) {
      problems.push(
        `the allowlist entry for ${JSON.stringify(a.entry)} has no valid "sha256" (64 hex characters)`
      );
      continue;
    }
    let pinnedReal: string;
    try {
      pinnedReal = realpathSync(a.entry);
    } catch {
      problems.push(
        `the pinned file ${JSON.stringify(a.entry)} does not exist`
      );
      continue;
    }
    if (pinnedReal !== file.real) continue;
    if (a.sha256.toLowerCase() === file.sha256) return { kind: "ok" };
    changed = `the file changed since it was pinned (pinned sha256 ${a.sha256.toLowerCase()}, file is ${file.sha256})`;
  }

  if (changed) {
    return {
      kind: "refused",
      reason: `Plugin ${quotedId} was not loaded: ${changed}. If you trust the new content, replace the pin. ${add}`,
    };
  }
  if (problems.length > 0) {
    return {
      kind: "refused",
      reason: `Plugin ${quotedId} was not loaded: ${problems.join("; ")}. ${add}`,
    };
  }
  return {
    kind: "refused",
    reason: `Plugin ${quotedId} is allowlisted in ${settingsPath} for a different file than the config names (${file.real}), so it was not loaded. To approve this file instead: ${add}`,
  };
}

/**
 * Resolve the `[plugins]` section of the project config against the user's
 * allowlist and load what both agree on. Throws (naming the plugin or rule id)
 * when an approved plugin cannot be loaded, so a broken pack stops the audit
 * instead of producing a report with rules silently missing.
 */
export async function loadConfiguredPlugins(
  section: PluginsSection | undefined,
  options: LoadConfiguredPluginsOptions
): Promise<ConfiguredPlugins> {
  const items = section?.items ?? [];
  if (items.length === 0) return { snapshot: EMPTY, notices: [] };
  if (section?.enabled !== true) {
    return {
      snapshot: EMPTY,
      notices: [
        `[plugins] lists ${items.length} plugin(s) but enabled is not true, so none were loaded.`,
      ],
    };
  }

  const settingsPath = options.settingsPath ?? getSettingsPath();
  const { entries, error } = readPluginAllowlist(settingsPath);
  const notices: string[] = [];
  if (error) {
    notices.push(`Plugins not loaded: ${error}`);
    return { snapshot: EMPTY, notices };
  }

  // Real path of an approved entry -> the on-disk copy of the bytes that were hashed.
  const verified = new Map<string, string>();
  const approved: PluginManifestItem[] = [];
  const allowIds = new Set<string>();
  const tempDirs: string[] = [];

  try {
    for (const item of items) {
      const file = readPluginFile(item.entry, options.baseDir);
      if ("error" in file) {
        notices.push(
          `Plugin ${JSON.stringify(item.id)} was not loaded: its entry ${JSON.stringify(item.entry)} cannot be read (${file.error}).`
        );
        continue;
      }
      const verdict = judge(item.id, file, entries, settingsPath);
      if (verdict.kind === "refused") {
        notices.push(verdict.reason);
        continue;
      }
      // Hash verified. Import a private copy of exactly these bytes, never the path again.
      options.afterVerify?.(item.id, file.real);
      const dir = mkdtempSync(
        join(options.tmpRoot ?? tmpdir(), "squirrel-plugin-")
      );
      tempDirs.push(dir);
      const copy = join(dir, `${file.sha256}${extname(file.real) || ".js"}`);
      writeFileSync(copy, file.bytes, { flag: "wx", mode: 0o600 });
      const resolved = { ...item, entry: file.real };
      verified.set(file.real, copy);
      approved.push(resolved);
      allowIds.add(item.id);
    }

    const snapshot = await loadPlugins(approved, allowIds, {
      importPlugin: (manifest) =>
        import(
          pathToFileURL(verified.get(manifest.entry) as string).href
        ) as Promise<{
          default?: SquirrelPlugin;
        }>,
      onSkipped: (id, reason) => {
        if (reason === "no-default-export") {
          notices.push(
            `Plugin ${JSON.stringify(id)} has no default export, so it registered nothing.`
          );
        }
      },
    });
    return { snapshot, notices };
  } finally {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  }
}

export function configDir(
  configPath: string | undefined,
  fallback: string
): string {
  return configPath ? dirname(resolve(configPath)) : fallback;
}
