/**
 * The one-time "this stayed local" nudge (#2182).
 *
 * Nearly half of all accounts have never seen a report in the dashboard, and
 * nobody who has not seen one has ever paid for the product. A signed-in CLI
 * user whose audits never reach the cloud is the clearest case of that: they
 * have credits, they run audits, and the only thing between them and a hosted
 * report is knowing the command.
 *
 * Signed-in runs auto-publish by default (`resolvePublishDecision`), so the
 * population this actually reaches is the one that opted OUT — `--no-publish`
 * on the run, or `[cloud] publish = false` in squirrel.toml. That is the point:
 * the opt-out is per-run or per-project and was often set for one reason long
 * ago, while the user has never once seen what publishing gets them.
 *
 * ── Once means once ──────────────────────────────────────────────────
 *
 * Two independent settings flags, because they answer different questions:
 *
 *   `publish_nudge_shown`  — we have already said this. Never say it again,
 *                            whatever happens afterwards.
 *   `first_publish_at`     — a report has reached the dashboard. Never say it
 *                            at all, even if the line was never printed.
 *
 * The second is what the acceptance criterion calls "never again after their
 * first publish", and it has to be its own fact: a user can publish on their
 * very first run, before the nudge ever had an opportunity to print.
 */
import type { UserSettings } from "@/self/types";

import { fmt } from "./format";

/**
 * Has this install ever put a report in the dashboard?
 *
 * `auto_publish_notice_shown` is read as a back-fill, not as a second source of
 * truth: it is written ONLY inside the successful auto-publish branch of the
 * audit command, so `true` there is proof of a past publish on an install that
 * predates `first_publish_at`. The converse does not hold (an explicit
 * `--publish`, or a non-TTY run, publishes without setting it), which is why it
 * is an extra way to answer YES and never a way to answer no.
 */
export function hasEverPublished(
  settings:
    | Pick<UserSettings, "first_publish_at" | "auto_publish_notice_shown">
    | undefined
): boolean {
  if (!settings) return false;
  if (settings.first_publish_at) return true;
  return settings.auto_publish_notice_shown === true;
}

export interface PublishNudgeOptions {
  /** The run resolved to a usable cloud session (a balance call succeeded). */
  signedIn: boolean;
  /** --offline: the whole cloud footer block is skipped. */
  offline: boolean;
  /** This run put a report in the dashboard. */
  publishedThisRun: boolean;
  /** An auto-publish was attempted and failed; its error already printed. */
  publishFailed: boolean;
  /** Any report has ever been published from this install. */
  everPublished: boolean;
  /** The nudge has already been printed once. */
  nudgeShown: boolean;
  /** #1841: loopback / RFC1918 / link-local target — nothing hosted can reach it. */
  nonPublicHost: boolean;
  /** --rule-include/--rule-exclude: the report is partial and must not be published. */
  ruleFilterActive: boolean;
  stderrIsTTY: boolean;
  isConsoleFormat: boolean;
  outputPath: string | undefined;
}

/**
 * Should this run print the nudge?
 *
 * Every clause is a separate reason, in the order a reader would ask them:
 * first "is there anything to say", then "may we say it", then "is anyone
 * there to read it".
 */
export function shouldShowPublishNudge(options: PublishNudgeOptions): boolean {
  // ── Is there anything to say ──────────────────────────────────────
  // Already said, or already moot.
  if (options.nudgeShown) return false;
  if (options.everPublished) return false;
  if (options.publishedThisRun) return false;

  // ── Would the advice be true ──────────────────────────────────────
  // An --offline run has no cloud footer at all, and a signed-out run already
  // gets "Unlock cloud features: squirrel auth login" in its place — two CTAs
  // in one footer is one too many, and the login one comes first anyway.
  if (options.offline) return false;
  if (!options.signedIn) return false;
  // A hosted report for http://localhost:3000 is a dashboard card nothing in
  // the cloud can screenshot, re-audit or schedule. The run already printed the
  // #1841 line explaining that; telling the user to publish it anyway would be
  // advice that cannot work.
  if (options.nonPublicHost) return false;
  // A --rule-include/--rule-exclude run produces a PARTIAL report (#1066).
  // Publishing it would replace the site's full dashboard report with a subset,
  // which is why auto-publish refuses it in the first place.
  if (options.ruleFilterActive) return false;
  // The auto-publish already tried and failed, and said so on its own line.
  // A second line telling them to publish reads as if we had not noticed.
  if (options.publishFailed) return false;

  // ── Is a human there to read it ───────────────────────────────────
  // Same predicate as tips (cli/tips.ts): agents, CI and any machine format
  // must never see a sales line. The footer goes to stderr, so it is stderr's
  // TTY that decides.
  if (!options.stderrIsTTY) return false;
  if (!options.isConsoleFormat) return false;
  if (options.outputPath) return false;

  return true;
}

/**
 * The line itself.
 *
 * `--visibility unlisted` is spelled out rather than left off, because
 * `squirrel report --publish` defaults to **public** while the auto-publish
 * path the user opted out of defaults to unlisted. A nudge that quietly moved
 * someone from "not published" to "on the public web" would be the worst
 * possible outcome of a growth line.
 *
 * "shown once" is part of the copy, not a comment about it: a CLI line that
 * looks like it will appear after every audit gets an opt-out request, and the
 * user cannot tell from the line alone that there is nothing to opt out of.
 */
export function publishNudgeLine(): string {
  return (
    `${fmt.dim("Kept local.")} Send this report to your dashboard: ` +
    `${fmt.bold("squirrel report --publish --visibility unlisted")} ${fmt.dim("(shown once)")}`
  );
}
