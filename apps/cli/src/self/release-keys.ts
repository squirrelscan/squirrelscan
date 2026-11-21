import releaseKeysFile from "../../../../release-keys.json";

/**
 * Pinned release signing keys (squirrelscan/repo#5032).
 *
 * `release-keys.json` at the repo root is the one hand-edited copy. This
 * module reads it for `self update`, and `scripts/sync-install-header.ts`
 * renders it into install.sh (its `--check` mode fails CI when they drift).
 *
 * A key's id is the first 16 hex characters of SHA-256 over its DER
 * SubjectPublicKeyInfo. A slot with an empty pem is unused; while every slot
 * is empty the signature path is off and provenance is checked exactly as
 * before (#169: the GitHub attestation, else the sha256 alone with a warning).
 */
export const RELEASE_KEY_SLOTS = ["current", "next"] as const;
export type ReleaseKeySlot = (typeof RELEASE_KEY_SLOTS)[number];

export interface ReleaseKey {
  slot: ReleaseKeySlot;
  id: string;
  pem: string;
}

export interface ReleaseKeySet {
  keys: ReleaseKey[];
  revokedKeyIds: string[];
}

export const RELEASE_KEY_ID_PATTERN = /^[0-9a-f]{16}$/;

const PEM_PATTERN =
  /^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=\n]+)\n-----END PUBLIC KEY-----\n?$/;

/**
 * Structural parse of `release-keys.json`. Throws on anything malformed: the
 * file is a build-time constant, so a bad one must fail loudly, never quietly
 * turn the signature path off.
 */
export function parseReleaseKeys(value: unknown): ReleaseKeySet {
  const fail = (why: string): never => {
    throw new Error(`release-keys.json: ${why}`);
  };
  if (!value || typeof value !== "object") fail("not an object");
  const file = value as { keys?: unknown; revoked_key_ids?: unknown };
  if (!Array.isArray(file.keys)) fail("`keys` must be an array");
  if (!Array.isArray(file.revoked_key_ids))
    fail("`revoked_key_ids` must be an array");
  const rawKeys = file.keys as unknown[];
  if (rawKeys.length !== RELEASE_KEY_SLOTS.length)
    fail(
      `\`keys\` must hold exactly the ${RELEASE_KEY_SLOTS.join(" and ")} slots`
    );

  const keys = rawKeys.map((raw, i): ReleaseKey => {
    const k = (raw ?? {}) as Partial<ReleaseKey>;
    const slot = RELEASE_KEY_SLOTS[i];
    if (k.slot !== slot) fail(`keys[${i}].slot must be "${slot}"`);
    if (typeof k.id !== "string" || typeof k.pem !== "string")
      fail(`keys[${i}] needs string id and pem`);
    const id = k.id as string;
    const pem = k.pem as string;
    if (pem === "" && id !== "") fail(`keys[${i}] has an id but no pem`);
    if (pem !== "") {
      if (!RELEASE_KEY_ID_PATTERN.test(id))
        fail(`keys[${i}].id must be 16 lowercase hex characters`);
      if (!PEM_PATTERN.test(pem))
        fail(`keys[${i}].pem must be a PEM "PUBLIC KEY" block`);
    }
    return { slot: slot as ReleaseKeySlot, id, pem };
  });

  const ids = keys.filter((k) => k.pem !== "").map((k) => k.id);
  if (new Set(ids).size !== ids.length) fail("two slots pin the same key");

  const revokedKeyIds = (file.revoked_key_ids as unknown[]).map((id, i) => {
    if (typeof id !== "string" || !RELEASE_KEY_ID_PATTERN.test(id))
      fail(`revoked_key_ids[${i}] must be 16 lowercase hex characters`);
    return id as string;
  });

  return { keys, revokedKeyIds };
}

/** The keys this build pins. Parsed on first use, so a bad file breaks updates, not every command. */
let pinned: ReleaseKeySet | undefined;
export function getPinnedReleaseKeys(): ReleaseKeySet {
  pinned ??= parseReleaseKeys(releaseKeysFile);
  return pinned;
}

