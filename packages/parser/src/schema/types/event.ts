// Event schema type

import type {
  ImageObjectSchema,
  PostalAddressSchema,
  SchemaType,
} from "./base";
import type { OrganizationSchema } from "./organization";
import type { PersonSchema } from "./person";
import type { OfferSchema } from "./product";

/**
 * Place/Venue schema
 */
export interface PlaceSchema extends SchemaType {
  "@type": "Place" | "VirtualLocation" | string;
  name?: string;
  address?: PostalAddressSchema | string;
  url?: string;
  geo?: {
    "@type": "GeoCoordinates";
    latitude?: number | string;
    longitude?: number | string;
  };
}

/**
 * Event schema
 */
export interface EventSchema extends SchemaType {
  "@type": "Event" | "BusinessEvent" | "MusicEvent" | "SportsEvent" | string;
  name?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  location?: PlaceSchema | string;
  image?: string | ImageObjectSchema | (string | ImageObjectSchema)[];
  url?: string;
  organizer?: OrganizationSchema | PersonSchema;
  performer?:
    | PersonSchema
    | OrganizationSchema
    | (PersonSchema | OrganizationSchema)[];
  offers?: OfferSchema | OfferSchema[];
  eventStatus?: string;
  eventAttendanceMode?: string;
  previousStartDate?: string;
  doorTime?: string;
  duration?: string;
  inLanguage?: string;
  isAccessibleForFree?: boolean;
  maximumAttendeeCapacity?: number;
  remainingAttendeeCapacity?: number;
}
