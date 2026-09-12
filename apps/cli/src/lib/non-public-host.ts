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
 * A PREFLIGHT, not the boundary. `isHostedEgressAllowed` in the cloud API is
 * authoritative and strictly stricter than this: it also refuses cloud
 * metadata hostnames, internal-only name zones (`.internal`, `.local`, `.svc`)
 * and dotless hosts, none of which a syntactic private-IP check can see.
 * Anything this misses the API still refuses, and says so in its response, so
 * the CLI can report it. Keeping the loose check here is deliberate: it decides
 * only whether to SKIP a cloud handoff, never what to crawl.
 *
 * MUST stay out of the shared fetch paths. See the comment block in
 * `packages/utils/src/safe-fetch.ts`: host-blocking a crawl is a functional
 * regression, not hardening. Only cloud handoffs consult this.
 */
import { isPublicHttpUrl, parseUserUrl } from "@squirrelscan/utils/url";

/**
 * The `host:port` of a URL no hosted runner can reach, or null when the cloud
 * can reach it.
 *
 * Null for input that is not a usable http(s) URL too: the normal URL
 * validation reports that far better than a cloud-reachability warning would,
 * and this must never be the thing that rejects a typo.
 *
 * Takes the user's RAW input (a bare `localhost:3000` included) and normalizes
 * it the same way the audit command does, so a schemeless private host is
 * classified identically to a written-out one.
 */
export function nonPublicHostLabel(rawUrl: string): string | null {
  const parsedInput = parseUserUrl(rawUrl);
  if (!parsedInput.ok) return null;
  let parsed: URL;
  try {
    parsed = new URL(parsedInput.url);
  } catch {
    return null;
  }
  return isPublicHttpUrl(parsed.href) ? null : parsed.host;
}

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
 * Reachable whenever the API's stricter classifier disagrees with the local
 * one: `metadata.google.internal` and friends look public here. The run row
 * exists and the report may have published, so this does not claim otherwise;
 * it explains the missing dashboard site.
 */
export const SERVER_NON_PUBLIC_HOST_LINE =
  "Local/private host: the cloud did not add this site to your dashboard.";
