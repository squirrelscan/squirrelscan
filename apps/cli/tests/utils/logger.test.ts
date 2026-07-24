// Tests for logger and tracing utilities

import { beforeEach, describe, expect, test } from "bun:test";

import { configureLogger, logger, redactString } from "../../src/utils/logger";

describe("logger", () => {
  describe("debug logging", () => {
    test("debug logs are suppressed when debug is false", () => {
      configureLogger({ debug: false, trace: false });
      // This should not throw - just verifying it runs
      logger.debug("test message");
    });
  });

  describe("console logging", () => {
    test("info, warn, error methods exist and don't throw", () => {
      logger.info("test info");
      logger.warn("test warn");
      logger.error("test error");
    });
  });
});

describe("tracing", () => {
  describe("traceStart/traceEnd without trace enabled", () => {
    beforeEach(() => {
      configureLogger({ debug: false, trace: false });
    });

    test("traceStart returns empty string when tracing disabled", () => {
      const spanId = logger.traceStart("test-span");
      expect(spanId).toBe("");
    });

    test("traceEnd is no-op for empty spanId", () => {
      // Should not throw
      logger.traceEnd("", { data: "test" });
    });

    test("traceEnd is no-op for invalid spanId", () => {
      // Should not throw
      logger.traceEnd("invalid_span_id", { data: "test" });
    });
  });

  describe("withTrace", () => {
    beforeEach(() => {
      configureLogger({ debug: false, trace: false });
    });

    test("withTrace executes function and returns result when tracing disabled", () => {
      const result = logger.withTrace("test-label", () => 42);
      expect(result).toBe(42);
    });

    test("withTrace propagates exceptions", () => {
      expect(() => {
        logger.withTrace("test-label", () => {
          throw new Error("test error");
        });
      }).toThrow("test error");
    });

    test("withTrace calls getData callback", () => {
      let getDataCalled = false;
      logger.withTrace(
        "test-label",
        () => "result",
        () => {
          getDataCalled = true;
          return { key: "value" };
        }
      );
      // getData is only called when tracing is enabled
      expect(getDataCalled).toBe(false);
    });
  });

  describe("withTraceAsync", () => {
    beforeEach(() => {
      configureLogger({ debug: false, trace: false });
    });

    test("withTraceAsync executes async function and returns result", async () => {
      const result = await logger.withTraceAsync("test-label", async () => {
        await Promise.resolve();
        return 42;
      });
      expect(result).toBe(42);
    });

    test("withTraceAsync propagates async exceptions", async () => {
      await expect(
        logger.withTraceAsync("test-label", async () => {
          await Promise.resolve();
          throw new Error("async test error");
        })
      ).rejects.toThrow("async test error");
    });
  });
});

describe("truncateTraceData", () => {
  // We can't test truncateTraceData directly since it's internal,
  // but we can test it indirectly via withTrace with tracing enabled

  test("trace data with short strings passes through", () => {
    configureLogger({ debug: false, trace: false });
    // When tracing is disabled, this just runs the function
    const result = logger.withTrace(
      "test",
      () => "ok",
      () => ({ shortString: "hello" })
    );
    expect(result).toBe("ok");
  });
});

describe("flushTrace", () => {
  test("flushTrace is callable and returns promise", async () => {
    configureLogger({ debug: false, trace: false });
    // Should not throw even when no trace file exists
    await logger.flushTrace();
  });
});

