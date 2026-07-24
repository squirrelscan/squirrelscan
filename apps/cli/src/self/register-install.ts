import { cliApi } from "@/lib/api-client";

import type { UserSettings } from "./types";

import { version } from "../../package.json";
import { getOrCreateInstallId } from "./install-id";
import { detectCi, detectInstallSource } from "./install-meta";
import { detectPlatformArch, isManagedInstall } from "./paths";
import { loadUserSettings, updateSettings } from "./settings";
import { isTelemetryDisabled } from "./telemetry";

const REGISTER_TIMEOUT_MS = 5000; // 5s timeout for registration

interface RegisterInstallPayload {
  id: string;
  platform: string;
  version: string;
  // Install-channel analytics; see self/install-meta.ts.
  source: string;
  managed: boolean;
  ci: boolean;
  auto_update: boolean;
}

export function registerInstall(settings?: UserSettings): void {
  if (isTelemetryDisabled(settings)) return;
  // Fire-and-forget - don't return promise to avoid blocking process exit
  doRegisterInstall().catch(() => {});
}

async function doRegisterInstall(): Promise<void> {
  const settingsResult = loadUserSettings();
  if (!settingsResult.ok) return;

  const settings = settingsResult.data;
  if (isTelemetryDisabled(settings) || settings.registered) return;

  const id = getOrCreateInstallId();
  if (!id) return;

  const payload: RegisterInstallPayload = {
    id,
    platform: detectPlatformArch(),
    version,
    source: detectInstallSource(),
    managed: isManagedInstall(),
    ci: detectCi(),
    auto_update: settings.auto_update,
  };

  // Unauthenticated endpoint (auth:"none"); only mark registered on a real 2xx.
  const { ok } = await cliApi.request("/v1/installs", {
    method: "POST",
    auth: "none",
    timeoutMs: REGISTER_TIMEOUT_MS,
    body: payload,
  });
  if (ok) {
    updateSettings({ registered: true });
  }
}
