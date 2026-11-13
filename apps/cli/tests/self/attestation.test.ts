// Release provenance check (#169): gh present and matching, gh present and
// mismatching, gh absent, too old, and logged out. The gh runner is injected,
// so nothing here starts a real gh.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import {
  ATTESTATION_REPO,
  type GhRun,
  type GhRunner,
  verifyReleaseAttestation,
} from "@/self/attestation";

const DATA = new TextEncoder().encode("squirrel-binary-bytes")
  .buffer as ArrayBuffer;

interface Fake {
  runGh: GhRunner;
  calls: string[][];
  /** The file the verify call was handed, and whether it existed at that moment. */
  verifiedFile: { path: string; existed: boolean; bytes: string } | null;
}

const OK_RUN: GhRun = { code: 0, output: "" };
/** undefined means "succeeds"; null is kept, it means gh could not be started. */
const pick = (answer: GhRun | null | undefined): GhRun | null =>
  answer === undefined ? OK_RUN : answer;

/** `null` for a subcommand means gh could not be started. */
function fakeGh(answers: {
  help?: GhRun | null;
  auth?: GhRun | null;
  verify?: GhRun | null;
}): Fake {
  const fake: Fake = {
    calls: [],
    verifiedFile: null,
    runGh: async (args) => {
      fake.calls.push(args);
      if (args[0] === "auth") return pick(answers.auth);
      if (args[2] === "--help") return pick(answers.help);
      const path = args[2] ?? "";
      const existed = existsSync(path);
      fake.verifiedFile = {
        path,
        existed,
        bytes: existed ? readFileSync(path, "utf8") : "",
      };
      return pick(answers.verify);
    },
  };
  return fake;
}

describe("verifyReleaseAttestation (#169)", () => {
  test("gh present and the attestation matches: verified, against the repo, on the exact bytes", async () => {
    const gh = fakeGh({});
    const result = await verifyReleaseAttestation(DATA, { runGh: gh.runGh });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ status: "verified" });
    const verify = gh.calls.find(
      (c) => c[0] === "attestation" && c[2] !== "--help"
    );
    expect(verify?.[1]).toBe("verify");
    expect(verify?.slice(3)).toEqual(["--repo", "squirrelscan/squirrelscan"]);
    expect(ATTESTATION_REPO).toBe("squirrelscan/squirrelscan");
    expect(gh.verifiedFile?.existed).toBe(true);
    expect(gh.verifiedFile?.bytes).toBe("squirrel-binary-bytes");
    // The temp copy does not outlive the check.
    expect(existsSync(gh.verifiedFile?.path ?? "")).toBe(false);
  });

  test("gh present and the attestation does not match: ATTESTATION_FAILED, with gh's own words", async () => {
    const gh = fakeGh({
      verify: {
        code: 1,
        output: "verification failed: no attestation found for digest",
      },
    });
    const result = await verifyReleaseAttestation(DATA, { runGh: gh.runGh });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ATTESTATION_FAILED");
      expect(result.error.message).toContain("Nothing was installed");
      expect(result.error.message).toContain("no attestation found for digest");
    }
    expect(existsSync(gh.verifiedFile?.path ?? "")).toBe(false);
  });

  test("gh absent: skipped with a visible reason, verify never called", async () => {
    const gh = fakeGh({ help: null });
    const result = await verifyReleaseAttestation(DATA, { runGh: gh.runGh });
    expect(result.ok).toBe(true);
    if (result.ok && result.data.status === "skipped") {
      expect(result.data.reason).toContain("GitHub CLI (gh) not found");
      expect(result.data.reason).toContain("sha256 checksum only");
    } else {
      throw new Error("expected skipped");
    }
    expect(gh.verifiedFile).toBeNull();
  });

  test("gh too old for the attestation command: skipped", async () => {
    const gh = fakeGh({ help: { code: 1, output: "unknown command" } });
    const result = await verifyReleaseAttestation(DATA, { runGh: gh.runGh });
    expect(result.ok && result.data.status).toBe("skipped");
    if (result.ok && result.data.status === "skipped") {
      expect(result.data.reason).toContain("too old");
    }
    expect(gh.verifiedFile).toBeNull();
  });

  test("gh not logged in: skipped, never treated as a pass or a mismatch", async () => {
    const gh = fakeGh({
      auth: { code: 1, output: "not logged in" },
      verify: { code: 1, output: "x" },
    });
    const result = await verifyReleaseAttestation(DATA, { runGh: gh.runGh });
    expect(result.ok && result.data.status).toBe("skipped");
    if (result.ok && result.data.status === "skipped") {
      expect(result.data.reason).toContain("not logged in");
    }
    expect(gh.verifiedFile).toBeNull();
  });

  test("the auth probe is pinned to github.com", async () => {
    const gh = fakeGh({});
    await verifyReleaseAttestation(DATA, { runGh: gh.runGh });
    expect(gh.calls.find((c) => c[0] === "auth")).toEqual([
      "auth",
      "status",
      "--hostname",
      "github.com",
    ]);
  });

  test("a probe that times out (code null) is a skip with a 'timed out' reason, not a failure", async () => {
    for (const answers of [
      { help: { code: null, output: "" } },
      { auth: { code: null, output: "" } },
    ]) {
      const gh = fakeGh({ ...answers, verify: { code: 1, output: "x" } });
      const result = await verifyReleaseAttestation(DATA, { runGh: gh.runGh });
      expect(result.ok && result.data.status).toBe("skipped");
      if (result.ok && result.data.status === "skipped") {
        expect(result.data.reason).toContain("timed out");
      }
      expect(gh.verifiedFile).toBeNull();
    }
  });

  test("deadlines: 15s for the probes, 120s for verify", async () => {
    const seen: Array<[string, number]> = [];
    await verifyReleaseAttestation(DATA, {
      runGh: async (args, timeoutMs) => {
        seen.push([
          args[0] === "auth"
            ? "auth"
            : args[2] === "--help"
              ? "help"
              : "verify",
          timeoutMs,
        ]);
        return { code: 0, output: "" };
      },
    });
    expect(seen).toEqual([
      ["help", 15_000],
      ["auth", 15_000],
      ["verify", 120_000],
    ]);
  });

  test("a verify that times out (code null) fails closed", async () => {
    const gh = fakeGh({ verify: { code: null, output: "" } });
    const result = await verifyReleaseAttestation(DATA, { runGh: gh.runGh });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ATTESTATION_FAILED");
      expect(result.error.message).toContain(
        "gh attestation verify timed out after 120s, nothing was installed."
      );
    }
  });

  test("gh disappearing between the probe and the verify counts as absent", async () => {
    const gh = fakeGh({ verify: null });
    const result = await verifyReleaseAttestation(DATA, { runGh: gh.runGh });
    expect(result.ok && result.data.status).toBe("skipped");
  });

  test("the real runner reports an absent gh as skipped (empty PATH)", async () => {
    const saved = process.env.PATH;
    process.env.PATH = "/nonexistent-squirrel-169";
    try {
      const result = await verifyReleaseAttestation(DATA);
      expect(result.ok && result.data.status).toBe("skipped");
    } finally {
      process.env.PATH = saved;
    }
  });
});
