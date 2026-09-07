// Batch sizing for the CLI's streamed post-crawl phases (#1913).
//
// The batch is normally derived from the site's own average page size against a
// byte budget — that is what makes one setting behave the same on a docs site of
// 30 KB pages and a storefront of 1 MB ones. These two env vars override it, and
// they are the SAME names the hosted runtime reads so a number tuned against a
// local repro means the same thing in a container.

import {
  STREAM_BATCH_BYTES_DEFAULT,
  STREAM_BATCH_BYTES_MAX,
  STREAM_BATCH_BYTES_MIN,
  STREAM_BATCH_PAGES_MAX,
  STREAM_BATCH_PAGES_MIN,
} from "@/constants";
import { logger } from "@/utils/logger";

/**
 * Strictly-numeric env parse. `Number.parseInt` stops at the first non-digit, so
 * the obvious `SQUIRREL_STREAM_BATCH_BYTES=48mb` parses as 48 BYTES and clamps
 * to the 1 MB floor — a fifty-fold smaller batch than the author asked for, with
 * nothing said. Anything that is not a plain integer is refused and named.
 */
function parseIntegerFromEnv(
  name: string,
  rawValue: string | undefined
): number | undefined {
  if (rawValue === undefined || rawValue.trim() === "") return undefined;
  const trimmed = rawValue.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    logger.warn(
      `${name}="${rawValue}" is not a plain integer; ignoring it and using the default`
    );
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Byte budget for one streamed batch of raw html.
 * `SQUIRREL_STREAM_BATCH_BYTES`, clamped; default 48 MB.
 */
export function resolveStreamBatchBytes(
  env: Record<string, string | undefined> = process.env
): number {
  const value = parseIntegerFromEnv(
    "SQUIRREL_STREAM_BATCH_BYTES",
    env.SQUIRREL_STREAM_BATCH_BYTES
  );
  if (value === undefined) return STREAM_BATCH_BYTES_DEFAULT;
  return Math.min(
    STREAM_BATCH_BYTES_MAX,
    Math.max(STREAM_BATCH_BYTES_MIN, value)
  );
}

/**
 * Explicit page count for one streamed batch, pinning the byte budget out of the
 * decision. `SQUIRREL_STREAM_BATCH_PAGES`, clamped.
 *
 * Undefined rather than a default: unset means "size it from this site's pages",
 * which is a different thing from "use this number when nobody said otherwise".
 */
export function resolveStreamBatchPagesOverride(
  env: Record<string, string | undefined> = process.env
): number | undefined {
  const value = parseIntegerFromEnv(
    "SQUIRREL_STREAM_BATCH_PAGES",
    env.SQUIRREL_STREAM_BATCH_PAGES
  );
  if (value === undefined) return undefined;
  return Math.min(
    STREAM_BATCH_PAGES_MAX,
    Math.max(STREAM_BATCH_PAGES_MIN, value)
  );
}
