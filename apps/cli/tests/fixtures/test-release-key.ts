// TEST release signing keys for the release-key signature tests (repo#5032).
// Generated fresh per call, never written to disk, never a production key.
// The id is computed here with node:crypto, independently of the code under
// test, so a wrong id derivation in release-keys.ts fails the tests.

import { createHash, generateKeyPairSync, sign as nodeSign } from "node:crypto";

export interface TestReleaseKey {
  id: string;
  pem: string;
  /** DER ECDSA over SHA-256, the format `openssl dgst -sha256 -sign` writes. */
  sign(data: Uint8Array): Uint8Array<ArrayBuffer>;
  /** The same signature in the raw r||s form (IEEE P1363) WebCrypto uses. */
  signRaw(data: Uint8Array): Uint8Array<ArrayBuffer>;
}

export function makeTestReleaseKey(): TestReleaseKey {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const der = publicKey.export({ type: "spki", format: "der" });
  return {
    id: createHash("sha256").update(der).digest("hex").slice(0, 16),
    pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    sign: (data) =>
      new Uint8Array(
        nodeSign("sha256", data, { key: privateKey, dsaEncoding: "der" })
      ),
    signRaw: (data) =>
      new Uint8Array(
        nodeSign("sha256", data, {
          key: privateKey,
          dsaEncoding: "ieee-p1363",
        })
      ),
  };
}
