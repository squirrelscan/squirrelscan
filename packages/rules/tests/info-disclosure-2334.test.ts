// security/info-disclosure: internal details in a response body (#2334).

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { CheckResult, RuleContext } from "../src/types";

import { infoDisclosureRule } from "../src/security/info-disclosure";
import {
  MAX_SNIPPET,
  classifyDisclosure,
  scansPathsFor,
} from "../src/shared/info-disclosure";

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
      "Symfony\\Component\\HttpKernel\\Exception\\NotFoundHttpException\n  at vendor/symfony/http-kernel/HttpKernel.php:152",
    ],
    [
      "debug-page",
      "Laravel debug page",
      "Illuminate\\Database\\Eloquent\\ModelNotFoundException\nNo query results\n  at vendor/laravel/framework/src/Builder.php:470",
    ],
    [
      "debug-page",
      "Rails debug page",
      "ActiveRecord::RecordNotFound\nRails.root: /app\nApplication Trace",
    ],
    [
      "database-error",
      "SQLSTATE error",
      "SQLSTATE[42S02]: Base table or view not found",
    ],
    [
      "database-error",
      "Oracle error",
      "java.sql.SQLSyntaxErrorException: ORA-00942: table or view does not exist",
    ],
    [
      "database-error",
      "Oracle error",
      "ORA-01403: no data found\nORA-06512: at line 5",
    ],
    [
      "database-error",
      "PostgreSQL error",
      'PG::UndefinedTable: ERROR:  relation "users" does not exist',
    ],
    [
      "database-error",
      "MySQL error",
      "Warning: mysqli_connect(): (HY000/1045)",
    ],
    [
      "database-error",
      "MySQL error",
      "mysqli_sql_exception: Table 'shop.users' doesn't exist in app/db.php:12",
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
    const found = classifyDisclosure(`SQLSTATE[42S02] ${"x".repeat(5000)}`);
    expect(found?.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET);
  });

  test("repeated triggers still return", () => {
    expect(
      classifyDisclosure("Traceback (most recent call last):".repeat(5000))
    ).toBeNull();
    expect(classifyDisclosure("at ".repeat(60000))).toBeNull();
    expect(classifyDisclosure("ActiveRecord::X ".repeat(12000))).toBeNull();
    expect(classifyDisclosure("ORA-00001: ".repeat(18000))).toBeNull();
  });

  // Documentation names framework and driver identifiers in prose; only a trace
  // or error shape next to one is a leak.
  const prose: [string, string][] = [
    [
      "Rails guide",
      "Rails raises ActiveRecord::RecordNotFound when find gets a missing id, and ActionController::RoutingError for an unknown route. Rescue ActiveRecord::RecordInvalid to show validation errors.",
    ],
    [
      "Symfony docs",
      "Throw Symfony\\Component\\HttpKernel\\Exception\\NotFoundHttpException from a controller to return a 404. The Symfony\\Component\\HttpFoundation\\Request class wraps the request.",
    ],
    [
      "Laravel docs",
      "If no model is found, an Illuminate\\Database\\Eloquent\\ModelNotFoundException is thrown. Type-hint Illuminate\\Http\\Request on your route closure.",
    ],
    [
      "php.net mysqli page",
      "mysqli::query -- mysqli_query - Performs a query on the database. Object-oriented style: public mysqli::query(string $query, int $result_mode = MYSQLI_STORE_RESULT): mysqli_result|bool. Procedural style: mysqli_query(mysqli $mysql, string $query). Errors throw mysqli_sql_exception when MYSQLI_REPORT_STRICT is set. See also mysqli_real_query() and mysqli_multi_query().",
    ],
    [
      "PostgreSQL gem docs",
      "The pg gem raises PG::UndefinedTable for a missing table and PG::UniqueViolation for a duplicate key.",
    ],
    [
      "Oracle error reference",
      "ORA-00942: table or view does not exist\nCause: The table or view entered does not exist.\nAction: Check the spelling.",
    ],
  ];
  for (const [name, text] of prose) {
    test(`${name} prose passes`, () => {
      expect(classifyDisclosure(text, { paths: false })).toBeNull();
    });
  }

  test("paths are scanned on error statuses only", () => {
    expect(scansPathsFor(200)).toBe(false);
    expect(scansPathsFor(399)).toBe(false);
    expect(scansPathsFor(400)).toBe(true);
    expect(scansPathsFor(500)).toBe(true);
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

  test("a trace laid out one line per table cell is found", () => {
    const checks = run(
      "<table><tr><td>java.lang.IllegalStateException: boom</td></tr><tr><td>at com.example.Foo.bar(Unknown Source)</td></tr></table>"
    );
    expect(checks[0]?.status).toBe("fail");
    expect(checks[0]?.details?.label).toBe("Java exception");
  });

  test("docs prose naming framework classes passes", () => {
    const checks = run(
      "<p>Rails raises <code>ActiveRecord::RecordNotFound</code> here.</p><p>See <code>mysqli::query</code> and <code>mysqli_query()</code>.</p>"
    );
    expect(checks[0]?.status).toBe("pass");
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
