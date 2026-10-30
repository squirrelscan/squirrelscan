// Cookies a hosting platform's sites carry that the site owner didn't set and
// can't change the flags of, with no session in them, so a missing HttpOnly on
// one is not an XSS cookie-theft risk. The one list security/cookie-flags reads
// (#1378). An entry is added on evidence, recorded in `evidence`; the platforms
// do not always document their cookies.

export interface PlatformCookie {
  /** Exact cookie name (case-sensitive, as cookie names are). */
  name: string;
  platform: string;
  /** The platform's docs (home). It need not document this cookie: see `evidence`. */
  docs: string;
  /** Whether the platform documents the cookie. The report says so only when it does not. */
  documented: boolean;
  /** Why the cookie is listed. */
  evidence: string;
}

export const PLATFORM_COOKIES: readonly PlatformCookie[] = [
  {
    name: "__dpl",
    platform: "Lovable",
    docs: "https://docs.lovable.dev/",
    documented: false,
    evidence:
      "on 1,013 of 1,066 Lovable-hosted sites in a 35k-audit batch (v0.0.141), the only cookie missing HttpOnly; not documented by Lovable (#1378)",
  },
];

const BY_NAME = new Map(PLATFORM_COOKIES.map((c) => [c.name, c]));

/** The platform entry for a cookie name, or undefined for any other cookie. */
export function platformCookie(name: string): PlatformCookie | undefined {
  return BY_NAME.get(name);
}
