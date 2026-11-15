// `squirrel evidence` (repo#2301): export, verify and replay a versioned audit evidence bundle.
//
// `export` reads a stored audit and writes a directory that stands on its own (see
// `src/evidence/bundle.ts`). `verify` and `replay` need only that directory: no store, no
// network. Exit code is 1 when a bundle fails verification or a replay finds a mismatch, so CI can
// gate on it.

import { parseDocument } from "@squirrelscan/parser";
import { defineCommand } from "citty";
import { resolve } from "node:path";

import { ErrorCodes } from "@/controllers/types";
import { replayEvidenceBundle, verifyEvidenceBundle } from "@/evidence/bundle";
import { safeExit } from "@/self/updater";

const exportCommand = defineCommand({
  meta: {
    name: "export",
    description: "Write a replayable evidence bundle for a stored audit",
  },
  args: {
    crawl: {
      type: "string",
      description: "Audit id or prefix (default: newest audit)",
    },
    output: {
      type: "string",
      alias: "o",
      description: "Directory to write (must not exist or be empty)",
    },
    shareable: {
      type: "boolean",
      description:
        "Redact credentials, cookies, account data and sensitive URL parameters",
    },
  },
  async run({ args }) {
    if (!args.output) {
      console.error("--output <dir> is required");
      return safeExit(1);
    }
    const { exportEvidence } = await import("@/controllers/evidence");
    const dir = resolve(args.output);
    const kind = args.shareable ? "shareable" : "raw";
    const result = await exportEvidence({ crawlId: args.crawl, dir, kind });
    if (!result.ok) {
      if (result.error.code === ErrorCodes.CRAWL_NOT_FOUND) {
        console.log(result.error.message);
        return;
      }
      console.error(result.error.message);
      return safeExit(1);
    }
    // Verify what was just written: an export that does not verify is not an archive.
    const verified = verifyEvidenceBundle(dir);
    if (!verified.ok) {
      console.error("The export did not verify:");
      for (const issue of verified.issues.slice(0, 20))
        console.error(`  ${issue}`);
      return safeExit(1);
    }
    const { manifest } = result.data;
    console.log(`Wrote ${kind} evidence bundle to ${dir}`);
    console.log(
      `  ${manifest.counts.pages} pages, ${manifest.counts.artifacts} artifacts, ${manifest.counts.findings} findings, ${manifest.counts.failures} fetch failures`
    );
    if (manifest.counts.pagesWithoutArtifact > 0) {
      console.log(
        `  ${manifest.counts.pagesWithoutArtifact} pages have no stored body (marked unavailable)`
      );
    }
    console.log(`  bundle sha256 ${manifest.bundleSha256}`);
    if (kind === "raw") {
      console.log(
        "  RESTRICTED: raw evidence can hold cookies and account data. Use --shareable to share."
      );
    }
  },
});

const verifyCommand = defineCommand({
  meta: {
    name: "verify",
    description: "Check a bundle against its manifest, offline",
  },
  args: {
    dir: {
      type: "positional",
      description: "Bundle directory",
      required: true,
    },
  },
  run({ args }) {
    const result = verifyEvidenceBundle(resolve(args.dir));
    if (!result.ok) {
      console.error(`FAILED: ${result.issues.length} problem(s)`);
      for (const issue of result.issues.slice(0, 50))
        console.error(`  ${issue}`);
      return safeExit(1);
    }
    console.log(
      `OK: ${result.manifest?.files.length ?? 0} files verified (${result.manifest?.kind} bundle, format v${result.manifest?.formatVersion})`
    );
  },
});

const replayCommand = defineCommand({
  meta: {
    name: "replay",
    description:
      "Re-check every finding's evidence against the archived artifacts, offline",
  },
  args: {
    dir: {
      type: "positional",
      description: "Bundle directory",
      required: true,
    },
    json: { type: "boolean", description: "Print the full result as JSON" },
  },
  run({ args }) {
    const result = replayEvidenceBundle(resolve(args.dir), (html, selector) => {
      return parseDocument(html).querySelector(selector) !== null;
    });
    if (!result.verified.ok) {
      console.error("Not replaying: the bundle failed verification.");
      for (const issue of result.verified.issues.slice(0, 50))
        console.error(`  ${issue}`);
      return safeExit(1);
    }
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `${result.total} evidence refs: ${result.confirmed} confirmed, ${result.mismatched} mismatched, ${result.unavailable} unavailable, ${result.noLocation} without a location`
      );
      for (const entry of result.entries.filter(
        (e) => e.outcome === "mismatch"
      )) {
        console.error(
          `  mismatch ${entry.ruleId} ${entry.pageUrl}: ${entry.detail}`
        );
      }
    }
    if (result.mismatched > 0) return safeExit(1);
  },
});

export const evidence = defineCommand({
  meta: {
    name: "evidence",
    description: "Export, verify and replay an audit evidence bundle",
  },
  subCommands: {
    export: exportCommand,
    verify: verifyCommand,
    replay: replayCommand,
  },
});
