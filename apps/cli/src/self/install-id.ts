import { uuidv7 } from "uuidv7";

import { loadUserSettings, updateSettings } from "./settings";

export function getOrCreateInstallId(): string | null {
  const result = loadUserSettings();
  if (!result.ok) return null;

  const settings = result.data;
  if (settings.id) return settings.id;

  const id = uuidv7();
  const updateResult = updateSettings({ id });
  if (!updateResult.ok) return null;

  return id;
}

export function getInstallId(): string | null {
  const result = loadUserSettings();
  if (!result.ok) return null;
  return result.data.id ?? null;
}
