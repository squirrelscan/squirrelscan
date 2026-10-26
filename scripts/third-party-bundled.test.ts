// #657: the notices generator finds packages a dependency bundles by their
// bundler's source markers. If a known bundler stops leaving markers, the scan
// finds nothing and its bundled packages would vanish from the notices; the
// guard turns that into an error instead.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { bundledPackages, isSilentBundler, silentBundlerError } from "./third-party-bundled";

let dir = "";

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function distWith(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "bundled-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

describe("bundled-package scan (#657)", () => {
  test("reads plain and scoped markers, and skips nested node_modules", () => {
    const found = bundledPackages(
      distWith({
        "dist/index.js": "//#region node_modules/.pnpm/ajv@8.18.0/node_modules/ajv/dist/ajv.js\n",
        "dist/other.mjs": "//#region node_modules/.pnpm/@scope+pkg@1.2.3/node_modules/@scope/pkg/x.js\n",
        "node_modules/dep/index.js": "//#region node_modules/.pnpm/ignored@9.9.9/node_modules/ignored/x.js\n",
      }),
    );
    expect([...found].sort()).toEqual(["@scope/pkg@1.2.3", "ajv@8.18.0"]);
  });

  test("a known bundler whose scan finds nothing is an error that says what to check", () => {
    const found = bundledPackages(distWith({ "dist/index.js": "export const x = 1;\n" }));
    expect(found.size).toBe(0);
    expect(isSilentBundler("@modelcontextprotocol/server", found)).toBe(true);
    expect(isSilentBundler("left-pad", found)).toBe(false);
    const message = silentBundlerError(["@modelcontextprotocol/server@2.0.0"]);
    expect(message).toContain("@modelcontextprotocol/server@2.0.0");
    expect(message).toContain("Check its dist for the bundled packages by hand");
    expect(message).toContain("scripts/third-party-embedded/");
    expect(silentBundlerError([])).toBeNull();
  });

  test("the installed @modelcontextprotocol/server still carries markers", () => {
    const cli = resolve(import.meta.dir, "..", "apps", "cli");
    const pkg = realpathSync(dirname(Bun.resolveSync("@modelcontextprotocol/server/package.json", cli)));
    const found = bundledPackages(pkg);
    expect(isSilentBundler("@modelcontextprotocol/server", found)).toBe(false);
    expect([...found].some((id) => id.startsWith("ajv@"))).toBe(true);
  });
});
