import { afterEach, describe, expect, test } from "bun:test";

import type { GitHubRelease, ReleaseManifest } from "@/self/types";

import {
  fetchReleases,
  fetchManifest,
  checkForUpdates,
  compareVersions,
  getLatestRelease,
} from "@/self/releases";

const originalFetch = globalThis.fetch;

const mockManifest: ReleaseManifest = {
  version: "1.0.0",
  channel: "stable",
  released_at: "2026-01-01T00:00:00Z",
  binaries: {},
  release_notes_url: "https://example.com/notes",
};

const mockRelease: GitHubRelease = {
  tag_name: "v1.0.0",
  name: "v1.0.0",
  prerelease: false,
  draft: false,
  published_at: "2026-01-01T00:00:00Z",
  html_url: "https://github.com/squirrelscan/squirrelscan/releases/tag/v1.0.0",
  body: "release notes",
  assets: [
    {
      name: "manifest.json",
      browser_download_url: "https://example.com/manifest.json",
      size: 100,
    },
  ],
};

describe("releases noRetry option", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("fetchReleases with noRetry uses single request", async () => {
    let callCount = 0;

    globalThis.fetch = (async () => {
      callCount++;
      return new Response(JSON.stringify([mockRelease]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await fetchReleases({ noRetry: true });

    expect(result.ok).toBe(true);
    expect(callCount).toBe(1);
  });

  test("fetchManifest with noRetry uses single request", async () => {
    let callCount = 0;

    globalThis.fetch = (async () => {
      callCount++;
      return new Response(JSON.stringify(mockManifest), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await fetchManifest(mockRelease, { noRetry: true });

    expect(result.ok).toBe(true);
    expect(callCount).toBe(1);
  });

  test("fetchManifest rejects path-traversing release versions", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ...mockManifest, version: "../../bin" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const result = await fetchManifest(mockRelease, { noRetry: true });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toBe("Malformed release metadata response");
  });

  test("checkForUpdates resolves via the metadata endpoint in one call", async () => {
    const urls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);

      if (url.startsWith("https://install.squirrelscan.com/releases/")) {
        return new Response(JSON.stringify(mockManifest), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const result = await checkForUpdates("0.0.1", "stable", { noRetry: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.available).toBe(true);
      expect(result.data.latest_version).toBe("1.0.0");
      expect(result.data.release_url).toBe("https://example.com/notes");
    }
    // Endpoint-first: a single metadata fetch, no GitHub calls.
    expect(urls).toEqual(["https://install.squirrelscan.com/releases/stable"]);
  });

  test("checkForUpdates falls back to GitHub when the endpoint fails (noRetry threads through)", async () => {
    const urls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);

      if (url.startsWith("https://install.squirrelscan.com/")) {
        return new Response("nope", { status: 502 });
      }
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify([mockRelease]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // manifest asset request
      return new Response(JSON.stringify(mockManifest), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await checkForUpdates("0.0.1", "stable", { noRetry: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.available).toBe(true);
      expect(result.data.latest_version).toBe("1.0.0");
    }
    // Exactly 3 calls: endpoint (fails) + GitHub releases + manifest asset.
    expect(urls.length).toBe(3);
  });

  test("fetchReleases without noRetry retries on network error", async () => {
    let callCount = 0;

    globalThis.fetch = (async () => {
      callCount++;
      if (callCount <= 2) {
        throw new TypeError("fetch failed");
      }
      return new Response(JSON.stringify([mockRelease]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    // Without noRetry, should retry and eventually succeed
    const result = await fetchReleases();

    expect(result.ok).toBe(true);
    expect(callCount).toBeGreaterThan(1);
  });

  test("fetchReleases with noRetry fails on first network error", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const result = await fetchReleases({ noRetry: true });

    expect(result.ok).toBe(false);
  });
});

describe("compareVersions", () => {
  test("core version ordering", () => {
    expect(compareVersions("0.0.43", "0.0.38")).toBeGreaterThan(0);
    expect(compareVersions("0.0.38", "0.0.43")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v0.0.43", "0.0.43")).toBe(0);
  });

  test("stable outranks prerelease of the same version", () => {
    expect(compareVersions("0.0.43", "0.0.43-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("0.0.43-beta.1", "0.0.43")).toBeLessThan(0);
  });

  test("prerelease identifiers compare numerically", () => {
    expect(compareVersions("0.0.43-beta.2", "0.0.43-beta.1")).toBeGreaterThan(
      0
    );
    expect(compareVersions("0.0.43-beta.10", "0.0.43-beta.9")).toBeGreaterThan(
      0
    );
    expect(compareVersions("0.0.43-beta.1", "0.0.43-beta.1")).toBe(0);
  });

  test("fewer prerelease identifiers sort lower", () => {
    expect(compareVersions("0.0.43-beta", "0.0.43-beta.1")).toBeLessThan(0);
  });

  test("numeric prerelease identifiers sort below alphanumeric", () => {
    expect(compareVersions("0.0.43-1", "0.0.43-beta")).toBeLessThan(0);
  });

  test("prerelease against a newer core still loses", () => {
    expect(compareVersions("0.0.44-beta.1", "0.0.43")).toBeGreaterThan(0);
  });

  test("build metadata never affects precedence", () => {
    expect(compareVersions("1.0.0+build.2", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.1+build.2", "1.0.0-beta.1")).toBe(0);
    expect(compareVersions("1.0.0+build.9", "1.0.0-beta.1")).toBeGreaterThan(0);
  });
});

describe("getLatestRelease", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const makeRelease = (
    tag: string,
    overrides: Partial<GitHubRelease> = {}
  ): GitHubRelease => ({
    ...mockRelease,
    tag_name: tag,
    name: tag,
    ...overrides,
  });

  const mockFetchReleases = (releases: GitHubRelease[]) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(releases), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
  };

  test("picks highest semver, not most recently published", async () => {
    // A re-published old release has the newest published_at but must lose
    mockFetchReleases([
      makeRelease("v0.0.42", { published_at: "2026-06-12T00:00:00Z" }),
      makeRelease("v0.0.43", { published_at: "2026-06-11T00:00:00Z" }),
    ]);

    const result = await getLatestRelease("stable");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data?.tag_name).toBe("v0.0.43");
  });

  test("stable channel skips prereleases and drafts", async () => {
    mockFetchReleases([
      makeRelease("v0.0.44-beta.1", { prerelease: true }),
      makeRelease("v0.0.45", { draft: true, published_at: null }),
      makeRelease("v0.0.43"),
    ]);

    const result = await getLatestRelease("stable");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data?.tag_name).toBe("v0.0.43");
  });

  test("beta channel picks newest prerelease over older stable", async () => {
    mockFetchReleases([
      makeRelease("v0.0.43"),
      makeRelease("v0.0.44-beta.1", { prerelease: true }),
    ]);

    const result = await getLatestRelease("beta");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data?.tag_name).toBe("v0.0.44-beta.1");
  });

  test("beta channel prefers stable over its own prerelease", async () => {
    mockFetchReleases([
      makeRelease("v0.0.43-beta.2", { prerelease: true }),
      makeRelease("v0.0.43"),
    ]);

    const result = await getLatestRelease("beta");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data?.tag_name).toBe("v0.0.43");
  });
});
