/**
 * Cross-repo classifier parity corpus (#1822).
 *
 * The failure vocabulary is declared TWICE on purpose: the engine owns it in
 * the public `@squirrelscan/core-contracts` failure-reason module, and the
 * cloud re-derives it in `@squirrelscan/private-contracts` because the private
 * repo pins the public one by submodule gitlink and cannot import across it
 * (squirrelscan/repo#1838 tracks folding them back together).
 *
 * "Kept in sync by convention" is not a mechanism. This corpus IS the
 * mechanism: the identical list lives in both repos, and a rule that drifts on
 * either side fails a test instead of silently sending one audit a different
 * failure email depending on which surface classified it. A first pass caught
 * four real divergences on day one, all on legacy phrasings the comments claim
 * to support: "Connection timed out", a bare "ETIMEDOUT", "DNS resolution
 * failed", and a bare "WAF".
 *
 *
 * Blind spot worth naming: the corpus catches a rule that drifts on the side
 * being edited. It cannot catch one introduced only on the side nobody
 * touched, because neither repo's CI runs the other's classifier. That is the
 * residual risk #1838 removes, and the reason to edit both copies together.
 *
 * When you change a matcher or a reason sentence, change BOTH copies of this
 * list in the same pass.
 */
export const CLASSIFIER_PARITY_CORPUS: ReadonlyArray<readonly [string, string]> = [
  // The sentences the engine itself writes.
  ["DNS lookup failed for ejconsultor.es: NXDOMAIN", "dns"],
  ["TLS handshake with example.com failed: certificate has expired", "tls"],
  ["Connection to example.com failed before any response", "connection"],
  ["No response from example.com within the request timeout", "timeout"],
  ["example.com returned 404 Not Found", "http_4xx"],
  ["example.com returned 503 Service Unavailable", "http_5xx"],
  ["Redirect from example.com could not be followed: redirected off-site to other.com", "redirect"],
  ["robots.txt disallows crawling example.com", "robots"],
  ["No pages were crawled from example.com: something novel", "unknown"],

  // The #792 blocked copy and the #1829 rate-limit copy.
  ["Site blocked the crawler (bot protection / auth / rate limit)", "http_4xx"],
  ["Rate limited by example.com; no pages could be fetched", "http_4xx"],

  // Runtime and legacy phrasings that reach these surfaces from older CLI
  // versions, older engines, and the render worker's Chromium errors.
  ["getaddrinfo ENOTFOUND example.com", "dns"],
  ["net::ERR_NAME_NOT_RESOLVED", "dns"],
  ["DNS resolution failed for x.com", "dns"],
  // The parenthesised DNS form, which is what reports published before the
  // template switched to a colon still carry.
  ["DNS lookup failed for ejconsultor.es (NXDOMAIN)", "dns"],
  ["net::ERR_CERT_DATE_INVALID", "tls"],
  ["unable to verify the first certificate", "tls"],
  ["The socket connection was closed unexpectedly", "connection"],
  ["connect ECONNREFUSED 10.0.0.1:443", "connection"],
  ["net::ERR_CONNECTION_RESET", "connection"],
  ["Connection timed out", "connection"],
  ["socket hang up", "connection"],
  ["ETIMEDOUT", "timeout"],
  ["net::ERR_TIMED_OUT", "timeout"],
  ["page.goto: Timeout 20000ms exceeded", "timeout"],
  ["Navigation timeout of 30000 ms exceeded", "timeout"],
  ["Crawl request timed out", "timeout"],
  ["net::ERR_TOO_MANY_REDIRECTS", "redirect"],
  ["Off-site redirect to https://other.com/x", "redirect"],
  ["Server error: 502", "http_5xx"],
  ["429 Too Many Requests", "http_4xx"],
  ["Request blocked by server", "http_4xx"],
  ["WAF challenge detected", "http_4xx"],

  // Ours, not the site's. Every one of these must stay `unknown`, or a failure
  // email tells a site owner to fix something that was never theirs.
  ["Callback 'mark-completed' failed after 3 attempts (HTTP 500: internal error)", "unknown"],
  ["upload failed, HTTP 503 from storage", "unknown"],
  ["database query timed out", "unknown"],
  ["R2_ASSETS.put timed out after 5000ms", "unknown"],
  ["internal API got no response from the billing service", "unknown"],
  ["database query failed after 403 retries", "unknown"],
  ["CLI session ended before the audit completed", "unknown"],
  ["No pages were crawled", "unknown"],
];
