import type { TechFingerprint } from "../types";

export const SECURITY_FINGERPRINTS: TechFingerprint[] = [
  {
    id: "recaptcha",
    name: "reCAPTCHA",
    category: "security",
    website: "https://google.com/recaptcha",
    icon: "recaptcha",
    detectors: [
      { type: "script-url", pattern: /google\.com\/recaptcha/i },
      { type: "html", pattern: /g-recaptcha/i },
      { type: "html", pattern: /grecaptcha/i },
    ],
  },
  {
    id: "hcaptcha",
    name: "hCaptcha",
    category: "security",
    website: "https://hcaptcha.com",
    icon: "hcaptcha",
    detectors: [
      { type: "script-url", pattern: /hcaptcha\.com\/1\/api\.js/i },
      { type: "html", pattern: /h-captcha/i },
    ],
  },
  {
    id: "cloudflare-turnstile",
    name: "Cloudflare Turnstile",
    category: "security",
    website: "https://developers.cloudflare.com/turnstile",
    icon: "cloudflare",
    detectors: [
      { type: "script-url", pattern: /challenges\.cloudflare\.com\/turnstile/i },
      { type: "html", pattern: /cf-turnstile/i },
    ],
  },
  // pub#646: curated, not generated. The generated set's source data is not in
  // the repository, so a fix there could not survive a regeneration, which
  // skips any id defined here. `X-CDN` reads `Imperva` as well as `Incapsula`,
  // as waf-detect already accepts (pub#643).
  {
    id: "imperva-incapsula",
    name: "Imperva / Incapsula",
    category: "security",
    website: "https://www.imperva.com",
    icon: "imperva-incapsula",
    detectors: [
      { type: "header", name: "X-CDN", pattern: /\b(?:Incapsula|Imperva)\b/i },
      { type: "header", name: "X-Iinfo", pattern: /.+/i },
      { type: "script-url", pattern: /\/_Incapsula_Resource/i },
    ],
    confidence: "high",
  },
];
