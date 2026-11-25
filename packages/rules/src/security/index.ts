// Security rules - security checks

import type { Rule } from "../types";

import { authEndpointDisclosureRule } from "./auth-endpoint-disclosure";
import { clientSideAuthzRule } from "./client-side-authz";
import { cookieFlagsRule } from "./cookie-flags";
import { cspRule } from "./csp";
import { cspBlocksOwnResourcesRule } from "./csp-blocks-own-resources";
import { cspViolationsRule } from "./csp-violations";
import { exposedActuatorRule } from "./exposed-actuator";
import { exposedBackupsRule } from "./exposed-backups";
import { exposedFilesRule } from "./exposed-files";
import { formCaptchaRule } from "./form-captcha";
import { formHttpsRule } from "./form-https";
import { getStateChangeRule } from "./get-state-change";
import { graphqlGetMutationsRule } from "./graphql-get-mutations";
import { graphqlIntrospectionRule } from "./graphql-introspection";
import { hstsRule } from "./hsts";
import { httpToHttpsRule } from "./http-to-https";
import { httpsRule } from "./https";
import { jsonSensitiveFieldsRule } from "./json-sensitive-fields";
import { leakedSecretsRule } from "./leaked-secrets";
import { mixedContentRule } from "./mixed-content";
import { newTabRule } from "./new-tab";
import { openRedirectRule } from "./open-redirect";
import { passwordFormGetRule } from "./password-form-get";
import { permissionsPolicyRule } from "./permissions-policy";
import { queryErrorFuzzRule } from "./query-error-fuzz";
import { referrerPolicyRule } from "./referrer-policy";
import { securityTxtRule } from "./security-txt";
import { sriRule } from "./sri";
import { supabaseRlsRule } from "./supabase-rls";
import { thirdPartyCookiesRule } from "./third-party-cookies";
import { tlsCertificateRule } from "./tls-certificate";
import { tokenStorageRule } from "./token-storage";
import { unauthenticatedApiRule } from "./unauthenticated-api";
import { versionDisclosureRule } from "./version-disclosure";
import { xContentTypeRule } from "./x-content-type";
import { xFrameOptionsRule } from "./x-frame-options";

export const rules: Rule[] = [
  httpsRule,
  httpToHttpsRule,
  hstsRule,
  tlsCertificateRule,
  cspRule,
  cspBlocksOwnResourcesRule,
  cspViolationsRule,
  xFrameOptionsRule,
  xContentTypeRule,
  referrerPolicyRule,
  permissionsPolicyRule,
  mixedContentRule,
  formHttpsRule,
  formCaptchaRule,
  newTabRule,
  passwordFormGetRule,
  getStateChangeRule,
  leakedSecretsRule,
  tokenStorageRule,
  thirdPartyCookiesRule,
  sriRule,
  cookieFlagsRule,
  graphqlIntrospectionRule,
  graphqlGetMutationsRule,
  unauthenticatedApiRule,
  jsonSensitiveFieldsRule,
  exposedFilesRule,
  exposedBackupsRule,
  authEndpointDisclosureRule,
  openRedirectRule,
  clientSideAuthzRule,
  exposedActuatorRule,
  supabaseRlsRule,
  securityTxtRule,
  versionDisclosureRule,
  queryErrorFuzzRule,
];

export {
  authEndpointDisclosureRule,
  clientSideAuthzRule,
  cookieFlagsRule,
  cspBlocksOwnResourcesRule,
  cspRule,
  cspViolationsRule,
  exposedFilesRule,
  exposedActuatorRule,
  exposedBackupsRule,
  formCaptchaRule,
  formHttpsRule,
  graphqlGetMutationsRule,
  graphqlIntrospectionRule,
  hstsRule,
  httpToHttpsRule,
  httpsRule,
  jsonSensitiveFieldsRule,
  leakedSecretsRule,
  mixedContentRule,
  newTabRule,
  getStateChangeRule,
  openRedirectRule,
  passwordFormGetRule,
  permissionsPolicyRule,
  queryErrorFuzzRule,
  referrerPolicyRule,
  securityTxtRule,
  sriRule,
  supabaseRlsRule,
  thirdPartyCookiesRule,
  tlsCertificateRule,
  tokenStorageRule,
  unauthenticatedApiRule,
  versionDisclosureRule,
  xContentTypeRule,
  xFrameOptionsRule,
};
