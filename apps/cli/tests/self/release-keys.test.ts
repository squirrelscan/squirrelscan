// Pinned release keys (squirrelscan/repo#5032): the shared key file, the key id
// derivation, and the DER -> raw r||s signature conversion WebCrypto needs.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  derSignatureToRaw,
  isSignedEra,
  getPinnedReleaseKeys,
  parseReleaseKeys,
  pemToSpkiDer,
  releaseKeyIdFromSpki,
  validateReleaseKeys,
  verifyReleaseSignature,
} from "@/self/release-keys";

import { makeTestReleaseKey } from "../fixtures/test-release-key";

const ROOT = new URL("../../../../", import.meta.url).pathname;

const emptyFile = () => ({
  keys: [
    { slot: "current", id: "", pem: "" },
    { slot: "next", id: "", pem: "" },
  ],
  revoked_key_ids: [] as string[],
  first_signed_version: "",
});

describe("release-keys.json", () => {
  test("the checked-in file parses and every pinned key's id matches its pem", async () => {
    const set = getPinnedReleaseKeys();
    expect(set.keys.map((k) => k.slot)).toEqual(["current", "next"]);
    expect(await validateReleaseKeys(set)).toEqual([]);
  });

  test("install.sh carries the same keys (sync-install-header.ts renders them)", async () => {
    const { withReleaseKeys } =
      await import("../../../../scripts/sync-install-header");
    const installSh = readFileSync(`${ROOT}install.sh`, "utf8");
    expect(withReleaseKeys(installSh, getPinnedReleaseKeys())).toBe(installSh);
  });

  test("rejects a malformed file instead of turning the signature path off", () => {
    expect(() => parseReleaseKeys(null)).toThrow();
    expect(() => parseReleaseKeys({ keys: [], revoked_key_ids: [] })).toThrow(
      "exactly"
    );
    const swapped = emptyFile();
    swapped.keys.reverse();
    expect(() => parseReleaseKeys(swapped)).toThrow('slot must be "current"');
    const idNoPem = emptyFile();
    idNoPem.keys[0]!.id = "0123456789abcdef";
    expect(() => parseReleaseKeys(idNoPem)).toThrow("id but no pem");
    const badRevoked = emptyFile();
    badRevoked.revoked_key_ids = ["nothex"];
    expect(() => parseReleaseKeys(badRevoked)).toThrow("revoked_key_ids[0]");
    const key = makeTestReleaseKey();
    const dup = emptyFile();
    dup.keys[0] = { slot: "current", id: key.id, pem: key.pem };
    dup.keys[1] = { slot: "next", id: key.id, pem: key.pem };
    expect(() => parseReleaseKeys(dup)).toThrow("same key");
  });

  test("validateReleaseKeys flags an id that is not the key's id", async () => {
    const key = makeTestReleaseKey();
    const file = emptyFile();
    file.keys[0] = { slot: "current", id: "0123456789abcdef", pem: key.pem };
    const problems = await validateReleaseKeys(parseReleaseKeys(file));
    expect(problems).toEqual([
      `current: id 0123456789abcdef does not match its pem (${key.id})`,
    ]);
    file.keys[0]!.id = key.id;
    expect(await validateReleaseKeys(parseReleaseKeys(file))).toEqual([]);
  });
});

describe("release key id", () => {
  test("is the first 16 hex chars of SHA-256 over the DER SubjectPublicKeyInfo", async () => {
    const key = makeTestReleaseKey();
    expect(await releaseKeyIdFromSpki(pemToSpkiDer(key.pem))).toBe(key.id);
  });
});

