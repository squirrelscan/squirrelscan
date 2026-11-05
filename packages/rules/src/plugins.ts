import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { getBuiltInNamespaceNames, getBuiltInRuleIds, type RuleNamespace } from "./loader";
import type { Rule } from "./types";

export const PluginCapabilitySchema = z.enum(["rules", "listeners"]);
export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;

export const PluginManifestItemSchema = z.object({
  id: z.string().min(1),
  entry: z.string().min(1),
  allow: z.array(PluginCapabilitySchema).default([]),
});

export type PluginManifestItem = z.infer<typeof PluginManifestItemSchema>;

export type AuditEventListener = (
  eventName: string,
  payload: Record<string, unknown>,
) => void | Promise<void>;

export interface PluginRegistrationContext {
  registerRule(rule: Rule): void;
  registerListener(eventName: string, listener: AuditEventListener): void;
}

export interface SquirrelPlugin {
  name: string;
  version: string;
  capabilities: PluginCapability[];
  register(ctx: PluginRegistrationContext): void;
}

export interface PluginRegistrySnapshot {
  rules: Rule[];
  listeners: Map<string, AuditEventListener[]>;
}

/** A plugin that cannot be loaded as declared. Always names the plugin or rule id. */
export class PluginLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginLoadError";
  }
}

const PLUGIN_RULE_ID = /^([a-z][a-z0-9-]{0,31})\/([a-z0-9][a-z0-9-]{0,63})$/;

/**
 * Check one plugin rule id against the built-in set (#1599). A plugin rule must
 * be `<namespace>/<name>` in a namespace of its own: it may neither reuse a
 * built-in rule id (the loader keeps the last writer, so a clash would swap the
 * audit's own rule for foreign code) nor sit inside a built-in namespace, where
 * `--rule-exclude core` and the category scores would claim it. Throws, naming
 * the id, so a bad plugin stops the audit instead of running half-loaded.
 */
export function assertPluginRuleId(ruleId: string, owner = "a plugin"): void {
  if (getBuiltInRuleIds().has(ruleId)) {
    throw new PluginLoadError(
      `Rule id "${ruleId}" from ${owner} clashes with a built-in rule and cannot replace it`,
    );
  }
  const match = PLUGIN_RULE_ID.exec(ruleId);
  if (!match) {
    throw new PluginLoadError(
      `Rule id "${ruleId}" from ${owner} must look like <namespace>/<name> (lowercase letters, digits and hyphens)`,
    );
  }
  if (getBuiltInNamespaceNames().has(match[1] as string)) {
    throw new PluginLoadError(
      `Rule id "${ruleId}" from ${owner} uses the built-in namespace "${match[1]}"; pick a namespace of your own`,
    );
  }
}

/**
 * The rule namespaces of a plugin snapshot, ready for `RunnerScope.additionalNamespaces`.
 * Validates every id (see {@link assertPluginRuleId}) and rejects a duplicate id,
 * so the in-process path an embedding host uses is as strict as the loader.
 */
export function pluginNamespaces(snapshot: Pick<PluginRegistrySnapshot, "rules">): RuleNamespace[] {
  const byNamespace = new Map<string, Rule[]>();
  const seen = new Set<string>();
  for (const rule of snapshot.rules) {
    const id = rule.meta.id;
    assertPluginRuleId(id);
    if (seen.has(id)) throw new PluginLoadError(`Rule id "${id}" is registered more than once`);
    seen.add(id);
    const name = id.slice(0, id.indexOf("/"));
    const list = byNamespace.get(name) ?? [];
    list.push(rule);
    byNamespace.set(name, list);
  }
  return [...byNamespace.entries()].map(([name, rules]) => ({ name, rules }));
}

export class PluginRegistry {
  private readonly rules: Rule[] = [];
  private readonly listeners = new Map<string, AuditEventListener[]>();

  registerRule(rule: Rule): void {
    assertPluginRuleId(rule.meta.id);
    if (this.rules.some((existing) => existing.meta.id === rule.meta.id)) {
      throw new PluginLoadError(`Rule id "${rule.meta.id}" is registered more than once`);
    }
    this.rules.push(rule);
  }

  registerListener(eventName: string, listener: AuditEventListener): void {
    const existing = this.listeners.get(eventName) ?? [];
    existing.push(listener);
    this.listeners.set(eventName, existing);
  }

  snapshot(): PluginRegistrySnapshot {
    return {
      rules: [...this.rules],
      listeners: new Map(
        [...this.listeners.entries()].map(([eventName, listeners]) => [eventName, [...listeners]]),
      ),
    };
  }
}

export type PluginSkipReason = "not-allowlisted" | "no-default-export";

export interface LoadPluginsOptions {
  /** Called for each manifest entry that was not loaded, so the caller can say why. */
  onSkipped?: (id: string, reason: PluginSkipReason) => void;
}

/**
 * Load the plugins named in `manifests` that `allowlist` approves. The allowlist
 * is the caller's, never the manifest's: a manifest comes from project config and
 * must not be able to approve itself. `entry` must be an absolute path or a
 * `file:` URL. A registration the manifest did not grant, a bad rule id or a
 * built-in clash throws; nothing is dropped silently.
 */
export async function loadPlugins(
  manifests: PluginManifestItem[],
  allowlist: Set<string>,
  options: LoadPluginsOptions = {},
): Promise<PluginRegistrySnapshot> {
  const registry = new PluginRegistry();

  for (const manifest of manifests) {
    const parsed = PluginManifestItemSchema.parse(manifest);
    if (!allowlist.has(parsed.id)) {
      options.onSkipped?.(parsed.id, "not-allowlisted");
      continue;
    }

    const isFileUrl = parsed.entry.startsWith("file:");
    if (!isFileUrl && !isAbsolute(parsed.entry)) {
      throw new PluginLoadError(
        `Plugin "${parsed.id}" entry must be an absolute path or a file: URL`,
      );
    }
    const specifier = isFileUrl ? parsed.entry : pathToFileURL(parsed.entry).href;
    const mod = (await import(specifier)) as { default?: SquirrelPlugin };
    const plugin = mod.default;
    if (!plugin) {
      options.onSkipped?.(parsed.id, "no-default-export");
      continue;
    }

    const allowedCapabilities = new Set(parsed.allow);
    const safeContext: PluginRegistrationContext = {
      registerRule: (rule) => {
        if (!allowedCapabilities.has("rules")) {
          throw new PluginLoadError(
            `Plugin "${parsed.id}" registered rule "${rule.meta.id}" but its manifest does not allow "rules"`,
          );
        }
        assertPluginRuleId(rule.meta.id, `plugin "${parsed.id}"`);
        registry.registerRule(rule);
      },
      registerListener: (eventName, listener) => {
        if (!allowedCapabilities.has("listeners")) {
          throw new PluginLoadError(
            `Plugin "${parsed.id}" registered a listener but its manifest does not allow "listeners"`,
          );
        }
        registry.registerListener(eventName, listener);
      },
    };

    plugin.register(safeContext);
  }

  return registry.snapshot();
}
