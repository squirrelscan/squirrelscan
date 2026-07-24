// WebSite and WebPage schema types

import type { ImageObjectSchema, SchemaType } from "./base";
import type { OrganizationSchema } from "./organization";
import type { PersonSchema } from "./person";

/**
 * SearchAction schema - for sitelinks search box
 */
export interface SearchActionSchema extends SchemaType {
  "@type": "SearchAction";
  target?: string | { "@type": "EntryPoint"; urlTemplate?: string };
  "query-input"?: string;
}

/**
 * WebSite schema
 */
export interface WebSiteSchema extends SchemaType {
  "@type": "WebSite";
  name?: string;
  url?: string;
  description?: string;
  potentialAction?: SearchActionSchema | SearchActionSchema[];
  publisher?: OrganizationSchema | PersonSchema;
  inLanguage?: string;
  copyrightHolder?: OrganizationSchema | PersonSchema;
  copyrightYear?: number;
}

/**
 * WebPage schema - base page type
 */
export interface WebPageSchema extends SchemaType {
  "@type":
    | "WebPage"
    | "AboutPage"
    | "ContactPage"
    | "CollectionPage"
    | "ProfilePage"
    | "SearchResultsPage"
    | string;
  name?: string;
  description?: string;
  url?: string;
  mainEntity?: SchemaType | SchemaType[];
  breadcrumb?: SchemaType;
  lastReviewed?: string;
  datePublished?: string;
  dateModified?: string;
  author?: PersonSchema | OrganizationSchema;
  publisher?: OrganizationSchema;
  image?: string | ImageObjectSchema;
  inLanguage?: string;
  isPartOf?: WebSiteSchema;
  speakable?: { "@type": "SpeakableSpecification"; cssSelector?: string[] };
  relatedLink?: string | string[];
  significantLink?: string | string[];
}

/**
 * CollectionPage schema - for category/listing pages
 */
export interface CollectionPageSchema extends WebPageSchema {
  "@type": "CollectionPage";
  mainEntity?: SchemaType | SchemaType[];
}

/**
 * ProfilePage schema - for author/user profile pages
 */
export interface ProfilePageSchema extends WebPageSchema {
  "@type": "ProfilePage";
  mainEntity?: PersonSchema | OrganizationSchema;
}

/**
 * SearchResultsPage schema
 */
export interface SearchResultsPageSchema extends WebPageSchema {
  "@type": "SearchResultsPage";
}

/**
 * AboutPage schema
 */
export interface AboutPageSchema extends WebPageSchema {
  "@type": "AboutPage";
}

/**
 * ContactPage schema
 */
export interface ContactPageSchema extends WebPageSchema {
  "@type": "ContactPage";
}