describe("derSignatureToRaw", () => {
  test("places r and s right-aligned in 32 bytes each, including 33-byte (zero-prefixed) integers", () => {
    const key = makeTestReleaseKey();
    let sawPadded = false;
    for (let i = 0; i < 300; i++) {
      const data = new TextEncoder().encode(`payload-${i}`);
      const der = key.sign(data);
      const rLen = der[3]!;
      if (rLen === 33) sawPadded = true;
      // ECDSA is randomised, so compare against this DER's own r and s.
      const raw = derSignatureToRaw(der);
      expect(raw).not.toBeNull();
      expect(raw!.length).toBe(64);
      const r = der.subarray(4, 4 + rLen);
      const rTrimmed = r[0] === 0 ? r.subarray(1) : r;
      expect(Buffer.from(raw!.subarray(32 - rTrimmed.length, 32))).toEqual(
        Buffer.from(rTrimmed)
      );
      const sOff = 4 + rLen;
      const s = der.subarray(sOff + 2, sOff + 2 + der[sOff + 1]!);
      const sTrimmed = s[0] === 0 ? s.subarray(1) : s;
      expect(Buffer.from(raw!.subarray(64 - sTrimmed.length))).toEqual(
        Buffer.from(sTrimmed)
      );
    }
    // r has its high bit set half the time: 300 signatures all but guarantee a 33-byte one.
    expect(sawPadded).toBe(true);
  });

  test("a converted DER signature verifies with WebCrypto, the raw one node made does too", async () => {
    const key = makeTestReleaseKey();
    const data = new TextEncoder().encode("squirrel-binary-bytes");
    expect(await verifyReleaseSignature(key.pem, key.sign(data), data)).toBe(
      true
    );
    const cryptoKey = await crypto.subtle.importKey(
      "spki",
      pemToSpkiDer(key.pem),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const converted = derSignatureToRaw(key.sign(data))!;
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        cryptoKey,
        converted,
        data
      )
    ).toBe(true);
    // Sanity: node's own raw form verifies the same way, so the comparison is fair.
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        cryptoKey,
        key.signRaw(data),
        data
      )
    ).toBe(true);
  });

  test("rejects malformed DER", () => {
    const key = makeTestReleaseKey();
    const der = key.sign(new TextEncoder().encode("x"));
    const bad = (bytes: number[] | Uint8Array<ArrayBuffer>) =>
      derSignatureToRaw(new Uint8Array(bytes));
    expect(bad([])).toBeNull();
    // Not a SEQUENCE.
    expect(bad([0x31, ...der.subarray(1)])).toBeNull();
    // Trailing garbage / wrong outer length.
    expect(bad([...der, 0x00])).toBeNull();
    // A raw 64-byte r||s is not DER.
    expect(bad(key.signRaw(new TextEncoder().encode("x")))).toBeNull();
    // Negative integer (high bit set without a leading zero).
    expect(bad([0x30, 0x06, 0x02, 0x01, 0x80, 0x02, 0x01, 0x01])).toBeNull();
    // Non-minimal leading zero.
    expect(
      bad([0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01])
    ).toBeNull();
    // An integer wider than 33 bytes.
    expect(
      bad([
        0x30,
        0x27,
        0x02,
        0x22,
        ...Array.from({ length: 34 }, () => 0x01),
        0x02,
        0x01,
        0x01,
      ])
    ).toBeNull();
    // Small but well-formed integers are left-padded.
    const raw = bad([0x30, 0x06, 0x02, 0x01, 0x05, 0x02, 0x01, 0x07]);
    expect(raw).not.toBeNull();
    expect(raw![31]).toBe(5);
    expect(raw![63]).toBe(7);
    expect(raw!.subarray(0, 31).every((b) => b === 0)).toBe(true);
  });

  test("a signature over other bytes, or by another key, does not verify", async () => {
    const key = makeTestReleaseKey();
    const other = makeTestReleaseKey();
    const data = new TextEncoder().encode("squirrel-binary-bytes");
    const tampered = new TextEncoder().encode("squirrel-binary-bytez");
    expect(
      await verifyReleaseSignature(key.pem, key.sign(data), tampered)
    ).toBe(false);
    expect(await verifyReleaseSignature(key.pem, other.sign(data), data)).toBe(
      false
    );
  });
});

describe("first_signed_version", () => {
  const fixture = JSON.parse(
    readFileSync(`${ROOT}scripts/fixtures/version-compare.json`, "utf8")
  ) as {
    compare: { a: string; b: string; cmp: number }[];
    era: { first: string; version: string; era: boolean }[];
  };
  const withFirst = (first: string) => ({
    keys: [],
    revokedKeyIds: [],
    firstSignedVersion: first,
  });

  test("the shared table decides the era the same way install.sh and install.ps1 do", () => {
    expect(fixture.era.length).toBeGreaterThan(10);
    for (const c of fixture.era)
      expect([
        c.first,
        c.version,
        isSignedEra({ ...withFirst(c.first), keys: [] }, c.version),
      ]).toEqual([c.first, c.version, c.era]);
  });

  test("the shared comparison table orders versions semver-correctly", async () => {
    const { compareVersions } = await import("@/self/releases");
    for (const c of fixture.compare)
      expect([c.a, c.b, Math.sign(compareVersions(c.a, c.b))]).toEqual([
        c.a,
        c.b,
        c.cmp,
      ]);
  });

  test("it is parsed, defaults to a strict string, and needs a pinned key to be set", () => {
    const key = makeTestReleaseKey();
    const pinnedFile = emptyFile();
    pinnedFile.keys[0] = { slot: "current", id: key.id, pem: key.pem };
    expect(parseReleaseKeys(pinnedFile).firstSignedVersion).toBe("");
    expect(
      parseReleaseKeys({ ...pinnedFile, first_signed_version: "0.0.190" })
        .firstSignedVersion
    ).toBe("0.0.190");
    expect(() =>
      parseReleaseKeys({ ...emptyFile(), first_signed_version: undefined })
    ).toThrow("must be a string");
    expect(() =>
      parseReleaseKeys({ ...pinnedFile, first_signed_version: "soon" })
    ).toThrow("must look like");
    expect(() =>
      parseReleaseKeys({ ...emptyFile(), first_signed_version: "0.0.190" })
    ).toThrow("no key is pinned");
  });

  test("the checked-in file leaves it unset until the maintainer pins the key", () => {
    expect(getPinnedReleaseKeys().firstSignedVersion).toBe("");
  });
});
