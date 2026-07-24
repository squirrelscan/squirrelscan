// Base schema.org types

/**
 * Base interface for all schema.org types
 */
export interface SchemaType {
  "@type": string | string[];
  "@id"?: string;
  "@context"?: string;
  [key: string]: unknown; // Allow additional properties
}

/**
 * Parsed schema with type preserved as-is
 */
export interface ParsedSchema extends SchemaType {
  "@type": string | string[]; // Preserved (single or multiple types)
  [key: string]: unknown;
}

export interface SchemaValidationIssue {
  type: string;
  property: string;
  message: string;
  severity: "missing" | "invalid" | "context";
  path: string[];
}

/**
 * ImageObject schema
 */
export interface ImageObjectSchema extends SchemaType {
  "@type": "ImageObject";
  url?: string;
  contentUrl?: string;
  width?: number | string;
  height?: number | string;
  caption?: string;
}

/**
 * PostalAddress schema
 */
export interface PostalAddressSchema extends SchemaType {
  "@type": "PostalAddress";
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  addressCountry?: string;
}

/**
 * ContactPoint schema
 */
export interface ContactPointSchema extends SchemaType {
  "@type": "ContactPoint";
  telephone?: string;
  email?: string;
  contactType?: string;
  areaServed?: string | string[];
  availableLanguage?: string | string[];
}

/**
 * Answer schema (for FAQ)
 */
export interface AnswerSchema extends SchemaType {
  "@type": "Answer";
  text?: string;
}
