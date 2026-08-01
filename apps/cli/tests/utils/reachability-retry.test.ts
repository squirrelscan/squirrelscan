// The pre-flight probe aborts the whole audit before any crawling, so one
// transient blip used to discard a run that would otherwise succeed (#1408).
// It now retries transient failures only — definitive answers (DNS, refused,
// bad certificate) still fail on the first attempt so dead hosts stay fast.
import { describe, expect, test } from "bun:test";

import {
  checkReachability,
  isTransientReachabilityError,
  REACHABILITY_MAX_ATTEMPTS,
} from "../../src/utils/reachability";

describe("isTransientReachabilityError", () => {
  test("retries timeouts and socket/network blips", () => {
    for (const message of [
      "Connection timed out",
      "request timeout",
      "fetch failed",
      "socket hang up",
      "ECONNRESET",
      "network error",
    ]) {
      expect(isTransientReachabilityError(message)).toBe(true);
    }
  });

  test("does not retry definitive failures", () => {
    for (const message of [
      "DNS lookup failed - domain may not exist",
      "Host not found",
      "Connection refused - server may be down",
      "SSL/TLS error - certificate issue",
    ]) {
      expect(isTransientReachabilityError(message)).toBe(false);
    }
  });

  test("treats an absent error as non-transient", () => {
    expect(isTransientReachabilityError(undefined)).toBe(false);
  });
});

describe("checkReachability retry", () => {
  test("recovers when the first attempt fails transiently", async () => {
    // A raw TCP listener, not Bun.serve: a handler that throws yields an HTTP
    // 500, which the probe correctly counts as reachable. The transient case is
    // a socket-level failure, so hang up on the first connection and answer the
    // second.
    let connections = 0;
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          connections++;
          if (connections === 1) {
            socket.end();
            return;
          }
          socket.write(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
          );
          socket.flush();
          socket.end();
        },
        data() {},
      },
    });

    try {
      const result = await checkReachability(
        `http://localhost:${server.port}/`
      );
      expect(result.reachable).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(connections).toBeGreaterThan(1);
    } finally {
      server.stop(true);
    }
  });

  test("a dead port is not retried to exhaustion", async () => {
    // Nothing is listening: connection refused is definitive, so this must
    // return after a single attempt rather than burning the retry budget.
    const started = Date.now();
    const result = await checkReachability("http://localhost:1/");
    expect(result.reachable).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("exposes a bounded attempt count", () => {
    expect(REACHABILITY_MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(REACHABILITY_MAX_ATTEMPTS).toBeLessThanOrEqual(3);
  });
});
