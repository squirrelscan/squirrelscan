// A shared classifier for web-server autoindex pages (#2336): Apache, nginx,
// IIS and Tomcat. It reads one answer body and says whether it is a generated
// directory listing and which files the listing shows.
//
// A status code or an "Index of" title alone is never enough. A page is a
// listing only when it carries the server's own header marker AND at least
// MIN_LISTING_ROWS file rows, where a row is a link followed, within a short
// distance, by a time of day (every autoindex prints each entry's last-modified
// time). A themed 404 or an SPA shell has neither, and a blog post that quotes
// "Index of /" has no rows.
//
// The body is site-chosen text, so nothing here runs an unbounded quantifier
// over it: anchors are found with indexOf and every regex is length-bounded.

export type ListingServer = "apache" | "nginx" | "iis" | "tomcat";

/** File rows a page needs before it counts as a listing. */
export const MIN_LISTING_ROWS = 2;
/** Files kept in a result's sample. */
export const MAX_LISTING_SAMPLE = 10;
/** Longest file name kept in the sample. */
const MAX_NAME_CHARS = 120;
/** Anchors examined per body, so a hostile page of links costs a bounded scan. */
const MAX_ANCHORS_SCANNED = 5000;
/** Characters after a link searched for the entry's time of day. */
const ROW_TAIL_CHARS = 400;
/** Body characters read; the caller already caps the bytes it reads. */
const MAX_BODY_CHARS = 256 * 1024;

export interface DirectoryListing {
  server: ListingServer;
  /** Entry names in page order, directories keep their trailing slash. At most MAX_LISTING_SAMPLE. */
  files: string[];
  /** Rows seen in the part of the body that was read (a lower bound on a long listing). */
  rows: number;
}

const APACHE_TITLE_RE = /<title>\s{0,8}Index of \/[^<]{0,300}<\/title>/i;
const INDEX_OF_H1_RE = /<h1>\s{0,8}Index of \/[^<]{0,300}<\/h1>/i;
const TOMCAT_TITLE_RE =
  /<title>\s{0,8}Directory Listing For \/[^<]{0,300}<\/title>/i;
const TOMCAT_H1_RE = /<h1>\s{0,8}Directory Listing For \/[^<]{0,300}<\/h1>/i;
const IIS_TITLE_RE = /<title>([^<]{1,300}? - \/[^<]{0,300})<\/title>/i;
const IIS_H1_RE = /<h1>([^<]{1,300}? - \/[^<]{0,300})<\/h1>/i;
const TIME_RE = /\b\d{1,2}:\d{2}\b/;
const HREF_RE = /\bhref\s{0,4}=\s{0,4}(?:"([^"]{0,512})"|'([^']{0,512})')/i;

function normalise(s: string): string {
  return s.replace(/\s{1,64}/g, " ").trim();
}

function serverOf(body: string, head: string): ListingServer | null {
  const lower = head.toLowerCase();
  if (TOMCAT_TITLE_RE.test(head) && TOMCAT_H1_RE.test(head)) return "tomcat";
  if (APACHE_TITLE_RE.test(head) && INDEX_OF_H1_RE.test(head)) {
    // nginx prints the parent row as `<a href="../">../</a>` right after <hr><pre>.
    if (/<hr>\s{0,8}<pre><a href="\.\.\/">\.\.\/<\/a>/i.test(body))
      return "nginx";
    // Apache prints sort links, a "Parent Directory" row or its signature line.
    if (
      lower.includes("?c=n;o=") ||
      lower.includes("parent directory") ||
      lower.includes("<address>apache")
    )
      return "apache";
    return null;
  }
  const t = IIS_TITLE_RE.exec(head);
  const h = IIS_H1_RE.exec(head);
  if (
    t?.[1] &&
    h?.[1] &&
    normalise(t[1]) === normalise(h[1]) &&
    lower.includes("<pre>") &&
    lower.includes("<hr>")
  )
    return "iis";
  return null;
}

/** True for the parent link, sort links and absolute links that are not entries. */
function isNonEntry(href: string, text: string): boolean {
  if (href === "" || href.startsWith("?") || href.startsWith("#")) return true;
  if (href === "../" || href === ".." || href === "/" || href === "./")
    return true;
  const t = text.toLowerCase();
  if (t.includes("parent directory") || t.includes("to parent directory"))
    return true;
  return false;
}

/**
 * Whether `body` is a generated directory listing, and the entries it shows.
 * Null for everything else, including a listing with fewer than
 * MIN_LISTING_ROWS rows.
 */
export function classifyDirectoryListing(
  rawBody: string
): DirectoryListing | null {
  const body =
    rawBody.length > MAX_BODY_CHARS
      ? rawBody.slice(0, MAX_BODY_CHARS)
      : rawBody;
  const head = body.slice(0, 8192);
  const server = serverOf(body, head);
  if (!server) return null;

  const lower = body.toLowerCase();
  const files: string[] = [];
  let rows = 0;
  let from = 0;
  let scanned = 0;
  while (scanned < MAX_ANCHORS_SCANNED) {
    const open = lower.indexOf("<a ", from);
    if (open === -1) break;
    scanned++;
    const tagEnd = lower.indexOf(">", open);
    if (tagEnd === -1) break;
    const close = lower.indexOf("</a>", tagEnd);
    if (close === -1) break;
    const prevEnd = from;
    from = close + 4;
    const m = HREF_RE.exec(body.slice(open, Math.min(tagEnd + 1, open + 1100)));
    if (!m) continue;
    const href = (m[1] ?? m[2] ?? "").trim();
    const text = body.slice(tagEnd + 1, Math.min(close, tagEnd + 1 + 600));
    if (isNonEntry(href, text)) continue;
    if (/^[a-z][a-z0-9+.-]{0,15}:/i.test(href) || href.startsWith("//"))
      continue;
    // IIS prints the date and size before the link; the others print them after it.
    const span =
      server === "iis"
        ? body.slice(Math.max(prevEnd, open - ROW_TAIL_CHARS), open)
        : body.slice(from, from + ROW_TAIL_CHARS);
    // Stop at the next link so a neighbouring row's time is not credited to this one.
    const nextLink = server === "iis" ? -1 : span.toLowerCase().indexOf("<a ");
    if (!TIME_RE.test(nextLink === -1 ? span : span.slice(0, nextLink)))
      continue;
    rows++;
    if (files.length < MAX_LISTING_SAMPLE) {
      let name = href;
      try {
        name = decodeURIComponent(href);
      } catch {
        // keep the raw href
      }
      // IIS and Tomcat link by absolute path: show the entry, not its folder.
      const slash = name.replace(/\/$/, "").lastIndexOf("/");
      if (slash !== -1) name = name.slice(slash + 1);
      // The name is shown in a report: drop control characters, bound the length.
      name = [...name]
        .filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127)
        .join("")
        .slice(0, MAX_NAME_CHARS);
      if (name) files.push(name);
    }
  }
  if (rows < MIN_LISTING_ROWS) return null;
  return { server, files, rows };
}
