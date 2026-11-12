// safeRedirectFetch's shouldFollow hook hands back an unfollowed 3xx (#1655).

import { describe, expect, test } from "bun:test";

import { safeRedirectFetch } from "../src/safe-fetch";

describe("safeRedirectFetch shouldFollow", () => {
  const sent: string[] = [];
  const send = async (url: string): Promise<Response> => {
    sent.push(url);
    return url.endsWith("/a")
      ? new Response(null, { status: 302, headers: { location: "https://example.com/b" } })
      : new Response("ok");
  };

  test("a vetoed hop is not requested and is named on the result", async () => {
    sent.length = 0;
    const result = await safeRedirectFetch("https://example.com/a", {}, send, () => false);
    expect(sent).toEqual(["https://example.com/a"]);
    expect(result.unfollowed).toBe("https://example.com/b");
    expect(result.response.status).toBe(302);
  });

  test("an allowed hop is followed as before", async () => {
    sent.length = 0;
    const result = await safeRedirectFetch("https://example.com/a", {}, send, () => true);
    expect(sent).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(result.unfollowed).toBeUndefined();
  });
});
