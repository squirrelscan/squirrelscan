// Security rules - security checks

import type { Rule } from "../types";

import { cookieFlagsRule } from "./cookie-flags";
import { cspRule } from "./csp";
import { cspBlocksOwnResourcesRule } from "./csp-blocks-own-resources";
import { formCaptchaRule } from "./form-captcha";
import { formHttpsRule } from "./form-https";
import { graphqlGetMutationsRule } from "./graphql-get-mutations";
import { graphqlIntrospectionRule } from "./graphql-introspection";
import { hstsRule } from "./hsts";
import { httpToHttpsRule } from "./http-to-https";
import { httpsRule } from "./https";
import { leakedSecretsRule } from "./leaked-secrets";
import { mixedContentRule } from "./mixed-content";
import { newTabRule } from "./new-tab";
import { permissionsPolicyRule } from "./permissions-policy";
import { referrerPolicyRule } from "./referrer-policy";
import { sriRule } from "./sri";
import { thirdPartyCookiesRule } from "./third-party-cookies";
import { tokenStorageRule } from "./token-storage";
import { xContentTypeRule } from "./x-content-type";
import { xFrameOptionsRule } from "./x-frame-options";

export const rules: Rule[] = [
  httpsRule,
  httpToHttpsRule,
  hstsRule,
  cspRule,
  cspBlocksOwnResourcesRule,
  xFrameOptionsRule,
  xContentTypeRule,
  referrerPolicyRule,
  permissionsPolicyRule,
  mixedContentRule,
  formHttpsRule,
  formCaptchaRule,
  newTabRule,
  leakedSecretsRule,
  tokenStorageRule,
  thirdPartyCookiesRule,
  sriRule,
  cookieFlagsRule,
  graphqlIntrospectionRule,
  graphqlGetMutationsRule,
];

export {
  cookieFlagsRule,
  cspBlocksOwnResourcesRule,
  cspRule,
  formCaptchaRule,
  formHttpsRule,
  graphqlGetMutationsRule,
  graphqlIntrospectionRule,
  hstsRule,
  httpToHttpsRule,
  httpsRule,
  leakedSecretsRule,
  mixedContentRule,
  newTabRule,
  permissionsPolicyRule,
  referrerPolicyRule,
  sriRule,
  thirdPartyCookiesRule,
  tokenStorageRule,
  xContentTypeRule,
  xFrameOptionsRule,
};
