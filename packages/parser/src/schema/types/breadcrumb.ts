// Breadcrumb schema type

import type { SchemaType } from "./base";

/**
 * ListItem schema - for breadcrumb items
 */
export interface BreadcrumbListItemSchema extends SchemaType {
  "@type": "ListItem";
  position?: number;
  name?: string;
  item?:
    | string
    | { "@type": string; "@id"?: string; name?: string; url?: string };
}

/**
 * BreadcrumbList schema
 */
export interface BreadcrumbListSchema extends SchemaType {
  "@type": "BreadcrumbList";
  itemListElement?: BreadcrumbListItemSchema | BreadcrumbListItemSchema[];
  name?: string;
  numberOfItems?: number;
}
