// Article schema type

import type { ImageObjectSchema, SchemaType } from "./base";
import type { OrganizationSchema } from "./organization";
import type { PersonSchema } from "./person";

/**
 * Article schema - for blog posts, news articles, etc.
 */
export interface ArticleSchema extends SchemaType {
  "@type": "Article" | "BlogPosting" | "NewsArticle" | "TechArticle" | string;
  headline?: string;
  name?: string;
  author?:
    | PersonSchema
    | OrganizationSchema
    | string
    | (PersonSchema | OrganizationSchema | string)[];
  datePublished?: string;
  dateModified?: string;
  dateCreated?: string;
  image?: ImageObjectSchema | string | (ImageObjectSchema | string)[];
  publisher?: OrganizationSchema;
  articleBody?: string;
  articleSection?: string;
  wordCount?: number;
  description?: string;
  mainEntityOfPage?: string | WebPageSchemaRef;
  keywords?: string | string[];
  thumbnailUrl?: string;
  isAccessibleForFree?: boolean;
  inLanguage?: string;
  copyrightHolder?: PersonSchema | OrganizationSchema;
  copyrightYear?: number;
}

// Forward reference to avoid circular dependency
interface WebPageSchemaRef extends SchemaType {
  "@type": "WebPage";
  "@id"?: string;
}
