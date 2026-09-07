// #1913: the CLI reads the same two batch dials the hosted runtime does, with
// the same names and the same 48 MB default, so a batch tuned against a local
// repro means the same thing in a container. A bad value must clamp, never pass
// through: an unbounded batch is the resident pipeline again, and a batch of one
// makes the per-batch storage reads dominate.

import { STREAM_BATCH_BYTES } from "@squirrelscan/audit-engine";
import { describe, expect, test } from "bun:test";

import {
  resolveStreamBatchBytes,
  resolveStreamBatchPagesOverride,
} from "../../src/audit/stream-batch";
import {
  STREAM_BATCH_BYTES_DEFAULT,
  STREAM_BATCH_BYTES_MAX,
  STREAM_BATCH_BYTES_MIN,
  STREAM_BATCH_PAGES_MAX,
  STREAM_BATCH_PAGES_MIN,
} from "../../src/constants";

describe("SQUIRREL_STREAM_BATCH_BYTES", () => {
  test("defaults to 48 MB when unset", () => {
    expect(resolveStreamBatchBytes({})).toBe(STREAM_BATCH_BYTES_DEFAULT);
    expect(STREAM_BATCH_BYTES_DEFAULT).toBe(48 * 1024 * 1024);
  });

  test("the CLI default is the engine's own default", () => {
    // Restated in @/constants rather than imported: `@/constants` is pulled in
    // by nearly every CLI entry point and importing the audit-engine barrel
    // there would drag the rule set into `squirrel self version`. This is what
    // stops the two copies drifting.
    expect(STREAM_BATCH_BYTES_DEFAULT).toBe(STREAM_BATCH_BYTES);
  });

  test("an explicit budget is honoured", () => {
    expect(
      resolveStreamBatchBytes({ SQUIRREL_STREAM_BATCH_BYTES: "96000000" })
    ).toBe(96_000_000);
  });

  test("clamps a value outside the band", () => {
    expect(resolveStreamBatchBytes({ SQUIRREL_STREAM_BATCH_BYTES: "1" })).toBe(
      STREAM_BATCH_BYTES_MIN
    );
    expect(
      resolveStreamBatchBytes({ SQUIRREL_STREAM_BATCH_BYTES: "999999999999" })
    ).toBe(STREAM_BATCH_BYTES_MAX);
  });

  test("a non-numeric value falls back to the default rather than NaN", () => {
    expect(
      resolveStreamBatchBytes({ SQUIRREL_STREAM_BATCH_BYTES: "48mb" })
    ).toBe(STREAM_BATCH_BYTES_DEFAULT);
    expect(resolveStreamBatchBytes({ SQUIRREL_STREAM_BATCH_BYTES: "" })).toBe(
      STREAM_BATCH_BYTES_DEFAULT
    );
  });
});

describe("SQUIRREL_STREAM_BATCH_PAGES", () => {
  test("undefined when unset — the batch is sized from the site's own pages", () => {
    expect(resolveStreamBatchPagesOverride({})).toBeUndefined();
  });

  test("an explicit page count pins the batch", () => {
    expect(
      resolveStreamBatchPagesOverride({ SQUIRREL_STREAM_BATCH_PAGES: "64" })
    ).toBe(64);
  });

  test("clamps a value outside the band", () => {
    expect(
      resolveStreamBatchPagesOverride({ SQUIRREL_STREAM_BATCH_PAGES: "0" })
    ).toBe(STREAM_BATCH_PAGES_MIN);
    expect(
      resolveStreamBatchPagesOverride({ SQUIRREL_STREAM_BATCH_PAGES: "100000" })
    ).toBe(STREAM_BATCH_PAGES_MAX);
  });
});
