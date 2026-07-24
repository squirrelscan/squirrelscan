import { z } from "zod";

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

export class PluginRegistry {
  private readonly rules: Rule[] = [];
  private readonly listeners = new Map<string, AuditEventListener[]>();

  registerRule(rule: Rule): void {
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

export async function loadPlugins(
  manifests: PluginManifestItem[],
  allowlist: Set<string>,
): Promise<PluginRegistrySnapshot> {
  const registry = new PluginRegistry();

  for (const manifest of manifests) {
    const parsed = PluginManifestItemSchema.parse(manifest);
    if (!allowlist.has(parsed.id)) {
      continue;
    }

    const mod = (await import(parsed.entry)) as { default?: SquirrelPlugin };
    const plugin = mod.default;
    if (!plugin) {
      continue;
    }

    const allowedCapabilities = new Set(parsed.allow);
    const safeContext: PluginRegistrationContext = {
      registerRule: (rule) => {
        if (allowedCapabilities.has("rules")) {
          registry.registerRule(rule);
        }
      },
      registerListener: (eventName, listener) => {
        if (allowedCapabilities.has("listeners")) {
          registry.registerListener(eventName, listener);
        }
      },
    };

    plugin.register(safeContext);
  }

  return registry.snapshot();
}
