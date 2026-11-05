import {
  loadPlugins,
  type PluginManifestItem,
  type PluginRegistrySnapshot,
} from "@squirrelscan/rules";
// Plugin rule packs for `squirrel audit` (#1599).
//
// The security model, in one place: a plugin is code, so naming it in
// `squirrel.toml` (which a cloned repository controls) never runs it. A plugin
// loads only when its id is also in `plugin_allowlist` of the USER-level
// `~/.squirrel/settings.json`. Nothing else is read for the decision: not the
// project's `.squirrel/settings.json`, not an env var, not the config file.
import { dirname, isAbsolute, resolve } from "node:path";

import type { PluginAllowEntry } from "@/self/types";

import { getSettingsPath } from "@/self/paths";
import { loadUserSettings } from "@/self/settings";

export interface ConfiguredPlugins {
  snapshot: PluginRegistrySnapshot;
  /** One line per plugin that was named but not loaded, saying why. */
  notices: string[];
}

const EMPTY: PluginRegistrySnapshot = { rules: [], listeners: new Map() };

interface PluginsSection {
  enabled?: boolean;
  items?: PluginManifestItem[];
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

/**
 * Resolve the `[plugins]` section of the project config against the user's
 * allowlist and load what both agree on. Throws (naming the plugin or rule id)
 * when an approved plugin cannot be loaded, so a broken pack stops the audit
 * instead of producing a report with rules silently missing.
 *
 * `baseDir` is where relative `entry` paths are resolved from: the directory of
 * the config file that named them.
 */
export async function loadConfiguredPlugins(
  section: PluginsSection | undefined,
  options: { baseDir: string; settingsPath?: string }
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
  if (error) notices.push(`Plugins not loaded: ${error}`);

  const approved: PluginManifestItem[] = [];
  const allowIds = new Set<string>();
  for (const item of items) {
    const entry =
      isAbsolute(item.entry) || item.entry.startsWith("file:")
        ? item.entry
        : resolve(options.baseDir, item.entry);
    const resolved = { ...item, entry };
    const verdict = judge(resolved, entries);
    if (verdict === "ok") {
      approved.push(resolved);
      allowIds.add(item.id);
    } else if (!error) {
      notices.push(
        verdict === "missing"
          ? `Plugin "${item.id}" is named in the config but is not allowlisted in ${settingsPath}, so it was not loaded. Add "${item.id}" to "plugin_allowlist" there to allow it.`
          : `Plugin "${item.id}" is allowlisted in ${settingsPath} for a different file than the config names (${entry}), so it was not loaded.`
      );
    }
  }

  const snapshot = await loadPlugins(approved, allowIds, {
    onSkipped: (id, reason) => {
      if (reason === "no-default-export") {
        notices.push(
          `Plugin "${id}" has no default export, so it registered nothing.`
        );
      }
    },
  });
  return { snapshot, notices };
}

function judge(
  item: PluginManifestItem,
  allow: PluginAllowEntry[]
): "ok" | "missing" | "entry-mismatch" {
  let sawId = false;
  for (const a of allow) {
    if (typeof a === "string") {
      if (a === item.id) return "ok";
    } else if (a.id === item.id) {
      sawId = true;
      if (resolve(a.entry) === resolve(item.entry)) return "ok";
    }
  }
  return sawId ? "entry-mismatch" : "missing";
}

export function configDir(
  configPath: string | undefined,
  fallback: string
): string {
  return configPath ? dirname(resolve(configPath)) : fallback;
}
