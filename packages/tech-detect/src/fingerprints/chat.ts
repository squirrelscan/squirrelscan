import type { TechFingerprint } from "../types";

export const CHAT_FINGERPRINTS: TechFingerprint[] = [
  {
    id: "intercom",
    name: "Intercom",
    category: "chat",
    website: "https://intercom.io",
    icon: "intercom",
    detectors: [
      { type: "script-url", pattern: /widget\.intercom\.io/i },
      { type: "html", pattern: /intercomSettings/i },
      { type: "html", pattern: /intercom-lightweight-app/i },
    ],
  },
  {
    id: "crisp",
    name: "Crisp",
    category: "chat",
    website: "https://crisp.chat",
    icon: "crisp",
    detectors: [
      { type: "script-url", pattern: /client\.crisp\.chat/i },
      { type: "html", pattern: /\$crisp/i },
    ],
  },
  {
    id: "drift",
    name: "Drift",
    category: "chat",
    website: "https://drift.com",
    icon: "drift",
    detectors: [
      { type: "script-url", pattern: /js\.driftt\.com/i },
      { type: "html", pattern: /drift-widget/i },
    ],
  },
  {
    id: "hubspot-chat",
    name: "HubSpot Chat",
    category: "chat",
    website: "https://hubspot.com",
    icon: "hubspot",
    detectors: [
      { type: "script-url", pattern: /js\.hs-scripts\.com/i },
      { type: "html", pattern: /hubspot-messages-iframe/i },
    ],
  },
  {
    id: "zendesk",
    name: "Zendesk",
    category: "chat",
    website: "https://zendesk.com",
    icon: "zendesk",
    detectors: [
      { type: "script-url", pattern: /static\.zdassets\.com/i },
      { type: "html", pattern: /zE\(['"]webWidget/i },
      { type: "html", pattern: /ze-snippet/i },
    ],
  },
  {
    id: "tawk-to",
    name: "Tawk.to",
    category: "chat",
    website: "https://tawk.to",
    icon: "tawk",
    detectors: [
      { type: "script-url", pattern: /embed\.tawk\.to/i },
      { type: "html", pattern: /Tawk_API/i },
    ],
  },
  {
    id: "livechat",
    name: "LiveChat",
    category: "chat",
    website: "https://livechat.com",
    icon: "livechat",
    detectors: [
      { type: "script-url", pattern: /cdn\.livechatinc\.com/i },
      { type: "html", pattern: /__lc_inited/i },
    ],
  },
];
