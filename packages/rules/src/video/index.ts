// Video rules - video SEO checks
// VideoObject schema, thumbnails, captions

import type { Rule } from "../types";

import { videoAccessibleRule } from "./video-accessible";
import { videoSchemaPresenceRule } from "./video-schema";
import { videoThumbnailRule } from "./video-thumbnail";

export const rules: Rule[] = [
  videoSchemaPresenceRule,
  videoThumbnailRule,
  videoAccessibleRule,
];
