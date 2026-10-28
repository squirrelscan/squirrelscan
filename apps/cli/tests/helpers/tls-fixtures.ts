// Locally generated TLS certificates for the tls-certificate tests (#712).
//
// Nothing here touches a live host. Each call builds a fresh root and
// intermediate, then signs leaves with openssl's CA mode, so expiry dates are
// exact: "expires in 20 days" is a leaf whose notAfter is 20 days and one hour
// from now. The served PEMs are answered by a local `node:tls` server on
// 127.0.0.1.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tls from "node:tls";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A private key and the PEM chain a server sends with it. */
export interface ServedCertificate {
  key: string;
  cert: string;
}

export interface TlsFixtures {
  /** The fixture root certificate, PEM. Pass it as `ca` to trust the chain. */
  root: string;
  /** Valid for localhost and 127.0.0.1, served with its intermediate. */
  valid: ServedCertificate;
  /** The same leaf, served without its intermediate. */
  leafOnly: ServedCertificate;
  expiresIn45Days: ServedCertificate;
  expiresIn20Days: ServedCertificate;
  expiresIn5Days: ServedCertificate;
  expired: ServedCertificate;
  /** Valid chain, but the leaf covers only other.test. */
  wrongName: ServedCertificate;
  /** Valid chain covering example.test and www.example.test. */
  example: ServedCertificate;
  /** Self-signed for localhost. */
  selfSigned: ServedCertificate;
  /** Full chain with an RSA-1024 leaf key. */
  weakKey: ServedCertificate;
  /** Full chain with an ECDSA P-256 leaf key, which has no RSA size to judge. */
  ecKey: ServedCertificate;
}

interface Authority {
  /** Directory of the openssl CA database this authority signs from. */
  caDir: string;
  certPath: string;
  keyPath: string;
  /** The certificate, PEM. */
  cert: string;
}

// tls-fixture.test is a public-looking name the pipeline tests route to these
// certificates; localhost and the loopback IP keep the direct socket tests.
const LOCAL_SAN =
  "subjectAltName=DNS:localhost,DNS:tls-fixture.test,IP:127.0.0.1";

export function createTlsFixtures(): TlsFixtures {
  const dir = mkdtempSync(join(tmpdir(), "squirrel-tls-"));
  const now = Date.now();
  const at = (days: number) => now + days * DAY_MS;

  const root = createAuthority(dir, "root", undefined, {
    subject: "/CN=squirrel test root",
    notBefore: now - DAY_MS,
    notAfter: at(3650),
    selfSigned: true,
  });
  const intermediate = createAuthority(dir, "int", root, {
    subject: "/CN=squirrel test intermediate",
    notBefore: now - DAY_MS,
    notAfter: at(3650),
  });

  const leaf = (
    name: string,
    span: {
      subject: string;
      san: string;
      notBefore: number;
      notAfter: number;
      rsaBits?: number;
      ec?: boolean;
    }
  ) => createLeaf(dir, name, intermediate, span);

  const valid = leaf("valid", {
    subject: "/CN=localhost",
    san: LOCAL_SAN,
    notBefore: now - DAY_MS,
    notAfter: at(365),
  });
  const expiresIn45 = leaf("in45", {
    subject: "/CN=localhost",
    san: LOCAL_SAN,
    notBefore: now - DAY_MS,
    notAfter: at(45) + HOUR_MS,
  });
  const expiresIn20 = leaf("in20", {
    subject: "/CN=localhost",
    san: LOCAL_SAN,
    notBefore: now - DAY_MS,
    notAfter: at(20) + HOUR_MS,
  });
  const expiresIn5 = leaf("in5", {
    subject: "/CN=localhost",
    san: LOCAL_SAN,
    notBefore: now - DAY_MS,
    notAfter: at(5) + HOUR_MS,
  });
  const expired = leaf("expired", {
    subject: "/CN=localhost",
    san: LOCAL_SAN,
    notBefore: at(-60),
    notAfter: at(-1),
  });
  const wrongName = leaf("wrong-name", {
    subject: "/CN=other.test",
    san: "subjectAltName=DNS:other.test",
    notBefore: now - DAY_MS,
    notAfter: at(365),
  });
  const weakKey = leaf("weak", {
    subject: "/CN=localhost",
    san: LOCAL_SAN,
    notBefore: now - DAY_MS,
    notAfter: at(365),
    rsaBits: 1024,
  });
  const ecKey = leaf("ec", {
    subject: "/CN=localhost",
    san: LOCAL_SAN,
    notBefore: now - DAY_MS,
    notAfter: at(365),
    ec: true,
  });
  const example = leaf("example", {
    subject: "/CN=example.test",
    san: "subjectAltName=DNS:example.test,DNS:www.example.test",
    notBefore: now - DAY_MS,
    notAfter: at(365),
  });
  const selfSigned = createSelfSigned(dir);

  const chain = (served: { key: string; cert: string }): ServedCertificate => ({
    key: served.key,
    cert: served.cert + intermediate.cert,
  });

  return {
    root: root.cert,
    valid: chain(valid),
    leafOnly: { key: valid.key, cert: valid.cert },
    expiresIn45Days: chain(expiresIn45),
    expiresIn20Days: chain(expiresIn20),
    expiresIn5Days: chain(expiresIn5),
    expired: chain(expired),
    wrongName: chain(wrongName),
    example: chain(example),
    selfSigned,
    weakKey: chain(weakKey),
    ecKey: chain(ecKey),
  };
}

