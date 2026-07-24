import { describe, expect, test } from "bun:test";

const shellInstaller = await Bun.file(new URL("../install.sh", import.meta.url)).text();
const powershellInstaller = await Bun.file(new URL("../install.ps1", import.meta.url)).text();
const npmPostinstall = await Bun.file(
  new URL("../npm/scripts/postinstall.js", import.meta.url),
).text();

describe("installer privacy and supply-chain contracts", () => {
  test("NO_TELEMETRY uses presence semantics in both standalone installers", () => {
    expect(shellInstaller).toContain('[ "${NO_TELEMETRY+x}" = x ]');
    expect(powershellInstaller).toContain("Test-Path Env:NO_TELEMETRY");
  });

  test("npm postinstall does not invoke package runners or install global tools", () => {
    expect(npmPostinstall).not.toContain("npxCmd");
    expect(npmPostinstall).not.toContain('["skills", "add"');
    expect(npmPostinstall).not.toContain('"-g"');
  });
});