/** Slots that hold a key. Empty means the signature path is off. */
export function activeReleaseKeys(set: ReleaseKeySet): ReleaseKey[] {
  return set.keys.filter((k) => k.pem !== "");
}

/** DER SubjectPublicKeyInfo from a PEM "PUBLIC KEY" block. */
export function pemToSpkiDer(pem: string): Uint8Array<ArrayBuffer> {
  const match = PEM_PATTERN.exec(pem.replace(/\r\n/g, "\n"));
  if (!match) throw new Error("not a PEM PUBLIC KEY block");
  return new Uint8Array(Buffer.from(match[1]!.replace(/\n/g, ""), "base64"));
}

function hex(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("hex");
}

/** First 16 hex characters of SHA-256 over the key's DER SubjectPublicKeyInfo. */
export async function releaseKeyIdFromSpki(
  spki: Uint8Array<ArrayBuffer>
): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", spki)).slice(0, 16);
}

export function importReleaseKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    pemToSpkiDer(pem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
}

/**
 * Checks a parsed key set beyond its shape: every pinned pem is a P-256 key
 * and its id is the id of that key. Returns the problems, empty when sound.
 * The sync script's `--check` and the unit tests run it on the real file.
 */
export async function validateReleaseKeys(
  set: ReleaseKeySet
): Promise<string[]> {
  const problems: string[] = [];
  for (const key of activeReleaseKeys(set)) {
    try {
      await importReleaseKey(key.pem);
    } catch {
      problems.push(`${key.slot}: pem is not an ECDSA P-256 public key`);
      continue;
    }
    const id = await releaseKeyIdFromSpki(pemToSpkiDer(key.pem));
    if (id !== key.id)
      problems.push(`${key.slot}: id ${key.id} does not match its pem (${id})`);
  }
  return problems;
}

/**
 * ECDSA signatures as openssl writes them (DER: SEQUENCE { INTEGER r,
 * INTEGER s }) to the fixed-width r||s form WebCrypto verifies. Strict: any
 * encoding that is not minimal DER for a P-256 signature returns null.
 */
export function derSignatureToRaw(
  der: Uint8Array<ArrayBuffer>,
  size = 32
): Uint8Array<ArrayBuffer> | null {
  let pos = 0;
  const byte = () => (pos < der.length ? der[pos++]! : -1);
  if (byte() !== 0x30) return null;
  const seqLen = byte();
  // Two P-256 INTEGERs are at most 70 bytes, so the length is always short form.
  if (seqLen < 0 || seqLen > 0x7f || seqLen !== der.length - 2) return null;

  const readInt = (): Uint8Array<ArrayBuffer> | null => {
    if (byte() !== 0x02) return null;
    const len = byte();
    if (len < 1 || len > size + 1 || pos + len > der.length) return null;
    const bytes = der.subarray(pos, pos + len);
    pos += len;
    // Negative numbers are invalid; a leading zero only when the next byte needs it.
    if (bytes[0]! & 0x80) return null;
    if (len > 1 && bytes[0] === 0 && !(bytes[1]! & 0x80)) return null;
    const value = bytes[0] === 0 ? bytes.subarray(1) : bytes;
    if (value.length > size) return null;
    const out = new Uint8Array(size);
    out.set(value, size - value.length);
    return out;
  };

  const r = readInt();
  const s = readInt();
  if (!r || !s || pos !== der.length) return null;
  const raw = new Uint8Array(size * 2);
  raw.set(r, 0);
  raw.set(s, size);
  return raw;
}

/** Verify a DER ECDSA P-256 / SHA-256 signature (the `openssl dgst -sha256 -sign` output) over `data`. */
export async function verifyReleaseSignature(
  pem: string,
  derSignature: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>
): Promise<boolean> {
  const raw = derSignatureToRaw(derSignature);
  if (!raw) return false;
  try {
    const key = await importReleaseKey(pem);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      raw,
      data
    );
  } catch {
    return false;
  }
}
