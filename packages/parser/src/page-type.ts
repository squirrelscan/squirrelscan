// Page type detection - schema-based + URL patterns

import type { SchemaCollection } from "./schema";

/**
 * Detected page type
 */
export type PageType =
  | "article"
  | "product"
  | "category"
  | "faq"
  | "contact"
  | "about"
  | "home"
  | "landing"
  | "media"
  | "profile"
  | "local"
  | "recipe"
  | "event"
  | "search"
  | "unknown";

/**
 * Detect page type from schema and URL
 *
 * Priority:
 * 1. Schema.org types (definitive)
 * 2. URL patterns (hints)
 */
export function detectPageType(
  url: string,
  schemas: SchemaCollection
): PageType {
  // 1. Schema.org types (definitive)
  if (schemas.article) return "article";
  if (schemas.product) return "product";
  if (schemas.faq) return "faq";
  if (schemas.recipe) return "recipe";
  if (schemas.event) return "event";
  if (schemas.video) return "media";
  if (schemas.localBusiness) return "local";
  if (schemas.hasType("ProfilePage")) return "profile";
  if (schemas.hasType("SearchResultsPage")) return "search";
  if (schemas.hasType("CollectionPage")) return "category";
  if (schemas.hasType("ItemList")) return "category";
  if (schemas.hasType("ContactPage")) return "contact";
  if (schemas.hasType("AboutPage")) return "about";

  // 2. URL patterns (low-confidence hints)
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return "unknown";
  }

  // Home page
  if (path === "/" || path === "") return "home";

  // Article patterns
  if (/\/(blog|news|article|post|posts|story|stories)\//.test(path)) {
    return "article";
  }
  if (/\/(blog|news)$/.test(path)) {
    return "category"; // Blog index is a category
  }

  // Product patterns
  if (/\/products?\/[^/]+/.test(path)) return "product";

  // Category patterns
  if (/\/(category|categories|collection|collections|shop)\//.test(path)) {
    return "category";
  }

  // FAQ pattern
  if (/\/faq\/?$/.test(path) || /\/frequently-asked-questions\/?$/.test(path)) {
    return "faq";
  }

  // Contact pattern
  if (/\/contact\/?$/.test(path) || /\/contact-us\/?$/.test(path)) {
    return "contact";
  }

  // About pattern
  if (/\/about\/?$/.test(path) || /\/about-us\/?$/.test(path)) {
    return "about";
  }

  // Search pattern
  if (/\/search\/?/.test(path)) {
    return "search";
  }

  // Profile patterns
  if (/\/(author|profile|user|member)\//.test(path)) {
    return "profile";
  }

  // Event patterns
  if (/\/(event|events)\/[^/]+/.test(path)) {
    return "event";
  }

  return "unknown";
}
