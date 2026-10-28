// The certificate facts and what they mean (#712). This module is pure: the
// handshake is injected by the CLI (apps/cli/src/audit/tls-probe.ts), whose
// real-socket tests live in apps/cli/tests/audit/tls-probe.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  authorizationErrorCode,
  certificateCovers,
  certificateProblems,
  readPeerCertificate,
  tlsFailureCause,
  type TlsProbe,
} from "../src/tls-certificate";

const NOW = new Date();

describe("readPeerCertificate", () => {
  test("a SAN entry with a long run of whitespace is read in linear time (CodeQL polynomial-redos)", () => {
    const start = performance.now();
    const certificate = readPeerCertificate({
      subjectaltname: `DNS:a${"\t".repeat(200_000)}x, DNS:b${" ".repeat(200_000)}`,
      valid_from: "Jan  1 00:00:00 2025 GMT",
      valid_to: "Jan  1 00:00:00 2099 GMT",
    });
    expect(certificate?.names[1]).toBe("b");
    expect(performance.now() - start).toBeLessThan(500);
  });

  test("reads SAN entries, issuer, dates and the RSA size", () => {
    const certificate = readPeerCertificate({
      subjectaltname: "DNS:Example.com, DNS:*.example.com, IP Address:127.0.0.1",
      issuer: { O: "Test CA", CN: "Test Root" },
      valid_from: "Jan  1 00:00:00 2025 GMT",
      valid_to: "Jan  1 00:00:00 2099 GMT",
      modulus: "ABCDEF",
      bits: 2048,
    });
    expect(certificate).toEqual({
      names: ["example.com", "*.example.com", "127.0.0.1"],
      issuer: "Test CA",
      validFrom: new Date("2025-01-01T00:00:00Z"),
      validTo: new Date("2099-01-01T00:00:00Z"),
      rsaBits: 2048,
    });
  });

  test("an EC key has no RSA size, and no SAN means no names", () => {
    const certificate = readPeerCertificate({
      issuer: { CN: "Only CN" },
      valid_from: "Jan  1 00:00:00 2025 GMT",
      valid_to: "Jan  1 00:00:00 2099 GMT",
      bits: 256,
    });
    expect(certificate?.rsaBits).toBeUndefined();
    expect(certificate?.names).toEqual([]);
    expect(certificate?.issuer).toBe("Only CN");
  });

  test("server-chosen text loses control characters and is bounded", () => {
    const certificate = readPeerCertificate({
      subjectaltname: [
        "DNS:evil\u001b[31m.example.com",
        `DNS:${"a".repeat(400)}.example.com`,
        ...Array.from({ length: 1_500 }, (_, i) => `DNS:host${i}.example.com`),
      ].join(", "),
      issuer: { O: "Bad\u0007 CA\u0000" },
      valid_from: "Jan  1 00:00:00 2025 GMT",
      valid_to: "Jan  1 00:00:00 2099 GMT",
    });
    expect(certificate?.names[0]).toBe("evil[31m.example.com");
    expect(certificate?.names[1]?.length).toBe(253);
    expect(certificate?.names).toHaveLength(1_000);
    expect(certificate?.issuer).toBe("Bad CA");
  });

  test("an empty or dateless result is no certificate", () => {
    expect(readPeerCertificate(undefined)).toBeUndefined();
    expect(readPeerCertificate({})).toBeUndefined();
  });
});

describe("authorizationErrorCode", () => {
  test("reads a code from an Error, a string, or nothing", () => {
    expect(authorizationErrorCode(undefined)).toBeUndefined();
    expect(authorizationErrorCode(null)).toBeUndefined();
    expect(authorizationErrorCode("DEPTH_ZERO_SELF_SIGNED_CERT")).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    expect(authorizationErrorCode(Object.assign(new Error("x"), { code: "CERT_HAS_EXPIRED" }))).toBe(
      "CERT_HAS_EXPIRED",
    );
    expect(authorizationErrorCode(new Error("plain message"))).toBe("plain message");
  });
});

