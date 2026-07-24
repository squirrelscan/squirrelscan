// Auth logout controller - revoke token and clear settings

import { type Result, ok, err, commandError } from "@/controllers/types";
import { cliApi } from "@/lib/api-client";
import { loadUserSettings, updateSettings } from "@/self/settings";

interface LogoutResult {
  success: boolean;
}

/**
 * Run the auth logout flow
 */
export async function runAuthLogout(): Promise<Result<LogoutResult>> {
  const settings = loadUserSettings();

  if (!settings.ok) {
    return err(settings.error);
  }

  const auth = settings.data.auth;

  if (!auth?.token) {
    return err(
      commandError("NOT_AUTHENTICATED", "Not currently authenticated")
    );
  }

  // Revoke the token on the server (best-effort; we clear local auth regardless).
  await cliApi.send("/v1/auth/logout", { method: "POST", token: auth.token });

  // Clear auth from settings
  const saveResult = await updateSettings({
    auth: null,
  });

  if (!saveResult.ok) {
    return err(commandError("SAVE_ERROR", "Failed to clear authentication"));
  }

  return ok({ success: true });
}
