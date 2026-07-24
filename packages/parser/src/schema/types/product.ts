// Product schema type

import type { ImageObjectSchema, SchemaType } from "./base";
import type { OrganizationSchema } from "./organization";
import type { PersonSchema } from "./person";

/**
 * Brand schema
 */
export interface BrandSchema extends SchemaType {
  "@type": "Brand";
  name?: string;
  logo?: string | ImageObjectSchema;
  url?: string;
}

/**
 * Offer schema - for product pricing
 */
export interface OfferSchema extends SchemaType {
  "@type": "Offer";
  price?: number | string;
  priceCurrency?: string;
  availability?: string;
  url?: string;
  priceValidUntil?: string;
  itemCondition?: string;
  seller?: OrganizationSchema | PersonSchema;
  shippingDetails?: ShippingDetailsSchema;
}

interface ShippingDetailsSchema extends SchemaType {
  "@type": "OfferShippingDetails";
  shippingRate?: {
    "@type": "MonetaryAmount";
    value?: number | string;
    currency?: string;
  };
  shippingDestination?: {
    "@type": "DefinedRegion";
    addressCountry?: string;
  };
  deliveryTime?: {
    "@type": "ShippingDeliveryTime";
    handlingTime?: { minValue?: number; maxValue?: number };
    transitTime?: { minValue?: number; maxValue?: number };
  };
}

/**
 * AggregateRating schema
 */
export interface AggregateRatingSchema extends SchemaType {
  "@type": "AggregateRating";
  ratingValue?: number | string;
  bestRating?: number | string;
  worstRating?: number | string;
  ratingCount?: number;
  reviewCount?: number;
}

/**
 * Review schema
 */
export interface ReviewSchema extends SchemaType {
  "@type": "Review";
  author?: PersonSchema | OrganizationSchema | string;
  datePublished?: string;
  reviewBody?: string;
  reviewRating?: {
    "@type": "Rating";
    ratingValue?: number | string;
    bestRating?: number | string;
    worstRating?: number | string;
  };
}

/**
 * Product schema
 */
export interface ProductSchema extends SchemaType {
  "@type": "Product" | "ProductGroup" | string;
  name?: string;
  description?: string;
  image?: string | ImageObjectSchema | (string | ImageObjectSchema)[];
  brand?: BrandSchema | string;
  offers?: OfferSchema | OfferSchema[];
  aggregateRating?: AggregateRatingSchema;
  review?: ReviewSchema | ReviewSchema[];
  sku?: string;
  gtin?: string;
  gtin8?: string;
  gtin13?: string;
  gtin14?: string;
  mpn?: string;
  color?: string;
  material?: string;
  size?: string;
  weight?:
    | string
    | { "@type": "QuantitativeValue"; value?: number; unitCode?: string };
  category?: string;
  manufacturer?: OrganizationSchema | string;
}
