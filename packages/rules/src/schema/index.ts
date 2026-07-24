// Schema rules - structured data checks

import type { Rule } from "../types";

import { articleSchemaRule } from "./article";
import { breadcrumbSchemaRule } from "./breadcrumb";
import { faqSchemaRule } from "./faq";
import { jsonLdValidRule } from "./json-ld-valid";
import { localBusinessSchemaRule } from "./local-business";
import { organizationSchemaRule } from "./organization";
import { productSchemaRule } from "./product";
import { reviewSchemaRule } from "./review";
import { videoSchemaRule } from "./video";
import { websiteSearchSchemaRule } from "./website-search";

export const rules: Rule[] = [
  jsonLdValidRule,
  articleSchemaRule,
  productSchemaRule,
  localBusinessSchemaRule,
  faqSchemaRule,
  breadcrumbSchemaRule,
  websiteSearchSchemaRule,
  organizationSchemaRule,
  videoSchemaRule,
  reviewSchemaRule,
];

export {
  articleSchemaRule,
  breadcrumbSchemaRule,
  faqSchemaRule,
  jsonLdValidRule,
  localBusinessSchemaRule,
  organizationSchemaRule,
  productSchemaRule,
  reviewSchemaRule,
  videoSchemaRule,
  websiteSearchSchemaRule,
};
