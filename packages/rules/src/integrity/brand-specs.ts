// Brand specs: the third-party brands whose sign-in surfaces are cloned, with the lexicon, action cues and legitimate
// hosts of each. Data only, in its own module so the control reader can derive its cue prefilter from the lexicon.

export interface BrandSpec {
  brand: string;
  /** Lower-cased phrases; impersonation needs the brand AND an auth/action cue. */
  lexicon: string[];
  /** Auth/booking action cues that turn a mention into an impersonation. */
  actionCues: string[];
  /** The brand's own sign-in or service hosts: the host or any subdomain of it. Never a registrable domain that also hosts user content. */
  legitHosts: string[];
  /**
   * Hosts that serve both the brand's sign-in and other content (user pages, redirectors, proxies), spared only on
   * the paths that are the sign-in. `suffix` also takes subdomains (a tenant host such as `<tenant>.b2clogin.com`);
   * otherwise exactly that host.
   */
  legitEndpoints?: Array<{ host: string; suffix?: boolean; path: RegExp }>;
}

export const BRAND_SPECS: BrandSpec[] = [
  {
    brand: "Google",
    lexicon: [
      "sign in with google",
      "continue with google",
      "log in with google",
      "login with google",
      "google account",
      "google login",
    ],
    actionCues: ["sign in", "log in", "continue", "verify"],
    // `sites.`, `docs.`, `script.`, `drive.`, `forms.`, `translate.` and the `/url` and `/amp/s/` redirectors of google.com hold
    // user content or send a visitor anywhere (#1418): only the sign-in hosts and the accounts path are the brand's.
    legitHosts: ["accounts.google.com", "accounts.youtube.com"],
    legitEndpoints: [
      { host: "www.google.com", path: /^\/accounts(?:\/|$)/ },
      { host: "google.com", path: /^\/accounts(?:\/|$)/ },
    ],
  },
  {
    brand: "Microsoft",
    lexicon: [
      "sign in with microsoft",
      "continue with microsoft",
      "log in with microsoft",
      "login with microsoft",
      "microsoft account",
      "office 365 login",
      "outlook login",
    ],
    actionCues: ["sign in", "log in", "continue", "verify"],
    // Azure AD B2C tenants live under `b2clogin.com` and are tenant-owned: only their authorize paths are the sign-in.
    // `forms.`, `answers.` and the rest of microsoft.com are not sign-in hosts (#1418).
    legitHosts: [
      "login.microsoftonline.com",
      "login.microsoftonline.us",
      "login.windows.net",
      "login.live.com",
      "login.microsoft.com",
    ],
    legitEndpoints: [{ host: "b2clogin.com", suffix: true, path: /\/oauth2\/(?:v2\.0\/)?authorize(?:\/|$)/ }],
  },
  {
    brand: "Calendly",
    lexicon: ["calendly"],
    actionCues: [
      "discovery call",
      "book a call",
      "schedule",
      "sign in",
      "log in",
    ],
    legitHosts: ["calendly.com"],
  },
  {
    brand: "DocuSign",
    lexicon: ["docusign"],
    actionCues: ["sign in", "log in", "review document", "sign document"],
    legitHosts: ["docusign.com", "docusign.net"],
  },
  {
    brand: "ClickFunnels",
    lexicon: ["clickfunnels"],
    actionCues: ["sign in", "log in", "members login"],
    legitHosts: ["clickfunnels.com", "myclickfunnels.com"],
  },
  {
    brand: "Kajabi",
    lexicon: ["kajabi"],
    actionCues: ["sign in", "log in", "members login"],
    legitHosts: ["kajabi.com", "mykajabi.com"],
  },
];
