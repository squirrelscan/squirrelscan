// schema/organization: machine-readable merchant identity evidence for a
// confirmed shop. Informational only: it reports whether the page's markup
// declares an actual organization name plus an address or a tax/company
// identifier. It makes no claim about legal compliance and never invents an
// identifier. `absent` needs a complete read; a failed or truncated read, or no
// identifiable organization, is `unknown`.

import type { CheckResult, RuleContext } from "../types";

import {
  asList,
  collectNestedNodes,
  hasType,
  htmlReadState,
  isDanglingRef,
  isFilled,
  makeRefResolver,
  readMicrodata,
  readRdfa,
  visibleText,
  type EvidenceSource,
  type ReadState,
  type StructuredNode,
  type UnknownReason,
} from "../shared/structured-nodes";

export const ORGANIZATION_TYPES = ["Organization", "Corporation", "OnlineStore", "OnlineBusiness", "Store"];

const IDENTIFIER_PROPS = [
  "vatID",
  "taxID",
  "iso6523Code",
  "duns",
  "leiCode",
  "naics",
  "globalLocationNumber",
  "identifier",
];
const ADDRESS_PROPS = ["address", "legalAddress"];
const ADDRESS_PARTS = ["streetAddress", "addressLocality", "postalCode", "addressRegion", "addressCountry", "postOfficeBoxNumber"];
const PLACEHOLDER_NAMES = /^(organi[sz]ation|company|store|shop|name|business|your (company|store|name)|example|test|untitled|n\/a|tbd)$/i;

