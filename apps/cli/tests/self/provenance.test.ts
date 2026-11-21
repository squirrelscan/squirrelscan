// `self update` provenance (#169, squirrelscan/repo#5032): a binary is accepted
// on a pinned-key signature OR its GitHub attestation. TEST keys are generated
// per test; gh and the .sig fetches are injected, so nothing here touches the
// network or starts a real gh.

import { describe, expect, test } from "bun:test";

import type { GhRun, GhRunner } from "@/self/attestation";
import type { ReleaseKeySet } from "@/self/release-keys";

import {
  type SignedReleaseFiles,
  type SignatureFetcher,
  provenanceVerifiedMessage,
  verifyReleaseProvenance,
} from "@/self/provenance";

import {
  makeTestReleaseKey,
  type TestReleaseKey,
} from "../fixtures/test-release-key";

const enc = new TextEncoder();
const BINARY = enc.encode("squirrel-binary-bytes");
const DATA = BINARY.buffer as ArrayBuffer;
const SHA = new Bun.CryptoHasher("sha256").update(BINARY).digest("hex");
const RELEASE = {
  version: "9.9.9",
  platformArch: "linux-x64" as const,
  filename: "squirrel-9.9.9-linux-x64",
};

const NO_KEYS: ReleaseKeySet = {
  keys: [
    { slot: "current", id: "", pem: "" },
    { slot: "next", id: "", pem: "" },
  ],
  revokedKeyIds: [],
};

function pinned(
  current: TestReleaseKey,
  next?: TestReleaseKey,
  revoked: string[] = []
): ReleaseKeySet {
  return {
    keys: [
      { slot: "current", id: current.id, pem: current.pem },
      { slot: "next", id: next?.id ?? "", pem: next?.pem ?? "" },
    ],
    revokedKeyIds: revoked,
  };
}

function manifestBytes(
  over: Record<string, unknown> = {}
): Uint8Array<ArrayBuffer> {
  return enc.encode(
    JSON.stringify({
      version: RELEASE.version,
      signing_key_id: "",
      binaries: {
        [RELEASE.platformArch]: {
          filename: RELEASE.filename,
          sha256: SHA,
          size: BINARY.length,
        },
      },
      ...over,
    })
  );
}

/** A release signed by `key`, whose manifest names `claimedId` (default: the key's own id). */
function signedRelease(
  key: TestReleaseKey,
  opts: { claimedId?: string; manifest?: Record<string, unknown> } = {}
): SignedReleaseFiles {
  const manifest = manifestBytes({
    signing_key_id: opts.claimedId ?? key.id,
    ...opts.manifest,
  });
  return {
    manifest,
    manifestSig: key.sign(manifest),
    assetSig: key.sign(BINARY),
  };
}

const UNSIGNED: SignedReleaseFiles = {
  manifest: manifestBytes(),
  manifestSig: null,
  assetSig: null,
};

function fetcher(files: SignedReleaseFiles): {
  fetch: SignatureFetcher;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    fetch: async (version, filename) => {
      calls.push([version, filename]);
      return files;
    },
  };
}

const OK: GhRun = { code: 0, output: "" };
/** gh logged in; the attestation verifies unless `verify` says otherwise. `null` = gh absent. */
function gh(verify: GhRun | null = OK): { run: GhRunner; verifyCalls: number } {
  const state = { verifyCalls: 0, run: (async () => null) as GhRunner };
  state.run = async (args) => {
    if (verify === null) return null;
    if (args[0] === "attestation" && args[2] !== "--help") {
      state.verifyCalls++;
      return verify;
    }
    return OK;
  };
  return state;
}
const NO_ATTESTATION: GhRun = { code: 1, output: "no attestations found" };

