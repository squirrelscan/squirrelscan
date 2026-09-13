// Schema rules - structured data checks

import type { Rule } from "../types";

import { articleSchemaRule } from "./article";
import { breadcrumbSchemaRule } from "./breadcrumb";
import { schemaCoverageOutlierRule } from "./coverage-outlier";
import { entityAuthorsRule } from "./entity-authors";
import { entityConflictsRule } from "./entity-conflicts";
import { entityDanglingRule } from "./entity-dangling";
import { entityIdFormatRule } from "./entity-id-format";
import { entityIdentityRule } from "./entity-identity";
import { entityLocalBusinessPerPageRule } from "./entity-local-business-per-page";
import { entityOrganizationMissingRule } from "./entity-organization-missing";
import { entityOrphanRule } from "./entity-orphan";
import { entityPublisherMismatchRule } from "./entity-publisher-mismatch";
import { entitySameAsMissingRule } from "./entity-sameas-missing";
import { entitySplitIdentityRule } from "./entity-split-identity";
import { entityTypeDriftRule } from "./entity-type-drift";
import { entityWebsiteMissingRule } from "./entity-website-missing";
import { faqSchemaRule } from "./faq";
import { jsonLdValidRule } from "./json-ld-valid";
import { localBusinessSchemaRule } from "./local-business";
import { organizationSchemaRule } from "./organization";
import { productSchemaRule } from "./product";
import { ratingScopeRule } from "./rating-scope";
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
  ratingScopeRule,
  schemaCoverageOutlierRule,
  // Entity-map rules (#2093). Ordered by severity then by how much of the
  // site's graph they speak about, so a reader meets the identity failures
  // before the completeness suggestions.
  entityIdentityRule,
  entitySplitIdentityRule,
  entityDanglingRule,
  entityConflictsRule,
  entityIdFormatRule,
  entityTypeDriftRule,
  entityAuthorsRule,
  entityPublisherMismatchRule,
  entityLocalBusinessPerPageRule,
  entityWebsiteMissingRule,
  entityOrganizationMissingRule,
  entitySameAsMissingRule,
  entityOrphanRule,
];

export {
  articleSchemaRule,
  breadcrumbSchemaRule,
  entityAuthorsRule,
  entityConflictsRule,
  entityDanglingRule,
  entityIdFormatRule,
  entityIdentityRule,
  entityLocalBusinessPerPageRule,
  entityOrganizationMissingRule,
  entityOrphanRule,
  entityPublisherMismatchRule,
  entitySameAsMissingRule,
  entitySplitIdentityRule,
  entityTypeDriftRule,
  entityWebsiteMissingRule,
  faqSchemaRule,
  jsonLdValidRule,
  localBusinessSchemaRule,
  organizationSchemaRule,
  productSchemaRule,
  ratingScopeRule,
  reviewSchemaRule,
  schemaCoverageOutlierRule,
  videoSchemaRule,
  websiteSearchSchemaRule,
};
