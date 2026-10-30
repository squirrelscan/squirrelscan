// Finding message, value and expected are pinned per rule against the canonical 500-page fixture (#229).
//
// The v1/v2 golden gates compare two captures of the SAME rules, so a reworded message moves both and
// passes. Those fields are load-bearing downstream (the finding fingerprint, the hosted `finding_defs`
// dictionary and the report groups key on them; every renderer prints them), so the committed file
// `tests/golden/finding-messages.json` is the expected set: per rule, the distinct
// `check|status|message|value|expected` lines with their digits normalized (readable to diff), and a
// digest of the exact lines (so a changed count or value fails too). A deliberate change updates the file:
//
//   UPDATE_GOLDEN=1 bun test packages/audit-engine/tests/golden-finding-messages-229.test.ts
//
// and the diff of that file is the review of what the change does to stored fingerprints and to what users see.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCrawlToStorage } from "@squirrelscan/synthetic-site";

import {
  buildGoldenBaselineModel,
  captureEngineBaseline,
  getGoldenBaselineConfig,
  run,
  type EngineBaselineSnapshot,
} from "./helpers/golden-baseline";

const PINNED = join(import.meta.dir, "golden/finding-messages.json");
const tmpDir = mkdtempSync(join(tmpdir(), "squirrelscan-golden-messages-"));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

export interface PinnedRule {
  /** Decimal digest (48 bits of sha1) of the exact distinct lines, sorted: moves when a count or value in a message changes. */
  digest: string;
  /** The same lines with digit runs replaced by `#`, distinct and sorted: what a reviewer reads. */
  lines: string[];
}
export type PinnedMessages = Record<string, PinnedRule>;

// Decimal, not hex: a 40-char hex string in a committed file trips the secret scan's entropy rule.
const digestOf = (lines: string[]): string =>
  String(createHash("sha1").update(lines.join("\n")).digest().readUIntBE(0, 6));

/** Per rule: the distinct finding lines of a snapshot. */
export function pinMessages(snapshot: EngineBaselineSnapshot): PinnedMessages {
  const exact = new Map<string, Set<string>>();
  for (const f of snapshot.findings) {
    let set = exact.get(f.ruleId);
    if (!set) exact.set(f.ruleId, (set = new Set()));
    set.add([f.checkName, f.status, f.message, f.value ?? "", f.expected ?? ""].join("|"));
  }
  const out: PinnedMessages = {};
  for (const ruleId of [...exact.keys()].sort()) {
    const lines = [...exact.get(ruleId)!].sort();
    out[ruleId] = {
      digest: digestOf(lines),
      lines: [...new Set(lines.map((l) => l.replace(/\d+/g, "#")))].sort(),
    };
  }
  return out;
}

/** Readable per-rule divergences between two pinned sets, capped. */
export function diffPinned(expected: PinnedMessages, actual: PinnedMessages, cap = 40): string[] {
  const out: string[] = [];
  for (const ruleId of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
    const a = expected[ruleId];
    const b = actual[ruleId];
    if (!a)
      out.push(
        `${ruleId}: a rule that was not pinned now produces findings (${b!.lines.length} distinct lines)`,
      );
    else if (!b) out.push(`${ruleId}: pinned findings are gone (${a.lines.length} distinct lines)`);
    else if (a.digest !== b.digest) {
      const gone = a.lines.filter((l) => !b.lines.includes(l));
      const added = b.lines.filter((l) => !a.lines.includes(l));
      out.push(
        gone.length + added.length === 0
          ? `${ruleId}: the same messages with different numbers or values (digest ${a.digest.slice(0, 8)} -> ${b.digest.slice(0, 8)})`
          : `${ruleId}:\n${gone.map((l) => `    - ${l}`).join("\n")}${gone.length && added.length ? "\n" : ""}${added.map((l) => `    + ${l}`).join("\n")}`,
      );
    }
    if (out.length >= cap) {
      out.push("... more rules diverge");
      break;
    }
  }
  return out;
}

describe("pinned finding messages, values and expected (#229)", () => {
  test("the canonical fixture produces the committed set", async () => {
    const dbPath = join(tmpDir, "messages.sqlite");
    const { storage } = await writeCrawlToStorage(buildGoldenBaselineModel(), dbPath);
    await run(storage.close());
    const actual = pinMessages(await captureEngineBaseline(dbPath, getGoldenBaselineConfig()));
    if (process.env.UPDATE_GOLDEN === "1") {
      writeFileSync(PINNED, `${JSON.stringify(actual, null, 1)}\n`);
      return;
    }
    const expected = JSON.parse(readFileSync(PINNED, "utf8")) as PinnedMessages;
    const divergences = diffPinned(expected, actual);
    if (divergences.length > 0) {
      throw new Error(
        `A finding's message, value or expected changed (#229). If that is deliberate, regenerate with UPDATE_GOLDEN=1 and review the diff of tests/golden/finding-messages.json: stored fingerprints and report groups change with it.\n${divergences.join("\n")}`,
      );
    }
    expect(divergences).toEqual([]);
  }, 120_000);

  test("a reworded message is reported as a readable per-rule divergence", () => {
    const base: PinnedMessages = {
      "core/meta-title": { digest: "aaa", lines: ["title|warn|Title is # characters||"] },
    };
    const changed: PinnedMessages = {
      "core/meta-title": { digest: "bbb", lines: ["title|warn|Title length is # characters||"] },
    };
    const out = diffPinned(base, changed);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("core/meta-title");
    expect(out[0]).toContain("- title|warn|Title is # characters||");
    expect(out[0]).toContain("+ title|warn|Title length is # characters||");
    // numbers only: the digest names it
    expect(
      diffPinned(base, {
        "core/meta-title": { digest: "ccc", lines: base["core/meta-title"]!.lines },
      })[0],
    ).toContain("different numbers or values");
    expect(diffPinned(base, base)).toEqual([]);
  });

  test("the digest moves when a number in a message moves, and pinning is order-independent", () => {
    const snap = (message: string, order: boolean): EngineBaselineSnapshot =>
      ({
        findings: (order ? [0, 1] : [1, 0]).map((i) => ({
          ruleId: "r/x",
          checkName: "c",
          status: "warn",
          pageUrl: null,
          message: `${message} ${i}`,
          value: null,
          expected: null,
        })),
      }) as unknown as EngineBaselineSnapshot;
    expect(pinMessages(snap("m", true))["r/x"]!.digest).toBe(
      pinMessages(snap("m", false))["r/x"]!.digest,
    );
    expect(pinMessages(snap("m", true))["r/x"]!.digest).not.toBe(
      pinMessages(snap("n", true))["r/x"]!.digest,
    );
  });
});
