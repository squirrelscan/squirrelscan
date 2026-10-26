import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

const { httpsGet, resolveVersion } = require("./postinstall.js") as {
  httpsGet: (
    url: string,
    get?: typeof import("node:https").get,
  ) => Promise<{ data: Buffer; statusCode: number }>;
  resolveVersion: (
    env?: Record<string, string>,
    latest?: (channel: string) => Promise<string>,
  ) => Promise<{ version: string; message: string }>;
};
const packageVersion = require("../package.json").version as string;

function fakeHttpsGet(
  responses: Array<{ statusCode: number; location?: string; body?: string }>,
): { get: typeof import("node:https").get; urls: string[] } {
  const urls: string[] = [];
  const get = ((url: string, _options: unknown, callback: (response: EventEmitter) => void) => {
    urls.push(url);
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected request: ${url}`);

    const request = new EventEmitter() as EventEmitter & {
      setTimeout: () => void;
      destroy: () => void;
    };
    request.setTimeout = () => {};
    request.destroy = () => {};

    queueMicrotask(() => {
      const response = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: { location?: string };
        resume: () => void;
      };
      response.statusCode = next.statusCode;
      response.headers = { location: next.location };
      response.resume = () => {};
      callback(response);
      if (next.body) response.emit("data", Buffer.from(next.body));
      response.emit("end");
    });

    return request;
  }) as unknown as typeof import("node:https").get;

  return { get, urls };
}

describe("npm postinstall HTTPS downloads", () => {
  test("follows one relative redirect", async () => {
    const fake = fakeHttpsGet([
      { statusCode: 302, location: "/release/asset" },
      { statusCode: 200, body: "binary" },
    ]);

    const result = await httpsGet("https://example.com/start", fake.get);
    expect(result.data.toString()).toBe("binary");
    expect(fake.urls).toEqual([
      "https://example.com/start",
      "https://example.com/release/asset",
    ]);
  });

  test("rejects a fourth redirect", async () => {
    const fake = fakeHttpsGet([
      { statusCode: 302, location: "/one" },
      { statusCode: 302, location: "/two" },
      { statusCode: 302, location: "/three" },
      { statusCode: 302, location: "/four" },
    ]);

    await expect(httpsGet("https://example.com/start", fake.get)).rejects.toThrow(
      "Too many redirects (maximum 3)",
    );
    expect(fake.urls).toHaveLength(4);
  });

  test("rejects a redirect to a non-HTTPS URL explicitly", async () => {
    const fake = fakeHttpsGet([{ statusCode: 302, location: "http://example.com/asset" }]);

    await expect(httpsGet("https://example.com/start", fake.get)).rejects.toThrow(
      "Refusing non-HTTPS download URL",
    );
    expect(fake.urls).toHaveLength(1);
  });
});

describe("npm postinstall version resolution", () => {
  test("defaults to the version selected through npm", async () => {
    let contactedLatest = false;
    const result = await resolveVersion({}, async () => {
      contactedLatest = true;
      return "v9.9.9";
    });

    expect(result.version).toBe(`v${packageVersion}`);
    expect(contactedLatest).toBe(false);
  });

  test("normalizes an explicit pinned version", async () => {
    const result = await resolveVersion({ SQUIRREL_VERSION: "1.2.3" });
    expect(result.version).toBe("v1.2.3");
  });

  test("only follows latest when a channel is explicitly requested", async () => {
    const result = await resolveVersion(
      { SQUIRREL_CHANNEL: "beta" },
      async (channel) => (channel === "beta" ? "v2.0.0-beta.1" : "v1.0.0"),
    );
    expect(result.version).toBe("v2.0.0-beta.1");
  });
});
