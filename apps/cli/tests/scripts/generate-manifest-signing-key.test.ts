// generate-manifest.ts writes `signing_key_id` from release-keys.json, so the
// manifest the build produces is the one the CLI verifies, byte for byte. The
// release lane publishes the build's files unmodified and signs those bytes.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyReleaseProvenance } from "@/self/provenance";
import { parseReleaseKeys } from "@/self/release-keys";

import releaseKeysFile from "../../../../release-keys.json";
import {
  generateManifest,
  readSigningKeyId,
} from "../../scripts/generate-manifest";
import { makeTestReleaseKey } from "../fixtures/test-release-key";

const VERSION = "9.9.9-beta.1";
const FILENAME = `squirrel-${VERSION}-linux-x64`;
const BINARY = new TextEncoder().encode("squirrel-binary-bytes");

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "generate-manifest-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A build dir holding one binary, plus a release-keys.json whose current slot is `current`. */
async function fixture(
  current: { id: string; pem: string },
  firstSignedVersion = releaseKeysFile.first_signed_version
) {
  const root = scratch();
  const buildDir = join(root, "build");
  await Bun.write(join(buildDir, FILENAME), BINARY);
  const releaseKeysPath = join(root, "release-keys.json");
  const file = structuredClone(releaseKeysFile);
  file.keys[0] = { ...file.keys[0], ...current };
  file.first_signed_version = firstSignedVersion;
  await Bun.write(releaseKeysPath, JSON.stringify(file));
  return { buildDir, releaseKeysPath };
}

describe("generate-manifest signing_key_id", () => {
  test("reads the repository's pinned current key id", async () => {
    expect(releaseKeysFile.keys[0]?.slot).toBe("current");
    expect(await readSigningKeyId()).toBe(releaseKeysFile.keys[0]!.id);
    expect(await readSigningKeyId()).toBe("3d10cf3775665622");
  });

  test("the manifest built from the repository's keys carries the pinned id", async () => {
    const buildDir = join(scratch(), "build");
    await Bun.write(join(buildDir, FILENAME), BINARY);
    await generateManifest({ buildDir, version: VERSION, channel: "beta" });
    const written = await Bun.file(join(buildDir, "manifest.json")).json();
    expect(written.signing_key_id).toBe("3d10cf3775665622");
    expect(written.binaries["linux-x64"].filename).toBe(FILENAME);
  });

  test("the CLI verifier accepts the generated manifest, signed with the key it names", async () => {
    const key = makeTestReleaseKey();
    const { buildDir, releaseKeysPath } = await fixture(key);
    await generateManifest({
      buildDir,
      version: VERSION,
      channel: "beta",
      releaseKeysPath,
    });

    // The exact bytes on disk, unmodified, as the lane publishes them.
    const manifest = await Bun.file(join(buildDir, "manifest.json")).bytes();
    const binary = await Bun.file(join(buildDir, FILENAME)).bytes();
    expect(JSON.parse(new TextDecoder().decode(manifest)).signing_key_id).toBe(
      key.id
    );

    const result = await verifyReleaseProvenance(
      binary.buffer as ArrayBuffer,
      { version: VERSION, platformArch: "linux-x64", filename: FILENAME },
      {
        releaseKeys: parseReleaseKeys(await Bun.file(releaseKeysPath).json()),
        fetchSignatures: async () => ({
          manifest: new Uint8Array(manifest),
          manifestSig: key.sign(manifest),
          assetSig: key.sign(binary),
        }),
      }
    );
    expect(result).toEqual({
      ok: true,
      data: { status: "signature", keyId: key.id },
    });
  });

  test("fails, writing nothing, when the current key slot is empty", async () => {
    const { buildDir, releaseKeysPath } = await fixture(
      { id: "", pem: "" },
      ""
    );
    await expect(
      generateManifest({
        buildDir,
        version: VERSION,
        channel: "beta",
        releaseKeysPath,
      })
    ).rejects.toThrow("signing_key_id");
    expect(existsSync(join(buildDir, "manifest.json"))).toBe(false);
  });

  test("fails when release-keys.json is missing", async () => {
    const buildDir = join(scratch(), "build");
    await Bun.write(join(buildDir, FILENAME), BINARY);
    await expect(
      generateManifest({
        buildDir,
        version: VERSION,
        channel: "beta",
        releaseKeysPath: join(buildDir, "no-such-release-keys.json"),
      })
    ).rejects.toThrow();
    expect(existsSync(join(buildDir, "manifest.json"))).toBe(false);
  });
});
