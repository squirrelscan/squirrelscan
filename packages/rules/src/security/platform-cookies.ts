// Cookies a hosting platform sets on every site it serves, for routing or
// deployment pinning. The site owner didn't set them and can't change their
// flags, and none carries a secret, so a missing HttpOnly on one is not an XSS
// cookie-theft risk. The one list security/cookie-flags reads (#1378).

export interface PlatformCookie {
  /** Exact cookie name (case-sensitive, as cookie names are). */
  name: string;
  platform: string;
  /** The platform's docs. */
  docs: string;
}

export const PLATFORM_COOKIES: readonly PlatformCookie[] = [
  { name: "__dpl", platform: "Lovable", docs: "https://docs.lovable.dev/" },
];

const BY_NAME = new Map(PLATFORM_COOKIES.map((c) => [c.name, c]));

/** The platform entry for a cookie name, or undefined for any other cookie. */
export function platformCookie(name: string): PlatformCookie | undefined {
  return BY_NAME.get(name);
}