export interface LocalTlsServer {
  port: number;
  close(): Promise<void>;
}

/** Serve one certificate on 127.0.0.1 on an ephemeral port. */
export function serveCertificate(
  served: ServedCertificate
): Promise<LocalTlsServer> {
  return new Promise((resolve, reject) => {
    const server = tls.createServer(
      { key: served.key, cert: served.cert },
      (socket) => {
        socket.end();
      }
    );
    server.on("tlsClientError", () => {});
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        port: address.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

interface AuthoritySpan {
  subject: string;
  notBefore: number;
  notAfter: number;
  selfSigned?: boolean;
}

function createAuthority(
  dir: string,
  name: string,
  signer: Authority | undefined,
  span: AuthoritySpan
): Authority {
  const caDir = join(dir, `ca-${name}`);
  prepareCaDatabase(caDir);
  const keyPath = join(dir, `${name}.key`);
  const certPath = join(dir, `${name}.pem`);
  if (span.selfSigned) {
    openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "3650",
      "-subj",
      span.subject,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ]);
  } else {
    const csr = join(dir, `${name}.csr`);
    openssl([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      csr,
      "-subj",
      span.subject,
    ]);
    const ext = writeExtensions(dir, name, [
      "basicConstraints=critical,CA:TRUE,pathlen:0",
      "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    signCsr(signer!, csr, certPath, ext, span);
  }
  return { caDir, certPath, keyPath, cert: read(certPath) };
}

function createLeaf(
  dir: string,
  name: string,
  signer: Authority,
  span: {
    subject: string;
    san: string;
    notBefore: number;
    notAfter: number;
    rsaBits?: number;
    ec?: boolean;
  }
): { key: string; cert: string } {
  const keyPath = join(dir, `${name}.key`);
  const csr = join(dir, `${name}.csr`);
  const certPath = join(dir, `${name}.pem`);
  if (span.ec) {
    openssl([
      "ecparam",
      "-name",
      "prime256v1",
      "-genkey",
      "-noout",
      "-out",
      keyPath,
    ]);
    openssl([
      "req",
      "-new",
      "-key",
      keyPath,
      "-out",
      csr,
      "-subj",
      span.subject,
    ]);
  } else {
    openssl([
      "req",
      "-new",
      "-newkey",
      `rsa:${span.rsaBits ?? 2048}`,
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      csr,
      "-subj",
      span.subject,
    ]);
  }
  const ext = writeExtensions(dir, name, [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    span.san,
  ]);
  signCsr(signer, csr, certPath, ext, span);
  return { key: read(keyPath), cert: read(certPath) };
}

function createSelfSigned(dir: string): ServedCertificate {
  const keyPath = join(dir, "self.key");
  const certPath = join(dir, "self.pem");
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "30",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  return { key: read(keyPath), cert: read(certPath) };
}

/** Sign `csr` with `signer` through `openssl ca`, with explicit validity dates. */
function signCsr(
  signer: Authority,
  csr: string,
  out: string,
  extensions: string,
  span: { notBefore: number; notAfter: number }
): void {
  const config = join(signer.caDir, "ca.cnf");
  writeFileSync(
    config,
    [
      "[ ca ]",
      "default_ca = CA",
      "[ CA ]",
      `database = ${join(signer.caDir, "index.txt")}`,
      `new_certs_dir = ${join(signer.caDir, "certs")}`,
      `serial = ${join(signer.caDir, "serial")}`,
      "default_md = sha256",
      "policy = policy",
      "unique_subject = no",
      "copy_extensions = none",
      "[ policy ]",
      "commonName = supplied",
      "",
    ].join("\n")
  );
  openssl([
    "ca",
    "-batch",
    "-config",
    config,
    "-cert",
    signer.certPath,
    "-keyfile",
    signer.keyPath,
    "-in",
    csr,
    "-out",
    out,
    "-extfile",
    extensions,
    "-extensions",
    "ext",
    "-startdate",
    openSslTime(span.notBefore),
    "-enddate",
    openSslTime(span.notAfter),
    "-notext",
  ]);
}

function prepareCaDatabase(caDir: string): void {
  mkdirSync(join(caDir, "certs"), { recursive: true });
  writeFileSync(join(caDir, "index.txt"), "");
  writeFileSync(join(caDir, "serial"), "1000\n");
}

function writeExtensions(dir: string, name: string, lines: string[]): string {
  const path = join(dir, `${name}.ext`);
  writeFileSync(path, ["[ ext ]", ...lines, ""].join("\n"));
  return path;
}

function openSslTime(ms: number): string {
  // openssl wants YYYYMMDDHHMMSSZ.
  return new Date(ms)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:T]/g, "");
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function openssl(args: string[]): void {
  try {
    execFileSync("openssl", args, { stdio: "pipe" });
  } catch (error) {
    const stderr =
      (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
    throw new Error(`openssl ${args[0]} failed: ${stderr}`, { cause: error });
  }
}
