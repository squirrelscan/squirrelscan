import type { TechFingerprint } from "../types";

export const PAYMENT_FINGERPRINTS: TechFingerprint[] = [
  {
    // A shop-config flag, not a loaded SDK: the inline shop config of a Shopify storefront says the merchant has
    // Shopify Payments enabled (#1447). Named so a report does not read it as a script the page loads.
    id: "shopify-payments",
    name: "Shopify Payments (enabled in shop config)",
    category: "payment",
    website: "https://www.shopify.com/payments",
    icon: "shopify-payments",
    detectors: [
      { type: "html", pattern: /"shopifyPaymentsEnabled"\s*:\s*true\b/, requires: "shopifyPaymentsEnabled" },
    ],
    confidence: "medium",
  },
  {
    id: "stripe",
    name: "Stripe",
    category: "payment",
    website: "https://stripe.com",
    icon: "stripe",
    detectors: [
      { type: "script-url", pattern: /js\.stripe\.com/i },
      { type: "html", pattern: /stripe\.com\/v3/i },
      { type: "script-content", pattern: /Stripe\(/ },
    ],
  },
  {
    id: "paypal",
    name: "PayPal",
    category: "payment",
    website: "https://paypal.com",
    icon: "paypal",
    detectors: [
      { type: "script-url", pattern: /paypal\.com\/sdk/i },
      { type: "html", pattern: /paypal\.Buttons/i },
      { type: "script-url", pattern: /paypalobjects\.com/i },
    ],
  },
  {
    id: "square",
    name: "Square",
    category: "payment",
    website: "https://squareup.com",
    icon: "square",
    detectors: [
      { type: "script-url", pattern: /squareup\.com/i },
      { type: "script-url", pattern: /square\.site/i },
      { type: "html", pattern: /sq-payment-form/i },
    ],
  },
  {
    id: "klarna",
    name: "Klarna",
    category: "payment",
    website: "https://klarna.com",
    icon: "klarna",
    detectors: [
      { type: "script-url", pattern: /js\.klarna\.com/i },
      { type: "html", pattern: /klarna-placement/i },
    ],
  },
];