// Visible legal-notice wording: an identifier label followed by digits, or a legal-notice heading.
const LEGAL_ID_TEXT =
  /\b(?:VAT|TVA|USt-?IdNr\.?|Umsatzsteuer-?ID|company\s*(?:no|number|reg(?:istration)?)\.?|ABN|ACN|SIRET|SIREN|KvK|tax\s*id|registered\s*(?:no|number))\b[^0-9]{0,30}[A-Z]{0,3}[\s:#.-]*\d[\d\s.-]{4,}/i;
const LEGAL_NOTICE_TEXT = /\b(?:registered\s+office|impressum|legal\s+notice|mentions\s+l[ée]gales)\b/i;

export type MerchantStatus = "present" | "text-only" | "absent" | "unknown";

export interface MerchantField {
  status: "present" | "absent" | "unknown";
  source?: EvidenceSource;
  reason?: UnknownReason;
}

export interface MerchantIdentity {
  read: ReadState;
  status: MerchantStatus;
  reason?: UnknownReason;
  name: MerchantField;
  address: MerchantField;
  identifier: MerchantField;
  legalText: boolean;
}

interface OrgCandidate {
  source: EvidenceSource;
  node: StructuredNode;
}

type Resolve = (value: unknown) => unknown;

function nameOk(node: StructuredNode): boolean {
  const n = node["name"];
  const list = asList(n);
  return list.some((v) => typeof v === "string" && v.trim() !== "" && !PLACEHOLDER_NAMES.test(v.trim()));
}

function addressOk(node: StructuredNode, resolve: Resolve): boolean {
  for (const prop of ADDRESS_PROPS) {
    for (const raw of asList(node[prop])) {
      const v = resolve(raw);
      if (typeof v === "string" && v.trim() !== "") return true;
      if (v && typeof v === "object" && !isDanglingRef(v)) {
        const o = v as StructuredNode;
        if (ADDRESS_PARTS.some((k) => isFilled(o[k]))) return true;
      }
    }
  }
  return false;
}

function identifierOk(node: StructuredNode, resolve: Resolve): boolean {
  for (const prop of IDENTIFIER_PROPS) {
    for (const raw of asList(node[prop])) {
      const v = resolve(raw);
      if (isDanglingRef(v)) continue;
      if (typeof v === "string" || typeof v === "number") {
        if (isFilled(v)) return true;
      } else if (v && typeof v === "object" && isFilled((v as StructuredNode)["value"])) return true;
    }
  }
  return false;
}

/** The page's organization-like entities from every supported representation. */
export function readOrganizations(
  ctx: RuleContext,
  jsonLdNodes: StructuredNode[],
): { candidates: OrgCandidate[]; resolve: Resolve; allNodes: StructuredNode[]; read: ReadState } {
  const doc = ctx.parsed.document;
  const nested = collectNestedNodes(jsonLdNodes);
  const candidates: OrgCandidate[] = [];
  for (const node of nested) if (hasType(node, ...ORGANIZATION_TYPES)) candidates.push({ source: "json-ld", node });
  const markup: StructuredNode[] = [];
  if (doc) {
    for (const [source, read] of [["microdata", readMicrodata(doc)], ["rdfa", readRdfa(doc)]] as const) {
      for (const n of collectNestedNodes(read.nodes)) {
        markup.push(n);
        if (hasType(n, ...ORGANIZATION_TYPES)) candidates.push({ source, node: n });
      }
    }
  }
  const allNodes = [...nested, ...markup];
  return { candidates, resolve: makeRefResolver(allNodes, ctx.page.url), allNodes, read: htmlReadState(ctx) };
}

/** A confirmed shop: an ecommerce site profile, an OnlineStore, or product markup on the page. */
export function isConfirmedShop(ctx: RuleContext, allNodes: StructuredNode[]): boolean {
  const st = ctx.siteMetadata?.siteType;
  if (st === "ecommerce" || st === "marketplace") return true;
  return allNodes.some((n) => hasType(n, "OnlineStore", "Product", "ProductGroup"));
}

export function readMerchantIdentity(
  ctx: RuleContext,
  org: ReturnType<typeof readOrganizations>,
): MerchantIdentity | null {
  if (!isConfirmedShop(ctx, org.allNodes)) return null;
  const { candidates, resolve, read } = org;
  const doc = ctx.parsed.document;

  const scored = candidates.map((c) => ({
    c,
    name: nameOk(c.node),
    address: addressOk(c.node, resolve),
    identifier: identifierOk(c.node, resolve),
  }));
  scored.sort((a, b) => Number(b.name) * 4 + Number(b.address) + Number(b.identifier) - (Number(a.name) * 4 + Number(a.address) + Number(a.identifier)));
  const best = scored[0];

  const text = doc && read !== "failed" ? visibleText(doc) : "";
  const legalText = LEGAL_ID_TEXT.test(text) || LEGAL_NOTICE_TEXT.test(text);

  const field = (found: boolean): MerchantField => {
    if (found && best) return { status: "present", source: best.c.source };
    if (read !== "complete") return { status: "unknown", reason: "incomplete-read" };
    if (!best) return { status: "unknown", reason: "no-organization" };
    return { status: "absent" };
  };
  const name = field(!!best?.name);
  const address = field(!!best?.address);
  const identifier = field(!!best?.identifier);

  let status: MerchantStatus;
  let reason: UnknownReason | undefined;
  if (name.status === "present" && (address.status === "present" || identifier.status === "present")) {
    status = "present";
  } else if (legalText) {
    status = "text-only";
  } else if (read !== "complete") {
    status = "unknown";
    reason = "incomplete-read";
  } else if (!best) {
    status = "unknown";
    reason = "no-organization";
  } else {
    status = "absent";
  }
  return { read, status, reason, name, address, identifier, legalText };
}

function describe(f: MerchantField): string {
  if (f.status === "present") return `present (${f.source})`;
  if (f.status === "absent") return "absent";
  return `unknown (${f.reason})`;
}

export function merchantIdentityCheck(m: MerchantIdentity): CheckResult {
  const label = m.status === "unknown" ? `unknown (${m.reason})` : m.status;
  return {
    name: "organization-merchant-identity",
    status: "info",
    message: `Merchant identity in structured data: ${label}`,
    value: "Informational data gap only: observable markup, not a legal compliance check",
    items: [
      { id: "name", label: describe(m.name) },
      { id: "address", label: describe(m.address) },
      { id: "identifier", label: describe(m.identifier) },
      { id: "legal-notice-text", label: m.legalText ? "visible text only" : "not seen" },
    ],
    details: {
      read: m.read,
      status: m.status,
      reason: m.reason,
      fields: { name: m.name, address: m.address, identifier: m.identifier },
      legalNoticeText: m.legalText,
    },
  };
}
