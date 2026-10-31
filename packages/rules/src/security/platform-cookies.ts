// Cookies a hosting platform's sites carry that the site owner didn't set and
// can't change the flags of, with no session in them, so a missing HttpOnly on
// one is not an XSS cookie-theft risk. The one list security/cookie-flags reads
// (#1378). An entry is added on evidence, recorded in `evidence`; the platforms
// do not always document their cookies.
//
// The same list holds CSRF token cookies a framework sends so the page's own script can read
// them and send the token back in a header (Angular, Axios). HttpOnly is needed only when the
// frontend does not read the cookie, so a missing one is not a finding. Exempt by exact name
// (case-sensitive, as RFC 6265 cookie names are), only from the HttpOnly warning.

export interface PlatformCookie {
  /** Exact cookie name (case-sensitive, as cookie names are). */
  name: string;
  /** `platform`: set by a hosting platform; `csrf`: a CSRF token a script is meant to read. */
  kind: "platform" | "csrf";
  /** The platform, or the frameworks that use the cookie as a CSRF token. */
  platform: string;
  /** Docs: the platform's home (it need not document the cookie, see `evidence`), or the pages that document the CSRF cookie. */
  docs: readonly string[];
  /** Whether the platform documents the cookie. The report says so only when it does not. */
  documented: boolean;
  /** Why the cookie is listed. */
  evidence: string;
}

export const PLATFORM_COOKIES: readonly PlatformCookie[] = [
  {
    name: "__dpl",
    kind: "platform",
    platform: "Lovable",
    docs: ["https://docs.lovable.dev/"],
    documented: false,
    evidence:
      "on 1,013 of 1,066 Lovable-hosted sites in a 35k-audit batch (v0.0.141), the only cookie missing HttpOnly; not documented by Lovable (#1378)",
  },
  {
    name: "XSRF-TOKEN",
    kind: "csrf",
    platform: "Angular, Laravel and Spring Security",
    docs: [
      "https://angular.dev/best-practices/security",
      "https://laravel.com/docs/csrf#csrf-x-xsrf-token",
      "https://docs.spring.io/spring-security/reference/servlet/exploits/csrf.html",
    ],
    documented: true,
    evidence:
      "Angular's HttpClient reads the XSRF-TOKEN cookie and sets X-XSRF-TOKEN; Laravel sends it \"as a developer convenience\" for Angular and Axios; Spring's CookieCsrfTokenRepository writes it, with HttpOnly false so JavaScript frameworks can read it, and recommends HttpOnly when you do not need that.",
  },
  {
    name: "csrftoken",
    kind: "csrf",
    platform: "Django",
    docs: ["https://docs.djangoproject.com/en/stable/ref/settings/#csrf-cookie-httponly"],
    documented: true,
    evidence:
      "Django's default CSRF_COOKIE_NAME; CSRF_COOKIE_HTTPONLY defaults to False, and Django says HttpOnly on it offers no practical protection and that with HttpOnly set, JavaScript has to read the token from a form input instead.",
  },
];

const BY_NAME = new Map(PLATFORM_COOKIES.map((c) => [c.name, c]));

/** The platform entry for a cookie name, or undefined for any other cookie. */
export function platformCookie(name: string): PlatformCookie | undefined {
  return BY_NAME.get(name);
}
