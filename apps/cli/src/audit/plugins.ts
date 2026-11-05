import {
  loadPlugins,
  PluginLoadError,
  type PluginManifestItem,
  type PluginRegistrySnapshot,
  type SquirrelPlugin,
} from "@squirrelscan/rules";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { PluginAllowEntry } from "@/self/types";

import { getSettingsPath, getSquirrelPaths } from "@/self/paths";
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
// Approval is decided from the id and the paths alone, before any file the config
// names is opened: only a pinned file is ever read, and only if it is a regular file
// of at most MAX_PLUGIN_BYTES, so a FIFO, a device or a huge file in a cloned repo's
// config cannot hang or exhaust the audit.
//
// What is imported is what was hashed: the bytes are read once, hashed, written to
// a private copy and imported from there, so a swap of the original between the
// check and the import runs nothing different. The copy goes under
// `<squirrel data dir>/plugin-cache/` (`~/.squirrel/plugin-cache/`), never the
// shared system temp dir: every directory squirrel creates there is mode 0700, an
// existing plugin-cache must be a real directory owned by this user that nobody
// else can write to, each run gets its own `mkdtemp` directory, and that directory
// is deleted in a `finally` once the plugins are loaded.
//
// The copy is a single file and module resolution from it walks up the ancestor
// directories looking for `node_modules`. So a plugin must be self-contained
// (bundle its dependencies): a relative import does not resolve, and a package
// import resolves only if some ancestor holds a `node_modules`. The load refuses to
// run when any ancestor of the plugin cache (the cache itself included) has one,
// since a bare import could then pull unhashed code in; a missing package makes
// the import fail, and the load with it. Residual risk: while the copy exists,
// another process running as the same user could modify it, but that user can
// already edit settings.json, so that boundary is not a new one. Not covered:
// code a plugin fetches or reads at run time once it is approved, which is fully
// trusted.

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
  /** Where the verified copy of each plugin is written. Defaults to `<squirrel data dir>/plugin-cache`. */
  cacheRoot?: string;
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

/** The largest plugin file squirrel will read: a plugin is one bundled module, not a data file. */

/** The largest plugin file squirrel will read: a plugin is one bundled module, not a data file. */
export const MAX_PLUGIN_BYTES = 4 * 1024 * 1024;

/**
 * Resolve a config `entry` (a path or a `file:` URL) to the real path a pin is
 * compared to. This only follows symlinks (it never opens the file), so it is
 * safe to do before the approval decision; reading the file is not.
 */
