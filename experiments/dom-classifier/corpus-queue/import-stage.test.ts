import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LabelStore } from "../labeler/store.ts";
import type { CapturedPage } from "../labeler/types.ts";
import { assertFrozenProvenance, existingCaptureIsIdentical } from "./import-stage.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function corpusPage(): CapturedPage {
  return {
    id: "page_1234567890abcdef12345678",
    url: "https://example.com/",
    title: "Example",
    capturedAt: "2026-09-18T00:00:00.000Z",
    contentHash: `sha256:${"a".repeat(64)}`,
    captureHash: `sha256:${"b".repeat(64)}`,
    width: 1440,
    height: 900,
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    nodes: [],
    screenshotUrl: "/captures/page_1234567890abcdef12345678.png",
    split: "training-review",
    sourceKind: "fresh_capture",
    sourceUrl: "https://example.com/",
    originalCrawledAt: "2026-01-01T00:00:00.000Z",
    corpusRef: "producthunt-42",
  };
}

describe("reviewed corpus import", () => {
  test("requires every eligible capture's full frozen provenance", () => {
    const page = corpusPage();
    const target = {
      url: "https://example.com/",
      originalCrawledAt: "2026-01-01T00:00:00.000Z",
      corpusRef: "producthunt-42",
    };
    expect(() => assertFrozenProvenance(page, target)).not.toThrow();
    expect(() =>
      assertFrozenProvenance({ ...page, corpusRef: "different-corpus" }, target),
    ).toThrow("does not match frozen queue");
  });

  test("fails closed on a partial destination capture pair", () => {
    const directory = mkdtempSync(join(tmpdir(), "labeler-import-test-"));
    directories.push(directory);
    const destination = new LabelStore(directory);
    destination.ensureDirectories();
    const page = corpusPage();
    writeFileSync(destination.capturePath(page.id), "{}", { mode: 0o600 });
    expect(() => existingCaptureIsIdentical(destination, page)).toThrow("partial capture pair");
  });
});
