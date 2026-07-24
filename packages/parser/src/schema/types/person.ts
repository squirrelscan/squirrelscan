// Person schema type

import type { ImageObjectSchema, SchemaType } from "./base";

/**
 * Person schema - for authors, reviewers, etc.
 */
export interface PersonSchema extends SchemaType {
  "@type": "Person";
  name?: string;
  url?: string;
  image?: string | ImageObjectSchema;
  jobTitle?: string;
  sameAs?: string[];
  email?: string;
  description?: string;
  worksFor?: OrganizationSchemaRef;
  alumniOf?: string | OrganizationSchemaRef | OrganizationSchemaRef[];
  knowsAbout?: string | string[];
}

// Forward reference to avoid circular dependency
interface OrganizationSchemaRef extends SchemaType {
  "@type": "Organization" | "Corporation" | "LocalBusiness" | string;
  name?: string;
  url?: string;
}
