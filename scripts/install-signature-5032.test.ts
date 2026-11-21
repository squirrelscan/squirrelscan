// Runs scripts/test-install-signature.sh (squirrelscan/repo#5032): install.sh's
// release-key signature check against the platform's REAL openssl, so CI
// exercises it on every run. The script itself is runnable on its own, which
// is how it is checked on macOS (LibreSSL): `bash scripts/test-install-signature.sh`.

import { describe, expect, test } from "bun:test";

const script = new URL("./test-install-signature.sh", import.meta.url).pathname;

describe("install.sh release-key signature, real openssl (repo#5032)", () => {
  test.skipIf(!Bun.which("openssl"))(
    "a signed release installs; tampered, unsigned, unpinned and revoked ones fail",
    async () => {
      const proc = Bun.spawn(["bash", script], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) console.error(stdout, stderr);
      expect(stdout).toMatch(/\n\d+ passed, 0 failed\n$/);
      expect(code).toBe(0);
    },
    120_000,
  );
});
