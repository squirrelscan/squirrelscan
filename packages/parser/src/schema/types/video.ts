// Video schema type

import type { ImageObjectSchema, SchemaType } from "./base";
import type { OrganizationSchema } from "./organization";
import type { PersonSchema } from "./person";

/**
 * Clip schema - for video segments
 */
export interface ClipSchema extends SchemaType {
  "@type": "Clip";
  name?: string;
  startOffset?: number;
  endOffset?: number;
  url?: string;
}

/**
 * VideoObject schema
 */
export interface VideoObjectSchema extends SchemaType {
  "@type": "VideoObject";
  name?: string;
  description?: string;
  thumbnailUrl?: string | string[];
  uploadDate?: string;
  duration?: string; // ISO 8601 duration
  contentUrl?: string;
  embedUrl?: string;
  interactionStatistic?: {
    "@type": "InteractionCounter";
    interactionType?: { "@type": string };
    userInteractionCount?: number;
  };
  publication?: {
    "@type": "BroadcastEvent";
    isLiveBroadcast?: boolean;
    startDate?: string;
    endDate?: string;
  };
  regionsAllowed?: string | string[];
  hasPart?: ClipSchema | ClipSchema[];
  transcript?: string;
  author?: PersonSchema | OrganizationSchema;
  creator?: PersonSchema | OrganizationSchema;
  publisher?: OrganizationSchema;
  image?: string | ImageObjectSchema;
  inLanguage?: string;
  isFamilyFriendly?: boolean;
  requiresSubscription?: boolean | string;
}

/**
 * AudioObject schema
 */
export interface AudioObjectSchema extends SchemaType {
  "@type": "AudioObject";
  name?: string;
  description?: string;
  contentUrl?: string;
  duration?: string;
  uploadDate?: string;
  author?: PersonSchema | OrganizationSchema;
  encodingFormat?: string;
  transcript?: string;
}
