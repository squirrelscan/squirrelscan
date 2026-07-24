// A11y rules - accessibility checks

import type { Rule } from "../types";

import { accesskeysRule } from "./accesskeys";
import { ariaAllowedAttrRule } from "./aria-allowed-attr";
import { ariaCommandNameRule } from "./aria-command-name";
import { ariaDeprecatedRoleRule } from "./aria-deprecated-role";
import { ariaDialogNameRule } from "./aria-dialog-name";
import { ariaHiddenBodyRule } from "./aria-hidden-body";
import { ariaHiddenFocusRule } from "./aria-hidden-focus";
import { ariaInputFieldNameRule } from "./aria-input-field-name";
import { ariaLabelsRule } from "./aria-labels";
import { ariaMeterNameRule } from "./aria-meter-name";
import { ariaProgressbarNameRule } from "./aria-progressbar-name";
import { ariaRequiredAttrRule } from "./aria-required-attr";
import { ariaRequiredChildrenRule } from "./aria-required-children";
import { ariaRequiredParentRule } from "./aria-required-parent";
import { ariaRolesRule } from "./aria-roles";
import { ariaTextRule } from "./aria-text";
import { ariaToggleFieldNameRule } from "./aria-toggle-field-name";
import { ariaTooltipNameRule } from "./aria-tooltip-name";
import { ariaTreeitemNameRule } from "./aria-treeitem-name";
import { ariaValidAttrRule } from "./aria-valid-attr";
import { ariaValidAttrValueRule } from "./aria-valid-attr-value";
import { buttonNameRule } from "./button-name";
import { colorContrastRule } from "./color-contrast";
import { definitionListRule } from "./definition-list";
import { dlitemRule } from "./dlitem";
import { duplicateIdActiveRule } from "./duplicate-id-active";
import { duplicateIdAriaRule } from "./duplicate-id-aria";
import { emptyHeadingRule } from "./empty-heading";
import { focusVisibleRule } from "./focus-visible";
import { formFieldMultipleLabelsRule } from "./form-field-multiple-labels";
import { formLabelsRule } from "./form-labels";
import { frameTitleRule } from "./frame-title";
import { headingOrderRule } from "./heading-order";
import { htmlLangValidRule } from "./html-lang-valid";
import { htmlXmlLangMismatchRule } from "./html-xml-lang-mismatch";
import { identicalLinksSamePurposeRule } from "./identical-links-same-purpose";
import { imageRedundantAltRule } from "./image-redundant-alt";
import { inputImageAltRule } from "./input-image-alt";
import { labelContentNameMismatchRule } from "./label-content-name-mismatch";
import { landmarkOneMainRule } from "./landmark-one-main";
import { landmarkRegionsRule } from "./landmark-regions";
import { linkInTextBlockRule } from "./link-in-text-block";
import { linkTextRule } from "./link-text";
import { listStructureRule } from "./list-structure";
import { listitemRule } from "./listitem";
import { metaRefreshRule } from "./meta-refresh";
import { objectAltRule } from "./object-alt";
import { pasteInputsRule } from "./paste-inputs";
import { selectNameRule } from "./select-name";
import { skipLinkRule } from "./skip-link";
import { tabindexRule } from "./tabindex";
import { tableDuplicateNameRule } from "./table-duplicate-name";
import { tableHeadersRule } from "./table-headers";
import { tdHeadersAttrRule } from "./td-headers-attr";
import { thHasDataCellsRule } from "./th-has-data-cells";
import { touchTargetsRule } from "./touch-targets";
import { validLangRule } from "./valid-lang";
import { videoCaptionsRule } from "./video-captions";
import { zoomDisabledRule } from "./zoom-disabled";

export const rules: Rule[] = [
  // Core accessibility
  skipLinkRule,
  ariaLabelsRule,
  formLabelsRule,
  pasteInputsRule,
  colorContrastRule,
  focusVisibleRule,
  touchTargetsRule,
  landmarkRegionsRule,
  headingOrderRule,
  linkTextRule,
  tableHeadersRule,
  videoCaptionsRule,
  zoomDisabledRule,

  // ARIA validation
  ariaValidAttrRule,
  ariaValidAttrValueRule,
  ariaRolesRule,
  ariaRequiredAttrRule,
  ariaRequiredParentRule,
  ariaRequiredChildrenRule,
  ariaAllowedAttrRule,
  ariaHiddenBodyRule,
  ariaHiddenFocusRule,

  // ARIA naming
  ariaCommandNameRule,
  ariaDialogNameRule,
  ariaInputFieldNameRule,
  ariaMeterNameRule,
  ariaProgressbarNameRule,
  ariaTextRule,
  ariaToggleFieldNameRule,
  ariaTooltipNameRule,
  ariaTreeitemNameRule,

  // Element-specific accessibility
  buttonNameRule,
  inputImageAltRule,
  selectNameRule,
  frameTitleRule,
  objectAltRule,
  emptyHeadingRule,

  // List and structure
  definitionListRule,
  dlitemRule,
  listStructureRule,
  listitemRule,

  // Tables
  tdHeadersAttrRule,
  thHasDataCellsRule,

  // IDs and navigation
  duplicateIdActiveRule,
  duplicateIdAriaRule,
  accesskeysRule,
  tabindexRule,

  // Language and localization
  htmlLangValidRule,
  validLangRule,
  htmlXmlLangMismatchRule,

  // Page-level checks
  metaRefreshRule,
  landmarkOneMainRule,

  // Content and links
  linkInTextBlockRule,
  identicalLinksSamePurposeRule,
  labelContentNameMismatchRule,
  imageRedundantAltRule,

  // Forms
  formFieldMultipleLabelsRule,

  // Tables
  tableDuplicateNameRule,

  // ARIA deprecation
  ariaDeprecatedRoleRule,
];

export {
  accesskeysRule,
  ariaAllowedAttrRule,
  ariaCommandNameRule,
  ariaDeprecatedRoleRule,
  ariaDialogNameRule,
  ariaHiddenBodyRule,
  ariaHiddenFocusRule,
  ariaInputFieldNameRule,
  ariaLabelsRule,
  ariaMeterNameRule,
  ariaProgressbarNameRule,
  ariaRequiredAttrRule,
  ariaRequiredChildrenRule,
  ariaRequiredParentRule,
  ariaRolesRule,
  ariaTextRule,
  ariaToggleFieldNameRule,
  ariaTooltipNameRule,
  ariaTreeitemNameRule,
  ariaValidAttrRule,
  ariaValidAttrValueRule,
  buttonNameRule,
  colorContrastRule,
  definitionListRule,
  dlitemRule,
  duplicateIdActiveRule,
  duplicateIdAriaRule,
  emptyHeadingRule,
  focusVisibleRule,
  formFieldMultipleLabelsRule,
  formLabelsRule,
  frameTitleRule,
  headingOrderRule,
  htmlLangValidRule,
  htmlXmlLangMismatchRule,
  identicalLinksSamePurposeRule,
  imageRedundantAltRule,
  inputImageAltRule,
  labelContentNameMismatchRule,
  landmarkOneMainRule,
  landmarkRegionsRule,
  linkInTextBlockRule,
  linkTextRule,
  listStructureRule,
  listitemRule,
  metaRefreshRule,
  objectAltRule,
  pasteInputsRule,
  selectNameRule,
  skipLinkRule,
  tableDuplicateNameRule,
  tabindexRule,
  tableHeadersRule,
  tdHeadersAttrRule,
  thHasDataCellsRule,
  touchTargetsRule,
  validLangRule,
  videoCaptionsRule,
  zoomDisabledRule,
};