describe("certificateProblems", () => {
  const served = (trustError?: string, names = ["example.com"]): Extract<TlsProbe, { kind: "certificate" }> => ({
    kind: "certificate",
    certificate: {
      names,
      issuer: "Test CA",
      validFrom: new Date("2020-01-01T00:00:00Z"),
      validTo: new Date("2099-01-01T00:00:00Z"),
    },
    trusted: trustError === undefined,
    ...(trustError !== undefined ? { trustError } : {}),
  });

  test("maps the runtime's chain verdict to a problem", () => {
    expect(certificateProblems(served(), "example.com", NOW)).toEqual([]);
    expect(certificateProblems(served("DEPTH_ZERO_SELF_SIGNED_CERT"), "example.com", NOW)).toEqual([
      { kind: "self-signed" },
    ]);
    expect(certificateProblems(served("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), "example.com", NOW)).toEqual([
      { kind: "incomplete-chain" },
    ]);
    expect(certificateProblems(served("SELF_SIGNED_CERT_IN_CHAIN"), "example.com", NOW)).toEqual([
      { kind: "untrusted-root", code: "SELF_SIGNED_CERT_IN_CHAIN" },
    ]);
  });

  test("a name mismatch is reported once, from the names, not again from the chain", () => {
    expect(
      certificateProblems(served("ERR_TLS_CERT_ALTNAME_INVALID", ["other.test"]), "example.com", NOW),
    ).toEqual([{ kind: "hostname", hostname: "example.com", names: ["other.test"] }]);
  });
});

describe("certificateCovers", () => {
  test("matches exact names case-insensitively", () => {
    expect(certificateCovers(["example.com"], "Example.COM")).toBe(true);
    expect(certificateCovers(["example.com"], "www.example.com")).toBe(false);
  });

  test("a wildcard covers exactly one label", () => {
    const names = ["*.example.com"];
    expect(certificateCovers(names, "www.example.com")).toBe(true);
    expect(certificateCovers(names, "example.com")).toBe(false);
    expect(certificateCovers(names, "a.b.example.com")).toBe(false);
  });

  test("an IP address is covered only by an IP entry", () => {
    expect(certificateCovers(["127.0.0.1"], "127.0.0.1")).toBe(true);
    expect(certificateCovers([], "localhost")).toBe(false);
  });

  test("an IPv6 SAN matches the address in any spelling", () => {
    // The runtime prints an IP SAN expanded and uppercase; a URL holds it compressed.
    expect(certificateCovers(["2001:DB8:0:0:0:0:0:1"], "2001:db8::1")).toBe(true);
    expect(certificateCovers(["2001:db8::1"], "[2001:DB8:0:0:0:0:0:1]")).toBe(true);
    expect(certificateCovers(["2001:db8::1"], "2001:db8::2")).toBe(false);
  });

  test("a root dot on either side does not change the name", () => {
    expect(certificateCovers(["example.com."], "example.com")).toBe(true);
    expect(certificateCovers(["*.example.com"], "www.example.com.")).toBe(true);
  });
});

describe("tlsFailureCause", () => {
  const base = { trusted: false } as const;
  const certAt = (validTo: Date, names: string[] = ["example.com"]) => ({
    kind: "certificate" as const,
    ...base,
    certificate: {
      names,
      issuer: "Test CA",
      validFrom: new Date("2019-01-01T00:00:00Z"),
      validTo,
    },
  });

  test("names an expired certificate by its end date", () => {
    const cause = tlsFailureCause(
      certAt(new Date("2020-01-15T00:00:00Z"), ["example.com"]),
      "example.com",
      NOW,
    );
    expect(cause).toBe("certificate has expired on 2020-01-15");
  });

  test("names the hostname the certificate does not cover", () => {
    const probe = { ...certAt(new Date("2099-01-01T00:00:00Z"), ["other.test"]), trustError: "ERR_TLS_CERT_ALTNAME_INVALID" };
    expect(tlsFailureCause(probe, "example.com", NOW)).toBe(
      "hostname/IP does not match: the certificate does not cover example.com",
    );
  });

  test("names a missing intermediate", () => {
    const probe = { ...certAt(new Date("2099-01-01T00:00:00Z")), trustError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" };
    expect(tlsFailureCause(probe, "example.com", NOW)).toContain("did not send its intermediate");
  });

  test("returns nothing when the handshake found no problem or could not look", () => {
    expect(tlsFailureCause({ kind: "unavailable", reason: "no tls" }, "example.com", NOW)).toBeUndefined();
    const valid = { ...certAt(new Date("2099-01-01T00:00:00Z")), trusted: true };
    expect(tlsFailureCause(valid, "example.com", NOW)).toBeUndefined();
  });
});

describe("shared packages open no raw socket", () => {
  // #716: a raw socket from a shared package would go around the hosted
  // engine's request-level network policy. The TLS handshake is injected
  // (`TlsProbeFn`); only apps/cli holds one. `isIP` from node:net is an
  // address helper, not a socket, and stays allowed; type-only imports open
  // nothing. Tests are not shipped, and their fixture servers are sockets.
  const packagesRoot = join(import.meta.dir, "..", "..");
  const files = [...new Bun.Glob("*/src/**/*.{ts,tsx,js,mjs,cjs}").scanSync({ cwd: packagesRoot })].filter(
    (file) => !/\.test\.[cm]?[jt]sx?$/.test(file),
  );
  const SOCKET_MODULE =
    /(?:(?:import|export)\s*(\{[^}]*\}|\*\s+as\s+\w+|\*|\w+)?\s*(?:from\s*)?|import\s*\(\s*|require\s*\(\s*)["'](?:node:)?(tls|net|http2|dgram)["']/g;
  const BUN_SOCKET_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']bun["']/g;
  const BUN_SOCKET_CALL = /\bBun\.(?:connect|listen|udpSocket)\s*\(/g;
  const IS_IP_ONLY = /^\{\s*isIP(?:v4|v6)?(?:\s*,\s*isIP(?:v4|v6)?)*\s*\}$/;

  function offendersIn(text: string): string[] {
    const found: string[] = [];
    for (const match of text.matchAll(SOCKET_MODULE)) {
      const [, bindings = "", module] = match;
      if (module === "net" && IS_IP_ONLY.test(bindings.trim())) continue;
      found.push(match[0]);
    }
    for (const match of text.matchAll(BUN_SOCKET_IMPORT)) {
      if (/\b(?:connect|listen|udpSocket)\b/.test(match[1]!)) found.push(match[0]);
    }
    for (const match of text.matchAll(BUN_SOCKET_CALL)) found.push(match[0]);
    return found;
  }

  test("the scan sees the shared packages", () => {
    for (const pkg of ["utils", "rules", "crawler", "audit-engine", "fetchers"]) {
      expect(files.some((file) => file.startsWith(`${pkg}/`))).toBe(true);
    }
  });

  test("the scan catches every way in", () => {
    for (const source of [
      'import * as tls from "node:tls";',
      'import { connect } from "tls";',
      'const tls = await import("node:tls");',
      'export * from "node:tls";',
      'export { connect } from "node:tls";',
      'import { isIP, createConnection } from "node:net";',
      'const net = require("net");',
      'import http2 from "node:http2";',
      'import { createSocket } from "node:dgram";',
      'import { connect } from "bun";',
      "await Bun.connect({ hostname, port, socket });",
    ]) {
      expect(offendersIn(source)).not.toEqual([]);
    }
    expect(offendersIn('import { isIP } from "node:net";')).toEqual([]);
    expect(offendersIn('import type { TLSSocket } from "node:tls";')).toEqual([]);
  });

  test("no shared package opens one", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const found of offendersIn(readFileSync(join(packagesRoot, file), "utf8"))) {
        offenders.push(`${relative(packagesRoot, join(packagesRoot, file))}: ${found}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
