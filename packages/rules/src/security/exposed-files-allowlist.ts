// The curated allowlist for security/exposed-files (#1932): every path the rule
// may request, how it is requested, and the content signature that confirms a
// hit. Pure: sends nothing.
//
// The list is fixed and versioned, not a wordlist. Adding a path means adding a
// signature that recognizes the file by what is in it (a magic number, a
// header line, a format only that file has), never by a 200 alone, and a test
// fixture for both the hit and a catch-all page that must not match.
//
// A signature reads the first EXPOSED_FILE_READ_CAP bytes of the body. It
// returns what the file reveals in general terms (a count, a kind of data) and
// never a value from the file: the finding is built only from what it returns.

/** Body bytes read per probe. Enough for every signature below; a longer file is cut. */
export const EXPOSED_FILE_READ_CAP = 16 * 1024;

/** Bump when the list or a signature changes, so two audits can say which list they ran. */
export const EXPOSED_FILES_LIST_VERSION = 1;

export type ExposedFileGroup = "vcs" | "secrets" | "server" | "cruft" | "backup";

/** `high` fails the check (secrets, source, data); `medium` warns (metadata, listings). */
export type ExposureSeverity = "high" | "medium";

/** What one probe got back, as a signature sees it. */
export interface ProbeAnswer {
  status: number;
  /** Lowercased `content-type`, or "". */
  contentType: string;
  headers: Headers;
  /** At most EXPOSED_FILE_READ_CAP decoded bytes. Empty for a HEAD. */
  bytes: Uint8Array;
  /** `bytes` as UTF-8. */
  text: string;
}

export interface SignatureMatch {
  /** A count or a kind of data, never a value from the file ("12 variables, 4 with secret-looking names"). */
  detail?: string;
}

export interface SensitiveFile {
  path: string;
  /** HEAD only for a file that must never be downloaded (a heap dump). */
  method: "GET" | "HEAD";
  group: ExposedFileGroup;
  severity: ExposureSeverity;
  /** The kind of data the file exposes, in the finding. */
  reveals: string;
  /** The name of the signature that confirmed it, in the finding. */
  signature: string;
  match(answer: ProbeAnswer): SignatureMatch | null;
}

// ── helpers ─────────────────────────────────────────────────────────

function startsWithBytes(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + magic.length) return false;
  return magic.every((b, i) => bytes[offset + i] === b);
}

/** An HTML page: the catch-all answer most sites give for any path. */
export function looksLikeHtml(answer: ProbeAnswer): boolean {
  if (answer.contentType.includes("html")) return true;
  const head = answer.text.slice(0, 1024).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || /<(head|body|script|div)[\s>]/.test(head);
}

function nonHtmlText(answer: ProbeAnswer): string | null {
  if (answer.bytes.byteLength === 0 || looksLikeHtml(answer)) return null;
  return answer.text;
}

/** Lines that carry content: no blanks, no `#` or `;` comments. */
function contentLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith(";"));
}

const ENV_LINE_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=/;
const SECRET_NAME_RE = /(KEY|SECRET|TOKEN|PASS|PWD|PRIVATE|CREDENTIAL|AUTH|DSN|DATABASE_URL|_URI$|_URL$)/i;

/** A dotenv file: every content line is KEY=VALUE. Counts names, never reads values. */
export function matchDotenv(answer: ProbeAnswer): SignatureMatch | null {
  const text = nonHtmlText(answer);
  if (text === null) return null;
  const lines = contentLines(text);
  if (lines.length === 0) return null;
  // The last line of a cut body may be partial; judge the complete ones.
  const judged = answer.bytes.byteLength >= EXPOSED_FILE_READ_CAP && lines.length > 1 ? lines.slice(0, -1) : lines;
  let secretLooking = 0;
  for (const line of judged) {
    const m = ENV_LINE_RE.exec(line);
    if (!m) return null;
    if (SECRET_NAME_RE.test(m[1]!)) secretLooking++;
  }
  const n = judged.length;
  const detail =
    secretLooking > 0
      ? `${n} variable(s), ${secretLooking} with secret-looking names`
      : `${n} variable(s)`;
  return { detail };
}

// ── the list ────────────────────────────────────────────────────────

const VCS_SOURCE = "version control metadata from which the site's source code and history can be rebuilt";

