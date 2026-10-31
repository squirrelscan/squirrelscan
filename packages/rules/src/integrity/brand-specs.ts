// Brand specs: the third-party brands whose sign-in surfaces are cloned, with the lexicon, action cues and legitimate
// hosts of each. Data only, in its own module so the control reader can derive its cue prefilter from the lexicon.

export interface BrandSpec {
  brand: string;
  /** Lower-cased phrases; impersonation needs the brand AND an auth/action cue. */
  lexicon: string[];
  /** Auth/booking action cues that turn a mention into an impersonation. */
  actionCues: string[];
  /** Legit hosts for this brand — links here are treated as real integrations. */
  legitHosts: string[];
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
    legitHosts: ["accounts.google.com", "google.com"],
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
    legitHosts: [
      "login.microsoftonline.com",
      "login.microsoftonline.us",
      "login.windows.net",
      "login.live.com",
      "b2clogin.com",
      "microsoft.com",
    ],
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
