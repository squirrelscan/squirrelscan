/**
 * Local and private-network hosts versus the squirrelscan cloud (#1841).
 *
 * The CLI audits `http://localhost:3000`, RFC1918 staging boxes and internal
 * hosts on purpose: the crawl runs on the user's own machine, on their own
 * network. No HOSTED service can reach any of those, so every cloud surface
 * that fetches the address ITSELF fails on them forever: the render service,
 * the screenshot capture, a scheduled cloud audit. A hosted website row for
 * such a host is a recurring weekly failure with no way to ever succeed, which
 * is the bug this preflight exists to stop the CLI from creating.
 *
 * The classifier itself lives in `@squirrelscan/utils/non-public-host`, shared
 * with the rules runner (pub#629), so the cloud preflight and the rules that
 * skip a private target can never disagree about a host. This module re-exports
 * it next to the lines the user reads.
 */
export { nonPublicHostLabel } from "@squirrelscan/utils/non-public-host";

/**
 * Why cloud rendering is off for this run. Two lines: the reason, then what
 * still happens, so the user is not left wondering whether the audit ran.
 *
 * Rendering is the one cloud service that fetches the page URL itself, and it
 * debits on SUBMIT, so without this preflight a `--render` run against
 * localhost pays for a render the crawler-worker then refuses.
 */
export function cloudRenderSkippedLines(host: string): [string, string] {
  return [
    `No cloud runner can reach a local or private-network address (${host}).`,
    "Cloud rendering is off for this run; the audit still runs locally.",
  ];
}

/**
 * The single line a local/private-host run prints instead of a publish. Covers
 * both halves of the skip (no run registered, no report published) because to
 * the user they are one fact: this stayed on your machine.
 */
export const LOCAL_HOST_NOT_PUBLISHED_LINE =
  "Local/private host: report kept local, not published to the cloud.";

/**
 * What the CLI prints when the SERVER is the one that classified the host
 * (`websiteRegistration.skipped` with reason `non_public_host`).
 *
 * Kept even though the two classifiers now agree on every case we know of: the
 * API's is authoritative and may tighten first, and a client that answered a
 * server refusal with silence would leave the user hunting for a missing site.
 */
export const SERVER_NON_PUBLIC_HOST_LINE =
  "Local/private host: the cloud did not add this site to your dashboard.";