function resolveEntry(
  entry: string,
  baseDir: string
): { real: string } | { error: string } {
  try {
    const lexical = entry.startsWith("file:")
      ? fileURLToPath(entry)
      : isAbsolute(entry)
        ? entry
        : resolve(baseDir, entry);
    return { real: realpathSync(lexical) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Read an approved plugin file once, bounded. The path is `lstat`ed first so a
 * FIFO or device is never opened; the open refuses a symlink in the last
 * component and does not block, and the descriptor is checked again with `fstat`
 * before any byte is read. Never called for a path the allowlist has not approved.
 */
function readPluginFile(
  real: string
): { bytes: Uint8Array; sha256: string } | { error: string } {
  const cap = `${MAX_PLUGIN_BYTES / (1024 * 1024)} MiB`;
  try {
    if (!lstatSync(real).isFile()) return { error: "is not a regular file" };
    const fd = openSync(
      real,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0)
    );
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) return { error: "is not a regular file" };
      if (info.size > MAX_PLUGIN_BYTES)
        return { error: `is larger than ${cap}` };
      const buffer = Buffer.allocUnsafe(info.size + 1);
      let total = 0;
      for (;;) {
        const n = readSync(fd, buffer, total, buffer.length - total, null);
        if (n === 0) break;
        total += n;
        if (total === buffer.length) {
          return { error: "grew while it was being read" };
        }
      }
      const bytes = buffer.subarray(0, total);
      return { bytes, sha256: sha256Hex(bytes) };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return {
      error: `cannot be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

type Selection =
  | { kind: "refused"; reason: string }
  /** The sha256 values of the pins whose path is this file; the file is still to be hashed. */
  | { kind: "pinned"; shas: string[] };

/**
 * Decide from ids and paths alone, before the file is opened, whether the
 * allowlist has a pin for this file: an object entry with the same id and an
 * absolute path that resolves to it. The hash is checked by the caller, after the
 * one bounded read. The reason names what to change, in the user's terms.
 */
function selectPins(
  id: string,
  real: string,
  allow: PluginAllowEntry[],
  settingsPath: string
): Selection {
  const add = `Read the file first, then add this to "plugin_allowlist" in ${settingsPath}: ${pinLine(id, real, "<output of the shasum command>")} where the hash is \`shasum -a 256 ${JSON.stringify(real)}\`.`;
  const quotedId = JSON.stringify(id);
  const mine = allow.filter((a) => (typeof a === "string" ? a : a.id) === id);
  if (mine.length === 0) {
    return {
      kind: "refused",
      reason: `Plugin ${quotedId} is named in the config but is not allowlisted in ${settingsPath}, so it was not loaded. ${add}`,
    };
  }

  const shas: string[] = [];
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
    if (pinnedReal === real) shas.push(a.sha256.toLowerCase());
  }

  if (shas.length > 0) return { kind: "pinned", shas };
  if (problems.length > 0) {
    return {
      kind: "refused",
      reason: `Plugin ${quotedId} was not loaded: ${problems.join("; ")}. ${add}`,
    };
  }
  return {
    kind: "refused",
    reason: `Plugin ${quotedId} is allowlisted in ${settingsPath} for a different file than the config names (${real}), so it was not loaded. To approve this file instead: ${add}`,
  };
}

/**
 * Make sure the plugin cache exists, is ours alone and has no `node_modules` above
 * it, and return its real path. Every directory created here is mode 0700.
 */
function preparePluginCache(root: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = lstatSync(root);
  if (!info.isDirectory()) {
    throw new PluginLoadError(
      `The plugin cache ${root} is not a directory (a symlink or a file), so no plugin was loaded.`
    );
  }
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) {
      throw new PluginLoadError(
        `The plugin cache ${root} is owned by another user, so no plugin was loaded.`
      );
    }
    if ((info.mode & 0o022) !== 0) {
      throw new PluginLoadError(
        `The plugin cache ${root} can be written by other users (mode ${(info.mode & 0o777).toString(8)}); run chmod 700 on it. No plugin was loaded.`
      );
    }
  }
  const real = realpathSync(root);
  for (let dir = real; ; dir = dirname(dir)) {
    const planted = join(dir, "node_modules");
    if (existsSync(planted)) {
      throw new PluginLoadError(
        `${planted} sits above the plugin cache ${real}, and a plugin's imports resolve through node_modules directories above it, so no plugin was loaded. Remove it or move the squirrel data directory.`
      );
    }
    if (dirname(dir) === dir) break;
  }
  return real;
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
  let cache: string | undefined;

  try {
    for (const item of items) {
      const resolved = resolveEntry(item.entry, options.baseDir);
      if ("error" in resolved) {
        notices.push(
          `Plugin ${JSON.stringify(item.id)} was not loaded: its entry ${JSON.stringify(item.entry)} cannot be resolved (${resolved.error}).`
        );
        continue;
      }
      // Approval is decided from the id and the path first. A path the allowlist
      // does not pin is never opened, so a FIFO, a device or a huge file named by
      // a cloned project's config cannot hang or exhaust the audit.
      const selection = selectPins(
        item.id,
        resolved.real,
        entries,
        settingsPath
      );
      if (selection.kind === "refused") {
        notices.push(selection.reason);
        continue;
      }
      const file = readPluginFile(resolved.real);
      if ("error" in file) {
        notices.push(
          `Plugin ${JSON.stringify(item.id)} was not loaded: ${resolved.real} ${file.error}.`
        );
        continue;
      }
      if (!selection.shas.includes(file.sha256)) {
        notices.push(
          `Plugin ${JSON.stringify(item.id)} was not loaded: the file changed since it was pinned (pinned sha256 ${selection.shas.join(" or ")}, file is ${file.sha256}). If you trust the new content, replace the pin with ${pinLine(item.id, resolved.real, file.sha256)} in ${settingsPath}.`
        );
        continue;
      }
      // Hash verified. Import a private copy of exactly these bytes, never the path again.
      options.afterVerify?.(item.id, resolved.real);
      cache ??= preparePluginCache(
        options.cacheRoot ?? join(getSquirrelPaths().data, "plugin-cache")
      );
      const dir = mkdtempSync(join(cache, "run-"));
      tempDirs.push(dir);
      const copy = join(
        dir,
        `${file.sha256}${extname(resolved.real) || ".js"}`
      );
      writeFileSync(copy, file.bytes, { flag: "wx", mode: 0o600 });
      const manifest = { ...item, entry: resolved.real };
      verified.set(resolved.real, copy);
      approved.push(manifest);
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
