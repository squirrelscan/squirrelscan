// ax/api-discovery - detect api-catalog, OpenAPI, and OAuth discovery documents

import type { WellKnownProbe } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

const API_CATALOG_PATH = "/.well-known/api-catalog";
const OPENAPI_PATHS: readonly string[] = ["/openapi.json", "/swagger.json", "/api/openapi.json"];
const OAUTH_AS_PATH = "/.well-known/oauth-authorization-server";
const OAUTH_PRM_PATH = "/.well-known/oauth-protected-resource";

function isRealHit(p: WellKnownProbe): boolean {
  return p.status === 200 && p.jsonValid && !p.looksHtml;
}

// An OpenAPI/Swagger document names its own spec version at the top level.
function looksLikeOpenApiDoc(p: WellKnownProbe): boolean {
  if (p.jsonKeys.some((k) => ["openapi", "swagger"].includes(k.toLowerCase()))) return true;
  return /"(openapi|swagger)"\s*:/.test(p.excerpt);
}

export const apiDiscoveryRule: Rule = {
  meta: {
    id: "ax/api-discovery",
    name: "API & OAuth Discovery",
    description:
      "Detects an RFC 9727 api-catalog, an OpenAPI specification, and OAuth discovery documents (RFC 8414 authorization server metadata, RFC 9728 protected-resource metadata) — the documents that let an agent introspect and call an API without a human reading docs first",
    solution:
      "If you expose a public API, publish an OpenAPI spec at a conventional path and, if practical, an api-catalog pointing to it. If the API requires OAuth, publish the discovery documents, and add registration_endpoint (Dynamic Client Registration) or client_id_metadata_document_supported (CIMD) to your authorization server metadata so an agent can self-onboard instead of waiting on a human to register a client. This is a recommendation only — it never affects your score; not every site has (or needs) a public API.",
    category: "ax",
    scope: "site",
    severity: "info",
    weight: 1,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const wk = ctx.site?.wellKnown;

    if (!wk) {
      checks.push({ name: "api-discovery", status: "info", message: "well-known probe data not available" });
      return { checks };
    }

    const apiCatalogHit = wk.probes.find((p) => p.path === API_CATALOG_PATH && isRealHit(p));
    const openapiHit = wk.probes.find(
      (p) => OPENAPI_PATHS.includes(p.path) && isRealHit(p) && looksLikeOpenApiDoc(p),
    );

    if (!apiCatalogHit && !openapiHit) {
      checks.push({
        name: "api-discovery",
        status: "info",
        message: "No api-catalog or OpenAPI specification found",
        value: "absent",
      });
    } else {
      const found = [
        ...(apiCatalogHit ? [`api-catalog (${apiCatalogHit.path})`] : []),
        ...(openapiHit ? [`OpenAPI spec (${openapiHit.path})`] : []),
      ];
      checks.push({
        name: "api-discovery",
        status: "info",
        message: `API discovery document(s) found: ${found.join(", ")}`,
        value: "present",
        details: {
          apiCatalogPath: apiCatalogHit?.path ?? null,
          openapiPath: openapiHit?.path ?? null,
        },
      });
    }

    const asHit = wk.probes.find((p) => p.path === OAUTH_AS_PATH && isRealHit(p));
    const prmHit = wk.probes.find((p) => p.path === OAUTH_PRM_PATH && isRealHit(p));

    if (!asHit && !prmHit) {
      checks.push({
        name: "api-discovery-oauth",
        status: "info",
        message: "No OAuth discovery documents found",
        value: "absent",
      });
      return { checks };
    }

    const found = [
      ...(asHit ? ["authorization server metadata (RFC 8414)"] : []),
      ...(prmHit ? ["protected-resource metadata (RFC 9728)"] : []),
    ];

    if (!asHit) {
      checks.push({
        name: "api-discovery-oauth",
        status: "info",
        message: `OAuth discovery found: ${found.join(", ")}`,
        value: "present",
        details: { authorizationServerPath: null, protectedResourcePath: prmHit?.path ?? null },
      });
      return { checks };
    }

    const hasDcr = Boolean(asHit.oauthRegistrationEndpoint);
    const hasCimd = asHit.oauthClientIdMetadataDocumentSupported === true;

    if (hasDcr || hasCimd) {
      const mechanisms = [
        ...(hasDcr ? ["Dynamic Client Registration (RFC 7591)"] : []),
        ...(hasCimd ? ["Client ID Metadata Documents (CIMD)"] : []),
      ];
      checks.push({
        name: "api-discovery-oauth",
        status: "info",
        message: `OAuth discovery found: ${found.join(", ")}; agent self-onboarding available via ${mechanisms.join(" and ")}`,
        value: "self-onboarding",
        details: {
          authorizationServerPath: asHit.path,
          protectedResourcePath: prmHit?.path ?? null,
          registrationEndpoint: asHit.oauthRegistrationEndpoint,
          cimdSupported: hasCimd,
        },
      });
      return { checks };
    }

    checks.push({
      name: "api-discovery-oauth",
      status: "info",
      message: `OAuth discovery found: ${found.join(
        ", ",
      )}, but no registration_endpoint (DCR) or client_id_metadata_document_supported (CIMD) — an agent can find the authorization server but a human still has to register a client by hand`,
      value: "no-self-onboarding",
      details: { authorizationServerPath: asHit.path, protectedResourcePath: prmHit?.path ?? null },
    });

    return { checks };
  },
};
