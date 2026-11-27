// Shared classifier for internal details a response should not show a visitor:
// filesystem paths, stack traces, framework debug pages and database errors (#2334).
// Version numbers in headers belong to security/version-disclosure and are not read here.

export type DisclosureKind =
  | "filesystem-path"
  | "stack-trace"
  | "debug-page"
  | "database-error";

export interface Disclosure {
  kind: DisclosureKind;
  /** Short name of what matched, e.g. `Python traceback`. */
  label: string;
  /** The matched text with its surroundings collapsed to one line, at most {@link MAX_SNIPPET} characters. */
  snippet: string;
}

/** Longest snippet quoted: the site chose the text, so it can run to kilobytes. */
export const MAX_SNIPPET = 160;

/** Longest text scanned. A debug page puts its signal early; the cap bounds the work on a huge body. */
export const MAX_SCAN_CHARS = 200_000;

interface Signature {
  kind: DisclosureKind;
  label: string;
  re: RegExp;
}

// Every quantifier is bounded: the text is chosen by the website under audit.
const SIGNATURES: readonly Signature[] = [
  // Stack traces
  {
    kind: "stack-trace",
    label: "Python traceback",
    re: /Traceback \(most recent call last\):[\s\S]{0,200}?File "[^"\n]{1,200}", line \d{1,6}/,
  },
  {
    kind: "stack-trace",
    label: "Java stack trace",
    re: /\bat [\w$.]{1,120}\([\w$]{1,80}\.(?:java|kt|scala):\d{1,6}\)/,
  },
  {
    kind: "stack-trace",
    label: "Java exception",
    re: /\b(?:java|javax|org\.springframework)\.[\w.]{1,100}(?:Exception|Error)\b(?::[^\n]{0,80})?\s{1,40}at [\w$.]{1,120}\(/,
  },
  {
    kind: "stack-trace",
    label: "Node.js stack trace",
    re: /\bat (?:[\w$.<>\s]{1,80} \()?(?:\/|[A-Za-z]:\\|file:\/\/|node:)[^\s)]{1,200}:\d{1,6}:\d{1,6}\)?/,
  },
  {
    kind: "stack-trace",
    label: "PHP stack trace",
    re: /(?:Stack trace:\s{0,10}#0 |#0 [^\n]{1,200}\.php\(\d{1,6}\):)/,
  },
  {
    kind: "stack-trace",
    label: "PHP error",
    re: /\b(?:Fatal error|Parse error|Warning|Notice): [^\n]{1,200} in (?:\/|[A-Za-z]:\\)[^\s]{1,200}\.php on line \d{1,6}/,
  },
  {
    kind: "stack-trace",
    label: ".NET stack trace",
    re: /\bat [\w.<>`+]{1,120}\([^)\n]{0,120}\) in (?:\/|[A-Za-z]:\\)[^\n]{1,200}:line \d{1,6}/,
  },
  {
    kind: "stack-trace",
    label: "Ruby backtrace",
    re: /(?:\/|[A-Za-z]:\\)[^\s:]{1,200}\.rb:\d{1,6}:in [`'][^'\n]{1,80}'/,
  },
  // Framework debug pages
  {
    kind: "debug-page",
    label: "Laravel debug page",
    re: /Whoops! There was an error|Illuminate\\(?:Database|Foundation|Routing|Http)\\[\w\\]{1,100}/,
  },
  {
    kind: "debug-page",
    label: "Symfony debug page",
    re: /Symfony\\Component\\[\w\\]{1,100}|<title>[^<]{0,200}\(\d{3} [A-Za-z ]{1,40}\)<\/title>[\s\S]{0,400}?Symfony Profiler/,
  },
  {
    kind: "debug-page",
    label: "Django debug page",
    re: /You're seeing this error because you have <code>DEBUG = True<\/code>|You're seeing this error because you have DEBUG = True/,
  },
  {
    kind: "debug-page",
    label: "Rails debug page",
    re: /Action Controller: Exception caught|<h1>\s{0,20}[\w:]{1,80}\s{1,20}in [\w:]{1,80}Controller#\w{1,60}\s{0,20}<\/h1>|ActionController::RoutingError|ActiveRecord::\w{1,60}/,
  },
  {
    kind: "debug-page",
    label: "ASP.NET error page",
    re: /Server Error in '[^']{1,80}' Application|Stack Trace:\s{0,10}<\/b>|System\.Web\.[\w.]{1,80}Exception/,
  },
  {
    kind: "debug-page",
    label: "Werkzeug or Flask debugger",
    re: /Werkzeug Debugger|The debugger caught an exception in your WSGI application/,
  },
  // Database errors
  {
    kind: "database-error",
    label: "SQLSTATE error",
    re: /SQLSTATE\[[0-9A-Z]{5}\]/,
  },
  {
    kind: "database-error",
    label: "Oracle error",
    re: /\bORA-\d{5}\b/,
  },
  {
    kind: "database-error",
    label: "PostgreSQL error",
    re: /\bPG::[A-Z]\w{2,60}|ERROR:\s{1,5}(?:syntax error at or near|relation "[^"\n]{1,80}" does not exist|column "[^"\n]{1,80}" does not exist)/,
  },
  {
    kind: "database-error",
    label: "MySQL error",
    re: /You have an error in your SQL syntax|\bmysqli?(?:_sql_exception|_query\(\)|::\w{1,40})|\bmysqli_\w{1,40}\(\)|Warning: mysql_\w{1,40}\(\)|MySQLSyntaxErrorException|com\.mysql\.jdbc\./,
  },
  {
    kind: "database-error",
    label: "SQL Server error",
    re: /Unclosed quotation mark after the character string|Microsoft OLE DB Provider for SQL Server|\[Microsoft\]\[ODBC [^\]\n]{1,60}\]|System\.Data\.SqlClient\.SqlException/,
  },
  {
    kind: "database-error",
    label: "SQLite error",
    re: /SQLite3?::\w{1,40}Exception|sqlite3\.OperationalError|SQLITE_ERROR/,
  },
  // Absolute filesystem paths (last: the weakest signal, so a stronger label wins)
  {
    kind: "filesystem-path",
    label: "Server filesystem path",
    re: /(?:^|[\s"'(=:>])(?:\/var\/www(?:\/[\w.-]{1,80}){1,12}|\/home\/[\w.-]{1,40}\/(?:public_html|www|htdocs|domains|[\w.-]{1,80})\/[\w./-]{1,160}|\/usr\/(?:local\/)?(?:lib|share)\/[\w.-]{1,40}\/[\w./-]{1,160}|\/srv\/(?:www|http)\/[\w./-]{1,160}|\/opt\/[\w.-]{1,40}\/[\w./-]{1,160}|\/Users\/[\w.-]{1,40}\/[\w./-]{1,160}|[A-Za-z]:\\(?:inetpub|xampp|wamp|Users|Windows|Program Files)\\[\w .\\-]{1,160})/,
  },
];

function toSnippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 20);
  const raw = text.slice(start, index + Math.min(length, MAX_SNIPPET));
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SNIPPET
    ? `${flat.slice(0, MAX_SNIPPET - 3)}...`
    : flat;
}

/**
 * The first internal detail in `text`, or null. Signatures are tried most
 * specific first (traces, debug pages, database errors, then bare paths), and
 * only the first {@link MAX_SCAN_CHARS} characters are read. `paths: false`
 * skips bare filesystem paths, which tutorials and docs quote on healthy pages.
 */
export function classifyDisclosure(
  text: string,
  options: { paths?: boolean } = {}
): Disclosure | null {
  const scanned =
    text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  for (const sig of SIGNATURES) {
    if (sig.kind === "filesystem-path" && options.paths === false) continue;
    const m = sig.re.exec(scanned);
    if (m) {
      return {
        kind: sig.kind,
        label: sig.label,
        snippet: toSnippet(scanned, m.index, m[0].length),
      };
    }
  }
  return null;
}