describe("verifyReleaseProvenance: a pinned key is set", () => {
  test("a valid signature verifies on its own: gh is never asked", async () => {
    const key = makeTestReleaseKey();
    const f = fetcher(signedRelease(key));
    const g = gh(NO_ATTESTATION);
    const r = await verifyReleaseProvenance(DATA, RELEASE, {
      releaseKeys: pinned(key),
      fetchSignatures: f.fetch,
      runGh: g.run,
    });
    expect(r).toEqual({
      ok: true,
      data: { status: "signature", keyId: key.id },
    });
    expect(f.calls).toEqual([[RELEASE.version, RELEASE.filename]]);
    expect(g.verifyCalls).toBe(0);
    if (r.ok && r.data.status === "signature") {
      expect(provenanceVerifiedMessage(r.data)).toBe(
        `Release signature verified: signed by squirrelscan release key ${key.id}`
      );
    }
  });

  test("the next slot verifies too (rotation)", async () => {
    const current = makeTestReleaseKey();
    const next = makeTestReleaseKey();
    const r = await verifyReleaseProvenance(DATA, RELEASE, {
      releaseKeys: pinned(current, next),
      fetchSignatures: fetcher(signedRelease(next)).fetch,
      runGh: gh(NO_ATTESTATION).run,
    });
    expect(r).toEqual({
      ok: true,
      data: { status: "signature", keyId: next.id },
    });
  });

  test("a valid signature from an unpinned key is a hard failure, even with a good attestation", async () => {
    const key = makeTestReleaseKey();
    const foreign = makeTestReleaseKey();
    const g = gh(OK);
    const r = await verifyReleaseProvenance(DATA, RELEASE, {
      releaseKeys: pinned(key),
      fetchSignatures: fetcher(signedRelease(foreign)).fetch,
      runGh: g.run,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SIGNATURE_FAILED");
      expect(r.error.message).toContain(
        `signed with key ${foreign.id}, which this squirrel does not pin`
      );
      expect(r.error.message).toContain("Nothing was installed");
    }
    expect(g.verifyCalls).toBe(0);
  });

  test("an unpinned key's signature claiming the pinned id fails", async () => {
    const key = makeTestReleaseKey();
    const foreign = makeTestReleaseKey();
    const r = await verifyReleaseProvenance(DATA, RELEASE, {
      releaseKeys: pinned(key),
      fetchSignatures: fetcher(signedRelease(foreign, { claimedId: key.id }))
        .fetch,
      runGh: gh(OK).run,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SIGNATURE_FAILED");
      expect(r.error.message).toContain(
        `manifest.json is not signed by key ${key.id}`
      );
    }
  });

  test("a pinned key id listed as revoked is a hard failure, even with a good attestation", async () => {
    const current = makeTestReleaseKey();
    const revoked = makeTestReleaseKey();
    const g = gh(OK);
    const r = await verifyReleaseProvenance(DATA, RELEASE, {
      releaseKeys: pinned(current, revoked, [revoked.id]),
      fetchSignatures: fetcher(signedRelease(revoked)).fetch,
      runGh: g.run,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SIGNATURE_FAILED");
      expect(r.error.message).toContain(
        `signed with revoked key ${revoked.id}`
      );
    }
    expect(g.verifyCalls).toBe(0);
  });

  test("a binary whose sha256 is not the signed manifest's fails", async () => {
    const key = makeTestReleaseKey();
    const r = await verifyReleaseProvenance(DATA, RELEASE, {
      releaseKeys: pinned(key),
      fetchSignatures: fetcher(
        signedRelease(key, {
          manifest: {
            binaries: {
              [RELEASE.platformArch]: {
                filename: RELEASE.filename,
                sha256: "0".repeat(64),
                size: BINARY.length,
              },
            },
          },
        })
      ).fetch,
      runGh: gh(OK).run,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toContain(
        "the binary's sha256 does not match the signed manifest"
      );
    }
  });

  test("a binary changed by one byte fails the asset signature", async () => {
    const key = makeTestReleaseKey();
    const tampered = new Uint8Array(BINARY);
    tampered[0]! ^= 1;
    const tamperedSha = new Bun.CryptoHasher("sha256")
      .update(tampered)
      .digest("hex");
    // A manifest that matches the tampered bytes, signed: only the asset .sig is left to catch it.
    const files = signedRelease(key, {
      manifest: {
        binaries: {
          [RELEASE.platformArch]: {
            filename: RELEASE.filename,
            sha256: tamperedSha,
            size: tampered.length,
          },
        },
      },
    });
    const r = await verifyReleaseProvenance(
      tampered.buffer as ArrayBuffer,
      RELEASE,
      {
        releaseKeys: pinned(key),
        fetchSignatures: fetcher(files).fetch,
        runGh: gh(OK).run,
      }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toContain(
        `${RELEASE.filename} is not signed by key ${key.id}`
      );
    }
  });

  test("a signed manifest for another version fails (no replay as a downgrade)", async () => {
    const key = makeTestReleaseKey();
    const r = await verifyReleaseProvenance(DATA, RELEASE, {
      releaseKeys: pinned(key),
      fetchSignatures: fetcher(
        signedRelease(key, { manifest: { version: "9.9.8" } })
      ).fetch,
      runGh: gh(OK).run,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("different version");
  });

  test("one .sig without the other fails", async () => {
    const key = makeTestReleaseKey();
    const files = signedRelease(key);
    for (const partial of [
      { ...files, assetSig: null },
      { ...files, manifestSig: null },
    ]) {
      const r = await verifyReleaseProvenance(DATA, RELEASE, {
        releaseKeys: pinned(key),
        fetchSignatures: fetcher(partial).fetch,
        runGh: gh(OK).run,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain(".sig is missing");
    }
  });

  test("no signature and a good attestation: verified by the attestation", async () => {
    const key = makeTestReleaseKey();
    const g = gh(OK);
    const r = await verifyReleaseProvenance(DATA, RELEASE, {
      releaseKeys: pinned(key),
      fetchSignatures: fetcher(UNSIGNED).fetch,
      runGh: g.run,
    });
    expect(r).toEqual({ ok: true, data: { status: "attestation" } });
    expect(g.verifyCalls).toBe(1);
  });

  test("no signature and no attestation, gh usable: a hard failure that says both are missing", async () => {
    const key = makeTestReleaseKey();
    const r = await verifyReleaseProvenance(DATA, RELEASE, {
      releaseKeys: pinned(key),
      fetchSignatures: fetcher(UNSIGNED).fetch,
      runGh: gh(NO_ATTESTATION).run,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("ATTESTATION_FAILED");
      expect(r.error.message).toContain(
        "The release carries no squirrelscan release-key signature either."
      );
    }
  });

  test("no signature and gh absent: skipped with the warning, as before", async () => {
    const key = makeTestReleaseKey();
    const r = await verifyReleaseProvenance(DATA, RELEASE, {
      releaseKeys: pinned(key),
      fetchSignatures: fetcher(UNSIGNED).fetch,
      runGh: gh(null).run,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.status).toBe("skipped");
      if (r.data.status === "skipped") {
        expect(r.data.reason).toContain("GitHub CLI (gh) not found");
      }
    }
  });
});

describe("verifyReleaseProvenance: no production key pinned = #169 behaviour", () => {
  const key = makeTestReleaseKey();

  test("signatures are never fetched, even when a release carries them", async () => {
    const f = fetcher(signedRelease(key));
    await verifyReleaseProvenance(DATA, RELEASE, {
      releaseKeys: NO_KEYS,
      fetchSignatures: f.fetch,
      runGh: gh(OK).run,
    });
    expect(f.calls).toEqual([]);
  });

  test("attestation matches: verified, with the #169 message", async () => {
    const r = await verifyReleaseProvenance(DATA, RELEASE, {
      releaseKeys: NO_KEYS,
      fetchSignatures: fetcher(signedRelease(key)).fetch,
      runGh: gh(OK).run,
    });
    expect(r).toEqual({ ok: true, data: { status: "attestation" } });
    if (r.ok && r.data.status === "attestation") {
      expect(provenanceVerifiedMessage(r.data)).toBe(
        "Attestation verified: built by squirrelscan/squirrelscan"
      );
    }
  });

  test("attestation mismatch: the unchanged #169 error, a valid signature does not rescue it", async () => {
    const r = await verifyReleaseProvenance(DATA, RELEASE, {
      releaseKeys: NO_KEYS,
      fetchSignatures: fetcher(signedRelease(key)).fetch,
      runGh: gh(NO_ATTESTATION).run,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("ATTESTATION_FAILED");
      expect(r.error.message).not.toContain("release-key signature");
    }
  });

  test("gh absent: skipped with the sha256 warning", async () => {
    const r = await verifyReleaseProvenance(DATA, RELEASE, {
      releaseKeys: NO_KEYS,
      runGh: gh(null).run,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.status).toBe("skipped");
  });
});
