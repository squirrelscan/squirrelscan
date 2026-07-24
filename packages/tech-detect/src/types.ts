export type TechCategory =
  | "cms"
  | "framework"
  | "analytics"
  | "cdn"
  | "ad-network"
  | "payment"
  | "web-server"
  | "hosting"
  | "security"
  | "tag-manager"
  | "chat"
  | "font"
  | "video"
  | "widget"
  | "other";

export type Detector =
  | { type: "header"; name: string; pattern: RegExp }
  | { type: "meta"; name: string; pattern: RegExp }
  | { type: "script-url"; pattern: RegExp }
  | { type: "script-content"; pattern: RegExp }
  | { type: "html"; pattern: RegExp }
  | { type: "dom"; selector: string }
  | { type: "url-path"; pattern: RegExp };

export interface TechFingerprint {
  id: string;
  name: string;
  category: TechCategory;
  website?: string;
  icon?: string;
  detectors: Detector[];
  confidence?: "high" | "medium" | "low";
  versionPattern?: RegExp;
}

export interface TechDetectInput {
  url: string;
  headers: Record<string, string>;
  html: string;
  scripts?: Array<{ url: string; content?: string }>;
  meta?: Record<string, string>;
}

export interface DetectedTechnology {
  id: string;
  name: string;
  category: TechCategory;
  version: string | null;
  confidence: "high" | "medium" | "low";
  detectedBy: string;
  website?: string;
  icon?: string;
}