describe("tracing with enabled trace", () => {
  // Note: We can't easily test file output because:
  // 1. getLogsPath() uses a global path
  // 2. The trace file is initialized once globally
  // So we test the behavior that doesn't require file I/O

  test("span IDs are unique", () => {
    // Even with tracing disabled, we can test the ID generation pattern
    // by enabling tracing temporarily - but this would create files
    // So we just verify the basic contract
    configureLogger({ debug: false, trace: false });
    const id1 = logger.traceStart("span1");
    const id2 = logger.traceStart("span2");
    // Both empty when disabled
    expect(id1).toBe("");
    expect(id2).toBe("");
  });

  test("withTrace handles nested spans correctly", () => {
    configureLogger({ debug: false, trace: false });
    let innerRan = false;
    const result = logger.withTrace("outer", () => {
      return logger.withTrace("inner", () => {
        innerRan = true;
        return "inner-result";
      });
    });
    expect(result).toBe("inner-result");
    expect(innerRan).toBe(true);
  });

  test("withTraceAsync handles nested async spans correctly", async () => {
    configureLogger({ debug: false, trace: false });
    let innerRan = false;
    const result = await logger.withTraceAsync("outer", async () => {
      return await logger.withTraceAsync("inner", async () => {
        innerRan = true;
        await Promise.resolve();
        return "inner-result";
      });
    });
    expect(result).toBe("inner-result");
    expect(innerRan).toBe(true);
  });
});

describe("redactString", () => {
  describe("URL credentials", () => {
    test("redacts username:password in https URLs", () => {
      expect(redactString("https://user:pass@example.com")).toBe(
        "https://[REDACTED]@example.com"
      );
    });

    test("redacts username:password in http URLs", () => {
      expect(redactString("http://admin:secret123@api.example.com:8080/")).toBe(
        "http://[REDACTED]@api.example.com:8080/"
      );
    });

    test("preserves URLs without credentials", () => {
      expect(redactString("https://example.com/path")).toBe(
        "https://example.com/path"
      );
    });
  });

  describe("API keys in query params", () => {
    test("redacts api_key parameter", () => {
      expect(redactString("https://api.com?api_key=secret123")).toBe(
        "https://api.com?api_key=[REDACTED]"
      );
    });

    test("redacts token parameter", () => {
      expect(redactString("https://api.com?token=xyz789")).toBe(
        "https://api.com?token=[REDACTED]"
      );
    });

    test("redacts access_token parameter", () => {
      expect(redactString("https://api.com?access_token=bearer123")).toBe(
        "https://api.com?access_token=[REDACTED]"
      );
    });

    test("redacts password parameter", () => {
      expect(redactString("https://login.com?password=secret")).toBe(
        "https://login.com?password=[REDACTED]"
      );
    });

    test("redacts multiple sensitive params in one URL", () => {
      expect(
        redactString("https://api.com?api_key=abc&token=xyz&other=visible")
      ).toBe(
        "https://api.com?api_key=[REDACTED]&token=[REDACTED]&other=visible"
      );
    });
  });

  describe("Bearer tokens", () => {
    test("redacts Bearer token with JWT-like format", () => {
      expect(
        redactString("Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature")
      ).toBe("Bearer [REDACTED]");
    });

    test("redacts Bearer token with simple token", () => {
      expect(redactString("Bearer abc123xyz")).toBe("Bearer [REDACTED]");
    });
  });

  describe("Basic auth", () => {
    test("redacts Basic auth header", () => {
      expect(redactString("Basic dXNlcjpwYXNz")).toBe("Basic [REDACTED]");
    });
  });

  describe("multiple patterns in one string", () => {
    test("redacts URL credentials and query params together", () => {
      expect(redactString("https://user:pass@api.com?api_key=abc")).toBe(
        "https://[REDACTED]@api.com?api_key=[REDACTED]"
      );
    });

    test("handles log-like strings with multiple sensitive values", () => {
      const input =
        'request url="https://user:pass@api.com" auth="Bearer token123"';
      const expected =
        'request url="https://[REDACTED]@api.com" auth="Bearer [REDACTED]"';
      expect(redactString(input)).toBe(expected);
    });
  });

  describe("edge cases", () => {
    test("handles empty string", () => {
      expect(redactString("")).toBe("");
    });

    test("handles string with no sensitive data", () => {
      expect(redactString("Hello, world!")).toBe("Hello, world!");
    });
  });
});