export const SENSITIVE_FILES: readonly SensitiveFile[] = [
  // VCS
  {
    path: "/.git/HEAD",
    method: "GET",
    group: "vcs",
    severity: "high",
    reveals: `Git ${VCS_SOURCE}`,
    signature: "git HEAD ref",
    match(a) {
      const text = nonHtmlText(a)?.trim();
      if (!text) return null;
      return /^ref: refs\/\S+$/.test(text) || /^[0-9a-f]{40}$/.test(text) ? {} : null;
    },
  },
  {
    path: "/.git/config",
    method: "GET",
    group: "vcs",
    severity: "high",
    reveals: "Git repository configuration: remote URLs, sometimes with embedded credentials",
    signature: "git config [core] section",
    match(a) {
      const text = nonHtmlText(a);
      if (!text) return null;
      if (!/^\s*\[core\]\s*$/m.test(text)) return null;
      if (!/^\s*(repositoryformatversion|filemode|bare)\s*=/m.test(text)) return null;
      return /^\s*\[remote\s+"/m.test(text) ? { detail: "names remote repositories" } : {};
    },
  },
  {
    path: "/.svn/entries",
    method: "GET",
    group: "vcs",
    severity: "high",
    reveals: `Subversion ${VCS_SOURCE}`,
    signature: "svn entries format",
    match(a) {
      const text = nonHtmlText(a);
      if (!text) return null;
      const trimmed = text.trim();
      // 1.7+ writes only the format number; 1.4-1.6 open with it, a blank line and `dir`.
      if (/^\d{1,2}$/.test(trimmed)) return {};
      if (/^\d{1,2}\r?\n\r?\ndir\r?\n/.test(text)) return {};
      return /<wc-entries[\s>]/.test(text) ? {} : null;
    },
  },
  {
    path: "/.hg/requires",
    method: "GET",
    group: "vcs",
    severity: "high",
    reveals: `Mercurial ${VCS_SOURCE}`,
    signature: "hg requires features",
    match(a) {
      const text = nonHtmlText(a);
      if (!text) return null;
      const lines = contentLines(text);
      if (lines.length === 0 || !lines.every((l) => /^[a-z0-9][a-z0-9.-]*$/.test(l))) return null;
      return lines.includes("revlogv1") || lines.includes("store") ? {} : null;
    },
  },
  // Secrets and configuration
  {
    path: "/.env",
    method: "GET",
    group: "secrets",
    severity: "high",
    reveals: "environment variables, typically API keys, database URLs and other secrets",
    signature: "KEY=VALUE lines",
    match: matchDotenv,
  },
  {
    path: "/.env.local",
    method: "GET",
    group: "secrets",
    severity: "high",
    reveals: "local environment variables, typically API keys, database URLs and other secrets",
    signature: "KEY=VALUE lines",
    match: matchDotenv,
  },
  {
    path: "/config.php.bak",
    method: "GET",
    group: "secrets",
    severity: "high",
    reveals: "PHP configuration source, typically database credentials",
    signature: "PHP source with configuration",
    match: matchPhpConfig,
  },
  {
    path: "/wp-config.php.bak",
    method: "GET",
    group: "secrets",
    severity: "high",
    reveals: "WordPress configuration source: database credentials and authentication salts",
    signature: "PHP source with configuration",
    match: matchPhpConfig,
  },
  {
    path: "/appsettings.json",
    method: "GET",
    group: "secrets",
    severity: "high",
    reveals: "ASP.NET application settings, often connection strings and API keys",
    signature: "appsettings.json sections",
    match(a) {
      const text = nonHtmlText(a);
      if (!text || !text.trimStart().startsWith("{")) return null;
      if (!/"(ConnectionStrings|Logging|AllowedHosts|Kestrel)"\s*:/.test(text)) return null;
      return /"ConnectionStrings"\s*:/.test(text) ? { detail: "has a ConnectionStrings section" } : {};
    },
  },
  // Server status and debug pages
  {
    path: "/server-status",
    method: "GET",
    group: "server",
    severity: "medium",
    reveals: "Apache mod_status: live requests, client addresses and the URLs being served",
    signature: "Apache mod_status page",
    match(a) {
      return /Apache Server Status for/i.test(a.text) && /Server (Version|uptime)/i.test(a.text) ? {} : null;
    },
  },
  {
    path: "/server-info",
    method: "GET",
    group: "server",
    severity: "medium",
    reveals: "Apache mod_info: the server's modules and full configuration",
    signature: "Apache mod_info page",
    match(a) {
      return /Apache Server Information/i.test(a.text) && /(Server Settings|Module Name)/i.test(a.text) ? {} : null;
    },
  },
  {
    path: "/phpinfo.php",
    method: "GET",
    group: "server",
    severity: "high",
    reveals: "PHP configuration, file paths and environment variables, which can include secrets",
    signature: "phpinfo() page",
    match(a) {
      return /phpinfo\(\)/i.test(a.text) && /PHP Version/i.test(a.text) ? {} : null;
    },
  },
  {
    path: "/.htaccess",
    method: "GET",
    group: "server",
    severity: "medium",
    reveals: "Apache access rules, rewrites and protected paths",
    signature: "Apache directives",
    match(a) {
      const text = nonHtmlText(a);
      if (!text) return null;
      const lines = contentLines(text);
      const directives = lines.filter((l) => HTACCESS_DIRECTIVE_RE.test(l)).length;
      // Most lines must be directives, not one stray `Options` in a prose page.
      if (directives === 0 || directives * 2 < lines.length) return null;
      return /^\s*AuthUserFile\b/im.test(text) ? { detail: "names a password file" } : {};
    },
  },
  {
    path: "/web.config",
    method: "GET",
    group: "server",
    severity: "medium",
    reveals: "IIS / ASP.NET configuration: handlers, rewrites and sometimes connection strings",
    signature: "web.config <configuration> sections",
    match(a) {
      if (a.bytes.byteLength === 0) return null;
      const text = a.text;
      if (!/<configuration[\s>]/.test(text)) return null;
      if (!/<(system\.webServer|system\.web|appSettings|connectionStrings)[\s>]/.test(text)) return null;
      return /<connectionStrings[\s>]/.test(text) ? { detail: "has a connectionStrings section" } : {};
    },
  },
  // Editor and OS cruft
  {
    path: "/.DS_Store",
    method: "GET",
    group: "cruft",
    severity: "medium",
    reveals: "a macOS folder index: the names of files and folders in the web root, including unlinked ones",
    signature: ".DS_Store magic (Bud1)",
    match(a) {
      return startsWithBytes(a.bytes, [0x00, 0x00, 0x00, 0x01, 0x42, 0x75, 0x64, 0x31]) ? {} : null;
    },
  },
  {
    path: "/Thumbs.db",
    method: "GET",
    group: "cruft",
    severity: "medium",
    reveals: "a Windows thumbnail cache: previews of images in the folder, including deleted ones",
    signature: "OLE compound file magic",
    match: matchOle,
  },
  // Backups and dumps
  {
    path: "/backup.zip",
    method: "GET",
    group: "backup",
    severity: "high",
    reveals: "a site backup archive: source code, configuration and possibly data",
    signature: "zip magic (PK)",
    match(a) {
      return startsWithBytes(a.bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWithBytes(a.bytes, [0x50, 0x4b, 0x05, 0x06])
        ? {}
        : null;
    },
  },
  {
    path: "/site.tar.gz",
    method: "GET",
    group: "backup",
    severity: "high",
    reveals: "a site backup archive: source code, configuration and possibly data",
    signature: "gzip or tar magic",
    match(a) {
      // A server that labels the file Content-Encoding: gzip has it decoded on the way in, leaving the tar.
      if (startsWithBytes(a.bytes, [0x1f, 0x8b])) return {};
      return startsWithBytes(a.bytes, [0x75, 0x73, 0x74, 0x61, 0x72], 257) ? {} : null;
    },
  },
  {
    path: "/db.sql",
    method: "GET",
    group: "backup",
    severity: "high",
    reveals: "a database dump: table structure and stored data, often user records and password hashes",
    signature: "SQL dump header",
    match: matchSqlDump,
  },
  {
    path: "/dump.sql",
    method: "GET",
    group: "backup",
    severity: "high",
    reveals: "a database dump: table structure and stored data, often user records and password hashes",
    signature: "SQL dump header",
    match: matchSqlDump,
  },
];

const HTACCESS_DIRECTIVE_RE =
  /^(RewriteEngine|RewriteRule|RewriteCond|RewriteBase|Options|Order\s+(allow|deny)|Deny\s+from|Allow\s+from|Require\s+(all|ip|host|valid-user|user|group)|AuthType|AuthName|AuthUserFile|AuthGroupFile|<\/?IfModule|<\/?Files(Match)?|<\/?Directory|<\/?Limit|Header\s+(set|always|unset|append|add)|SetEnv(If)?|DirectoryIndex|ErrorDocument|Redirect(Match|Permanent|Temp)?|php_value|php_flag|AddType|AddHandler|AddDefaultCharset|ExpiresActive|ExpiresByType|ExpiresDefault|FileETag|Satisfy)\b/i;

function matchPhpConfig(a: ProbeAnswer): SignatureMatch | null {
  if (a.bytes.byteLength === 0) return null;
  const text = a.text;
  if (!/^\s*<\?php\b/.test(text)) return null;
  const defines = /\bdefine\s*\(\s*['"][A-Z_]+['"]/.test(text);
  const assigns = /^\s*\$[A-Za-z_]\w*(\[[^\]]*\])*\s*=/m.test(text);
  if (!defines && !assigns) return null;
  return /DB_PASSWORD|password/i.test(text) ? { detail: "sets a database password" } : {};
}

function matchOle(a: ProbeAnswer): SignatureMatch | null {
  return startsWithBytes(a.bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) ? {} : null;
}

function matchSqlDump(a: ProbeAnswer): SignatureMatch | null {
  const text = nonHtmlText(a);
  if (!text) return null;
  const head = text.slice(0, 4096);
  const header = /^-- (MySQL dump|MariaDB dump|PostgreSQL database dump|phpMyAdmin SQL Dump)/m.test(head);
  const statements = /^\s*(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS|COPY \S+ \(|SET NAMES)\b/im.test(head);
  if (!header && !statements) return null;
  return /^\s*(INSERT INTO|COPY \S+ \()/im.test(text) ? { detail: "has table data" } : {};
}
