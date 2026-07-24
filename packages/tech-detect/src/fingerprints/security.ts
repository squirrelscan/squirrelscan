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
];
