import { type Result, ok, err, commandError } from "@/controllers/types";

import type { PlatformArch } from "./types";

import {
  ATTESTATION_REPO,
  type AttestationDeps,
  verifyReleaseAttestation,
} from "./attestation";
import {
  RELEASE_KEY_ID_PATTERN,
  type ReleaseKeySet,
  activeReleaseKeys,
  getPinnedReleaseKeys,
  verifyReleaseSignature,
} from "./release-keys";
import { REPO_NAME, REPO_OWNER } from "./releases";

/**
 * Release provenance for `self update` (#169, squirrelscan/repo#5032), the
 * same rule as install.sh. After the sha256 check against the manifest, the
 * binary is accepted if EITHER
 *
 *   - a pinned, non-revoked release key signed `manifest.json` (which lists
 *     the binary's sha256 and the key id) and the binary itself, or
 *   - its GitHub attestation from release.yml on main verifies.
 *
 *   keys pinned, signature valid                  -> verified (signature)
 *   keys pinned, signature from an unpinned key,
 *     a revoked key, or not valid                 -> SIGNATURE_FAILED, even
 *                                                    if an attestation exists
 *   no signature (or no key pinned)               -> the #169 attestation rule:
 *     gh usable, attestation matches              -> verified (attestation)
 *     gh usable, no matching attestation          -> ATTESTATION_FAILED
 *     gh absent, too old, or logged out           -> skipped, sha256 decides
 *
 * While no key is pinned nothing is fetched and the outcome is exactly #169's.
 */

export type ProvenanceOutcome =
  | { status: "signature"; keyId: string }
  | { status: "attestation" }
  | { status: "skipped"; reason: string };

/** The release files the signature path reads. `null` means not published (or not reachable). */
export interface SignedReleaseFiles {
  manifest: Uint8Array<ArrayBuffer> | null;
  manifestSig: Uint8Array<ArrayBuffer> | null;
  assetSig: Uint8Array<ArrayBuffer> | null;
}
export type SignatureFetcher = (
  version: string,
  filename: string
) => Promise<SignedReleaseFiles>;

export interface ProvenanceDeps extends AttestationDeps {
  /** Test seam: the pinned key set. Defaults to release-keys.json. */
  releaseKeys?: ReleaseKeySet;
  /** Test seam: replaces fetching manifest.json and the .sig files. */
  fetchSignatures?: SignatureFetcher;
}

export interface ReleaseBinaryRef {
  version: string;
  platformArch: PlatformArch;
  filename: string;
}

const SIG_MAX_BYTES = 1024;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

async function fetchOptional(
  url: string,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > 0 && bytes.byteLength <= maxBytes ? bytes : null;
  } catch {
    return null;
  }
}

/** From the same place as the binary: the GitHub release download URLs. */
const defaultFetchSignatures: SignatureFetcher = async (version, filename) => {
  const base = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/v${version}`;
  const [manifest, manifestSig, assetSig] = await Promise.all([
    fetchOptional(`${base}/manifest.json`, MANIFEST_MAX_BYTES),
    fetchOptional(`${base}/manifest.json.sig`, SIG_MAX_BYTES),
    fetchOptional(`${base}/${filename}.sig`, SIG_MAX_BYTES),
  ]);
  return { manifest, manifestSig, assetSig };
};

const signatureFailed = (why: string) =>
  err(
    commandError(
      "SIGNATURE_FAILED",
      `Release signature verification failed: ${why}. Nothing was installed.`
    )
  );

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", data)).toString(
    "hex"
  );
}

/** The signature path, once a .sig was published. Every failure is final. */
async function checkSignatures(
  data: Uint8Array<ArrayBuffer>,
  release: ReleaseBinaryRef,
  files: SignedReleaseFiles,
  keys: ReleaseKeySet
): Promise<Result<string>> {
  if (!files.manifest)
    return signatureFailed("manifest.json could not be fetched to check it");
  if (!files.manifestSig)
    return signatureFailed("manifest.json.sig is missing");

  let signed: {
    version?: unknown;
    signing_key_id?: unknown;
    binaries?: Record<string, { filename?: unknown; sha256?: unknown }>;
  };
  try {
    signed = JSON.parse(new TextDecoder().decode(files.manifest));
  } catch {
    return signatureFailed("manifest.json is not valid JSON");
  }
  const keyId = signed?.signing_key_id;
  if (typeof keyId !== "string" || !RELEASE_KEY_ID_PATTERN.test(keyId))
    return signatureFailed("manifest.json names no signing key id");
  if (keys.revokedKeyIds.includes(keyId))
    return signatureFailed(`it is signed with revoked key ${keyId}`);
  const key = activeReleaseKeys(keys).find((k) => k.id === keyId);
  if (!key)
    return signatureFailed(
      `it is signed with key ${keyId}, which this squirrel does not pin`
    );

  if (
    !(await verifyReleaseSignature(key.pem, files.manifestSig, files.manifest))
  )
    return signatureFailed(`manifest.json is not signed by key ${keyId}`);

  // The signed manifest has to describe this exact download.
  const entry = signed.binaries?.[release.platformArch];
  if (
    signed.version !== release.version &&
    signed.version !== `v${release.version}`
  )
    return signatureFailed("the signed manifest is for a different version");
  if (!entry || entry.filename !== release.filename)
    return signatureFailed(
      `the signed manifest does not list ${release.filename}`
    );
  if (
    typeof entry.sha256 !== "string" ||
    entry.sha256.toLowerCase() !== (await sha256Hex(data))
  )
    return signatureFailed(
      "the binary's sha256 does not match the signed manifest"
    );

  if (!files.assetSig)
    return signatureFailed(`${release.filename}.sig is missing`);
  if (!(await verifyReleaseSignature(key.pem, files.assetSig, data)))
    return signatureFailed(`${release.filename} is not signed by key ${keyId}`);

  return ok(keyId);
}

export async function verifyReleaseProvenance(
  data: ArrayBuffer,
  release: ReleaseBinaryRef,
  deps?: ProvenanceDeps
): Promise<Result<ProvenanceOutcome>> {
  const keys = deps?.releaseKeys ?? getPinnedReleaseKeys();

  if (activeReleaseKeys(keys).length > 0) {
    const fetchSignatures = deps?.fetchSignatures ?? defaultFetchSignatures;
    const files = await fetchSignatures(release.version, release.filename);
    // Either .sig published means the release is key-signed: from here the
    // signature decides, and an attestation cannot rescue a bad one.
    if (files.manifestSig || files.assetSig) {
      const signed = await checkSignatures(
        new Uint8Array(data),
        release,
        files,
        keys
      );
      if (!signed.ok) return signed;
      return ok<ProvenanceOutcome>({ status: "signature", keyId: signed.data });
    }
  }

  const attested = await verifyReleaseAttestation(data, deps);
  if (!attested.ok) {
    if (activeReleaseKeys(keys).length === 0) return attested;
    return err({
      ...attested.error,
      message: `${attested.error.message}\nThe release carries no squirrelscan release-key signature either.`,
    });
  }
  if (attested.data.status === "skipped") {
    return ok<ProvenanceOutcome>({
      status: "skipped",
      reason: attested.data.reason,
    });
  }
  return ok<ProvenanceOutcome>({ status: "attestation" });
}

export function provenanceVerifiedMessage(
  outcome: Exclude<ProvenanceOutcome, { status: "skipped" }>
): string {
  return outcome.status === "signature"
    ? `Release signature verified: signed by squirrelscan release key ${outcome.keyId}`
    : `Attestation verified: built by ${ATTESTATION_REPO}`;
}
