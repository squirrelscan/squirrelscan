// Organization schema type

import type {
  ContactPointSchema,
  ImageObjectSchema,
  PostalAddressSchema,
  SchemaType,
} from "./base";

/**
 * Organization schema - for publishers, businesses, etc.
 */
export interface OrganizationSchema extends SchemaType {
  "@type": "Organization" | "Corporation" | "LocalBusiness" | string;
  name?: string;
  url?: string;
  logo?: string | ImageObjectSchema;
  image?: string | ImageObjectSchema | string[];
  sameAs?: string[];
  contactPoint?: ContactPointSchema | ContactPointSchema[];
  address?: PostalAddressSchema | string;
  telephone?: string;
  email?: string;
  description?: string;
  foundingDate?: string;
  founder?: PersonSchemaRef | PersonSchemaRef[];
  numberOfEmployees?: number | { minValue?: number; maxValue?: number };
}

/**
 * LocalBusiness extends Organization with location-specific fields
 */
export interface LocalBusinessSchema extends OrganizationSchema {
  "@type": "LocalBusiness" | string;
  priceRange?: string;
  openingHours?: string | string[];
  openingHoursSpecification?: OpeningHoursSpecification[];
  geo?: GeoCoordinates;
  areaServed?: string | string[];
  servesCuisine?: string | string[];
  menu?: string;
  acceptsReservations?: boolean | string;
  paymentAccepted?: string | string[];
  currenciesAccepted?: string;
}

interface OpeningHoursSpecification {
  "@type": "OpeningHoursSpecification";
  dayOfWeek?: string | string[];
  opens?: string;
  closes?: string;
}

interface GeoCoordinates {
  "@type": "GeoCoordinates";
  latitude?: number | string;
  longitude?: number | string;
}

// Forward reference to avoid circular dependency
interface PersonSchemaRef extends SchemaType {
  "@type": "Person";
  name?: string;
}
