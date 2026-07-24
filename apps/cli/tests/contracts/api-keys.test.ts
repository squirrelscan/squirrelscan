// Shared API-key prefix contract (@squirrelscan/core-contracts/api-keys).
// Lives in the CLI test tree because core-contracts has no test runner wired.

import {
  API_KEY_PREFIXES_LONGEST_FIRST,
  CLI_LOGIN_TOKEN_PREFIX,
  isApiKey,
  isCliLoginToken,
  keyPrefixForEnv,
  parseKeyEnv,
} from "@squirrelscan/core-contracts/api-keys";
import { describe, expect, test } from "bun:test";

describe("api-key prefixes", () => {
  test("env → prefix mapping is the single source of truth", () => {
    expect(keyPrefixForEnv("production")).toBe("sq_");
    expect(keyPrefixForEnv("development")).toBe("sq_dev_");
  });

  test("prefixes are ordered longest-first so sq_dev_ wins over sq_", () => {
    expect(API_KEY_PREFIXES_LONGEST_FIRST[0]).toBe("sq_dev_");
    expect(API_KEY_PREFIXES_LONGEST_FIRST[1]).toBe("sq_");
  });

  test("parseKeyEnv recovers the env from the prefix (dev before prod)", () => {
    expect(parseKeyEnv("sq_dev_abc123")).toBe("development");
    expect(parseKeyEnv("sq_abc123")).toBe("production");
  });

  test("parseKeyEnv returns null for non-API-key tokens", () => {
    expect(parseKeyEnv("sqcli_abc123")).toBeNull();
    expect(parseKeyEnv("random")).toBeNull();
    expect(parseKeyEnv("")).toBeNull();
  });

  test("isApiKey / isCliLoginToken never confuse sqcli_ with sq_", () => {
    // The CLI login token starts with "sq" but must NOT be treated as an API key.
    expect(isCliLoginToken(`${CLI_LOGIN_TOKEN_PREFIX}xyz`)).toBe(true);
    expect(isApiKey(`${CLI_LOGIN_TOKEN_PREFIX}xyz`)).toBe(false);

    expect(isApiKey("sq_xyz")).toBe(true);
    expect(isApiKey("sq_dev_xyz")).toBe(true);
    expect(isCliLoginToken("sq_xyz")).toBe(false);
  });
});
