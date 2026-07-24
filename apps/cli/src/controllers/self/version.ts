import type { Result } from "@/controllers/types";

import { ok } from "@/controllers/types";
import { detectPlatformArch } from "@/self/paths";
import { loadSettings } from "@/self/settings";

import { version } from "../../../package.json";

export interface VersionInfo {
  version: string;
  channel: string;
  platform: string;
  bun_version: string;
}

export function getVersionInfo(): Result<VersionInfo> {
  const settings = loadSettings();
  const platform = detectPlatformArch();

  return ok({
    version,
    channel: settings.ok ? settings.data.channel : "stable",
    platform,
    bun_version: typeof Bun !== "undefined" ? Bun.version : "unknown",
  });
}
