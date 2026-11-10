/**
 * The one derivation of "where is the update for this install" (#1660).
 * Banner, doctor and the updater all ask this instead of re-reading the
 * dismissed / snoozed / attempt fields themselves. Pure: the environment
 * (managed install, clock) is passed in.
 */
import {
  AUTO_UPDATE_ATTEMPT_INTERVAL_HOURS,
  AUTO_UPDATE_FALLBACK_THRESHOLD,
} from "@/constants";

import type { UserSettings } from "./types";

export type UpdateState =
  | "none" // nothing pending
  | "pending" // pending, nothing in flight (manual install, or not tried yet)
  | "attempting" // eligible and an install was attempted within the throttle window
  | "fallback" // eligible, the same version failed to land repeatedly
  | "applied" // the update already took effect
  | "dismissed" // the user dismissed this version
  | "snoozed"; // the user declined the prompt for now

export interface UpdateStateContext {
  /** The running binary is the managed one, so a silent update can take effect. */
  managed: boolean;
  /** ms since epoch. */
  now: number;
}

export function isAutoUpdateEligibleFor(
  settings: Pick<UserSettings, "auto_update">,
  managed: boolean
): boolean {
  return settings.auto_update && managed;
}

/** True when `version` is the one the user dismissed. */
export function isVersionDismissed(
  settings: Pick<UserSettings, "dismissed_update_version">,
  version: string | undefined | null
): boolean {
  return !!version && settings.dismissed_update_version === version;
}

/**
 * One download attempt per window, however often the CLI runs. A corrupt
 * timestamp parses to NaN and every comparison with NaN is false, so it reads
 * as "not throttled": the safe direction.
 */
export function isAttemptThrottled(
  settings: Partial<Pick<UserSettings, "last_auto_update_attempt">>,
  now: number
): boolean {
  if (!settings.last_auto_update_attempt) return false;
  const hours =
    (now - Date.parse(settings.last_auto_update_attempt)) / (1000 * 60 * 60);
  return hours < AUTO_UPDATE_ATTEMPT_INTERVAL_HOURS;
}

export function updateState(
  settings: UserSettings,
  ctx: UpdateStateContext
): UpdateState {
  const pending = settings.pending_update_notification;
  const target = pending?.to_version;
  const applied = settings.auto_update_applied;

  if (isVersionDismissed(settings, target)) return "dismissed";
  if (applied && (!target || applied.to_version === target)) return "applied";
  if (!target) return "none";

  const eligible = isAutoUpdateEligibleFor(settings, ctx.managed);
  const attempts = settings.auto_update_attempts;
  if (
    eligible &&
    attempts &&
    attempts.version === target &&
    attempts.count >= AUTO_UPDATE_FALLBACK_THRESHOLD
  ) {
    return "fallback";
  }

  const snoozedUntil = settings.update_prompt_snoozed_until;
  if (snoozedUntil && Date.parse(snoozedUntil) > ctx.now) return "snoozed";

  if (eligible && isAttemptThrottled(settings, ctx.now)) return "attempting";
  return "pending";
}

/** The state plus the throttle fact, which stays true during fallback. */
export function describeUpdate(
  settings: UserSettings,
  ctx: UpdateStateContext
): { state: UpdateState; throttled: boolean } {
  return {
    state: updateState(settings, ctx),
    throttled: isAttemptThrottled(settings, ctx.now),
  };
}
