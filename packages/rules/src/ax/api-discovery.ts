// ax/api-discovery - detect api-catalog, OpenAPI, and OAuth discovery documents

import type { WellKnownPath, WellKnownProbe } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { answeredWellKnown, includesPath, notCheckedCheck } from "./discovery-probe-state";

const API_CATALOG_PATH: WellKnownPath = "/.well-known/api-catalog";
const OPENAPI_PATHS: readonly WellKnownPath[] = [
  "/openapi.json",
  "/swagger.json",
  "/api/openapi.json",
];
const OAUTH_AS_PATH: WellKnownPath = "/.well-known/oauth-authorization-server";
const OAUTH_PRM_PATH: WellKnownPath = "/.well-known/oauth-protected-resource";
const API_DOC_PATHS: readonly WellKnownPath[] = [API_CATALOG_PATH, ...OPENAPI_PATHS];
const OAUTH_PATHS: readonly WellKnownPath[] = [OAUTH_AS_PATH, OAUTH_PRM_PATH];

function isRealHit(p: WellKnownProbe): boolean {
  return p.status === 200 && p.jsonValid && !p.looksHtml;
}

// An OpenAPI/Swagger document names its own spec version at the top level.
function looksLikeOpenApiDoc(p: WellKnownProbe): boolean {
  if (p.jsonKeys.some((k) => ["openapi", "swagger"].includes(k.toLowerCase()))) return true;
  return /"(openapi|swagger)"\s*:/.test(p.excerpt);
}

// A refusal, a throttle or a server error says nothing about whether the file
// exists, so it is "not checked", never "missing" (#1650).
function isBlockedStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

export type ApiCatalogState =
  | "present"
  | "empty-linkset"
  | "invalid-linkset"
  | "not-a-catalog"
  | "openapi-document"
  | "malformed-json"
  | "html-fallback"
  | "blocked"
  | "absent"
  | "not-requested";

/** The shape of the `linkset` member: a non-empty array holding at least one link context object. */
function linksetShape(p: WellKnownProbe): "non-empty" | "empty" | "invalid" {
  try {
    const parsed: unknown = JSON.parse(p.excerpt);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const linkset = (parsed as Record<string, unknown>).linkset;
      if (!Array.isArray(linkset)) return "invalid";
      return linkset.some((e) => e !== null && typeof e === "object" && !Array.isArray(e))
        ? "non-empty"
        : "empty";
    }
    return "invalid";
  } catch {
    // The excerpt is capped, so a large catalog is cut mid-document. The crawler
    // already parsed the whole body (`jsonValid`, `jsonKeys`); read the head only.
    if (/"linkset"\s*:\s*\[\s*\]/.test(p.excerpt)) return "empty";
    if (/"linkset"\s*:\s*\[\s*\{/.test(p.excerpt)) return "non-empty";
    return "invalid";
  }
}

export function classifyApiCatalog(p: WellKnownProbe | undefined): ApiCatalogState {
  if (!p) return "not-requested";
  if (p.status === 0) return "not-requested";
  if (isBlockedStatus(p.status)) return "blocked";
  if (p.status !== 200) return "absent";
  if (p.looksHtml) return "html-fallback";
  if (!p.jsonValid) return "malformed-json";
  if (looksLikeOpenApiDoc(p)) return "openapi-document";
  if (!p.jsonKeys.some((k) => k === "linkset")) return "not-a-catalog";
  const shape = linksetShape(p);
  if (shape === "non-empty") return "present";
  return shape === "empty" ? "empty-linkset" : "invalid-linkset";
}

const CATALOG_STATE_TEXT: Partial<Record<ApiCatalogState, string>> = {
  "empty-linkset": "the api-catalog at /.well-known/api-catalog has an empty linkset",
  "invalid-linkset": "the api-catalog at /.well-known/api-catalog has a linkset that is not a list of link objects",
  "not-a-catalog": "/.well-known/api-catalog is JSON without a linkset member",
  "openapi-document": "/.well-known/api-catalog serves an OpenAPI document, not a linkset catalog",
  "malformed-json": "/.well-known/api-catalog does not parse as JSON",
  "html-fallback": "/.well-known/api-catalog returned an HTML page, not a catalog",
};

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
    discoveryProbes: [...API_DOC_PATHS, ...OAUTH_PATHS],
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const wk = ctx.site?.wellKnown;

    if (!wk) {
      checks.push(notCheckedCheck("api-discovery", "API and OAuth discovery documents"));
      return { checks };
    }

    const catalogProbe = wk.probes.find((p) => p.path === API_CATALOG_PATH);
    const catalogState = classifyApiCatalog(catalogProbe);
    const apiCatalogHit = catalogState === "present" ? catalogProbe : undefined;
    const openapiHit = wk.probes.find(
      (p) => includesPath(OPENAPI_PATHS, p.path) && isRealHit(p) && looksLikeOpenApiDoc(p),
    );

    const apiDocs = answeredWellKnown(wk, API_DOC_PATHS);
    const blockedPaths = apiDocs.answered
      .filter((p) => isBlockedStatus(p.status))
      .map((p) => p.path as WellKnownPath);
    const unchecked = [...apiDocs.unchecked, ...blockedPaths];
    const catalogText = CATALOG_STATE_TEXT[catalogState];
    if (!apiCatalogHit && !openapiHit && catalogText) {
      // The catalog answered, with something that is not a usable catalog: name
      // which kind of not-usable, whatever the other paths did.
      checks.push({
        name: "api-discovery",
        status: "info",
        message: `No valid api-catalog: ${catalogText}`,
        value: catalogState,
        details: {
          apiCatalogState: catalogState,
          apiCatalogPath: API_CATALOG_PATH,
          ...(unchecked.length > 0 ? { notChecked: unchecked } : {}),
        },
      });
    } else if (!apiCatalogHit && !openapiHit && unchecked.length > 0) {
      // Absence is only established for paths that got an answer.
      checks.push(
        notCheckedCheck(
          "api-discovery",
          "API discovery documents",
          {
            notChecked: unchecked,
            apiCatalogState: catalogState,
            ...(blockedPaths.length > 0
              ? {
                  blocked: Object.fromEntries(
                    apiDocs.answered
                      .filter((p) => isBlockedStatus(p.status))
                      .map((p) => [p.path, p.status]),
                  ),
                }
              : {}),
          },
          blockedPaths.length > 0 && apiDocs.unchecked.length === 0 ? "blocked" : apiDocs.reason,
        ),
      );
    } else if (!apiCatalogHit && !openapiHit) {
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
          apiCatalogState: catalogState,
          ...(apiCatalogHit
            ? {
                apiCatalogMediaTypeOk: /application\/linkset\+json/i.test(
                  apiCatalogHit.contentType ?? "",
                ),
              }
            : {}),
        },
      });
    }

    const asHit = wk.probes.find((p) => p.path === OAUTH_AS_PATH && isRealHit(p));
    const prmHit = wk.probes.find((p) => p.path === OAUTH_PRM_PATH && isRealHit(p));

    const oauth = answeredWellKnown(wk, OAUTH_PATHS);
    if (!asHit && !prmHit && oauth.unchecked.length > 0) {
      checks.push(
        notCheckedCheck(
          "api-discovery-oauth",
          "OAuth discovery documents",
          { notChecked: oauth.unchecked },
          oauth.reason,
        ),
      );
      return { checks };
    }

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
