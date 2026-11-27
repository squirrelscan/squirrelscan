// security/info-disclosure: internal details in a response body (#2334).

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { CheckResult, RuleContext } from "../src/types";

import { infoDisclosureRule } from "../src/security/info-disclosure";
import { MAX_SNIPPET, classifyDisclosure } from "../src/shared/info-disclosure";

function run(
  body: string,
  statusCode = 200,
  headers: Record<string, string> = {}
): CheckResult[] {
  const html = `<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode, loadTime: 0, headers },
    parsed: parsePage(html, url),
    options: {},
    wantsItemSelectors: false,
  } as unknown as RuleContext;
  const result = infoDisclosureRule.run(ctx);
  if (result instanceof Promise) throw new Error("info-disclosure is sync");
  return result.checks;
}

describe("classifier", () => {
  const cases: [string, string, string][] = [
    [
      "stack-trace",
      "Python traceback",
      'Traceback (most recent call last):\n  File "/app/views.py", line 12, in index',
    ],
    [
      "stack-trace",
      "Java stack trace",
      "java.lang.NullPointerException\n\tat com.example.Foo.bar(Foo.java:42)",
    ],
    [
      "stack-trace",
      "Node.js stack trace",
      "Error: x\n    at handler (/srv/app/server.js:10:5)",
    ],
    [
      "stack-trace",
      "PHP stack trace",
      "Stack trace: #0 /var/www/html/index.php(10): foo()",
    ],
    [
      "stack-trace",
      "PHP error",
      "Warning: undefined variable in /var/www/html/a.php on line 3",
    ],
    ["debug-page", "Laravel debug page", "Whoops! There was an error."],
    [
      "debug-page",
      "Django debug page",
      "You're seeing this error because you have DEBUG = True in your settings",
    ],
    ["debug-page", "Rails debug page", "Action Controller: Exception caught"],
    ["debug-page", "ASP.NET error page", "Server Error in '/' Application."],
    [
      "debug-page",
      "Symfony debug page",
      "Symfony\\Component\\HttpKernel\\Exception\\NotFoundHttpException",
    ],
    [
      "database-error",
      "SQLSTATE error",
      "SQLSTATE[42S02]: Base table or view not found",
    ],
    [
      "database-error",
      "Oracle error",
      "ORA-00942: table or view does not exist",
    ],
    ["database-error", "PostgreSQL error", "PG::UndefinedTable: ERROR"],
    [
      "database-error",
      "MySQL error",
      "Warning: mysqli_connect(): (HY000/1045)",
    ],
    [
      "filesystem-path",
      "Server filesystem path",
      "Cannot open /var/www/site/config.php",
    ],
    [
      "filesystem-path",
      "Server filesystem path",
      "in /home/bob/public_html/index.php",
    ],
    [
      "filesystem-path",
      "Server filesystem path",
      "failed at C:\\inetpub\\wwwroot\\web.config",
    ],
  ];
  for (const [kind, label, text] of cases) {
    test(`${label}: ${text.slice(0, 30)}`, () => {
      const found = classifyDisclosure(text);
      expect(found?.kind).toBe(kind as never);
      expect(found?.label).toBe(label);
    });
  }

  test("snippet is bounded", () => {
    const found = classifyDisclosure(`ORA-00942 ${"x".repeat(5000)}`);
    expect(found?.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET);
  });

  test("repeated triggers still return", () => {
    expect(
      classifyDisclosure("Traceback (most recent call last):".repeat(5000))
    ).toBeNull();
    expect(classifyDisclosure("at ".repeat(60000))).toBeNull();
  });

  test("paths: false skips bare paths but keeps database errors", () => {
    expect(
      classifyDisclosure("see /var/www/site/a", { paths: false })
    ).toBeNull();
    expect(classifyDisclosure("SQLSTATE[HY000]", { paths: false })?.kind).toBe(
      "database-error"
    );
  });
});

describe("rule", () => {
  test("a styled 404 with no internal details passes", () => {
    const checks = run(
      "<main><h1>Page not found</h1><p>Sorry, that page does not exist. <a href='/'>Home</a></p></main>",
      404
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
  });

  test("a stack trace fails and quotes a bounded snippet", () => {
    const checks = run(
      `<pre>Traceback (most recent call last):\n  File "/app/views.py", line 12, in index ${"y".repeat(2000)}</pre>`,
      500
    );
    expect(checks[0]?.status).toBe("fail");
    expect(checks[0]?.details?.kind).toBe("stack-trace");
    expect(String(checks[0]?.details?.snippet).length).toBeLessThanOrEqual(
      MAX_SNIPPET
    );
  });

  test("a path on an error page fails, on a 200 page it does not", () => {
    const body = "<p>Could not read /var/www/site/config.php</p>";
    expect(run(body, 404)[0]?.status).toBe("fail");
    expect(run(body, 200)[0]?.status).toBe("pass");
  });

  test("a database error on a 200 page fails", () => {
    expect(run("<p>SQLSTATE[42S02]: Base table not found</p>")[0]?.status).toBe(
      "fail"
    );
  });

  test("text inside script and style is not read", () => {
    const checks = run(
      '<script>var e = "ORA-00942";</script><style>/* SQLSTATE[42S02] */</style><p>Hello</p>'
    );
    expect(checks[0]?.status).toBe("pass");
  });

  test("version headers are not reported here", () => {
    const checks = run("<p>Hello</p>", 200, {
      server: "nginx/1.18.0",
      "x-powered-by": "PHP/8.1.2",
    });
    expect(checks[0]?.status).toBe("pass");
  });
});
