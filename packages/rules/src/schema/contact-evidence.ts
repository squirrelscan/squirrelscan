// schema/organization: which contact channels the page's own markup and HTML
// show, kept apart instead of treated as equivalent: structured ContactPoint
// (or organization-level) telephone and email, visible mailto: and tel: links,
// and a contact form. Informational only: it describes what was observed on
// this page and implies no requirement to publish private contact details. A
// channel that was not seen on a failed or truncated read is `unknown`, not
// `absent`.

import type { CheckResult, RuleContext } from "../types";

import {
  asList,
  collectNestedNodes,
  hasType,
  isDanglingRef,
  isFilled,
  type EvidenceSource,
  type ReadState,
  type StructuredNode,
  type UnknownReason,
} from "../shared/structured-nodes";
import type { readOrganizations } from "./merchant-evidence";

export const CONTACT_CHANNELS = [
  "structured-telephone",
  "structured-email",
  "mailto-link",
  "tel-link",
  "contact-form",
] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export interface ChannelEvidence {
  channel: ContactChannel;
  status: "present" | "absent" | "unknown";
  source?: EvidenceSource | "html";
  reason?: UnknownReason;
}

export interface ContactEvidence {
  read: ReadState;
  channels: ChannelEvidence[];
  /** A form was seen and no structured or link channel was. */
  formOnly: boolean;
}

type Resolve = (value: unknown) => unknown;
type Org = ReturnType<typeof readOrganizations>;

const MAX_FORMS = 200;

/** Telephone and email declared on organization entities and on ContactPoint nodes, by representation. */
function structuredChannels(org: Org, resolve: Resolve): Map<"structured-telephone" | "structured-email", EvidenceSource> {
  const found = new Map<"structured-telephone" | "structured-email", EvidenceSource>();
  const read = (node: StructuredNode, source: EvidenceSource): void => {
    if (isFilled(node["telephone"]) && !found.has("structured-telephone")) found.set("structured-telephone", source);
    if (isFilled(node["email"]) && !found.has("structured-email")) found.set("structured-email", source);
  };
  for (const { source, node } of org.candidates) {
    read(node, source);
    // contactPoint written inline or as an `@id` reference to a node elsewhere on the page.
    for (const raw of asList(node["contactPoint"])) {
      const cp = resolve(raw);
      if (cp && typeof cp === "object" && !isDanglingRef(cp)) read(cp as StructuredNode, source);
    }
  }
  // A ContactPoint node that sits on its own in the graph.
  for (const node of org.allNodes) {
    if (!hasType(node, "ContactPoint")) continue;
    const source: EvidenceSource = org.candidates.find((c) => c.node === node)?.source ?? "json-ld";
    read(node, source);
  }
  return found;
}

/** Usable visible links: a `mailto:` with an address, a `tel:` with digits. */
function linkChannels(ctx: RuleContext): { mailto: boolean; tel: boolean } {
  let mailto = false;
  let tel = false;
  const doc = ctx.parsed.document;
  const links = ctx.parsed.contactLinks;
  if (links) {
    for (const l of links) {
      if (l.scheme === "mailto" && /\S+@\S+/.test(l.value)) mailto = true;
      if (l.scheme === "tel" && /\d{3,}/.test(l.value.replace(/\D/g, ""))) tel = true;
    }
  } else if (doc) {
    for (const a of Array.from(doc.querySelectorAll('a[href^="mailto:" i], a[href^="tel:" i]'))) {
      const href = (a.getAttribute("href") ?? "").trim();
      if (/^mailto:\s*\S+@\S+/i.test(href)) mailto = true;
      if (/^tel:/i.test(href) && /\d{3,}/.test(href.replace(/\D/g, ""))) tel = true;
    }
  }
  return { mailto, tel };
}

/** A contact form: a form with a message box, or one that names itself a contact form; not search or login. */
function hasContactForm(doc: Document): boolean {
  const forms = Array.from(doc.querySelectorAll("form")).slice(0, MAX_FORMS);
  return forms.some((form) => {
    if (form.getAttribute("role") === "search") return false;
    if (form.querySelector('input[type="search" i], input[type="password" i]')) return false;
    if (form.querySelector("textarea")) return true;
    const label = [form.getAttribute("action"), form.id, form.getAttribute("class"), form.getAttribute("name"), form.getAttribute("aria-label")]
      .filter(Boolean)
      .join(" ");
    return /contact/i.test(label);
  });
}

/**
 * Evidence for the page's contact channels, or null when there is no sign the
 * page is about an organization, a shop or contact at all (nothing to report).
 */
export function readContactEvidence(ctx: RuleContext, org: Org, shop: boolean): ContactEvidence | null {
  const doc = ctx.parsed.document;
  if (!doc) return null;
  const structured = structuredChannels(org, org.resolve);
  const { mailto, tel } = linkChannels(ctx);
  const form = hasContactForm(doc);
  const anySeen = structured.size > 0 || mailto || tel || form;
  if (org.candidates.length === 0 && !shop && !anySeen) return null;

  const seen: Record<ContactChannel, EvidenceSource | "html" | undefined> = {
    "structured-telephone": structured.get("structured-telephone"),
    "structured-email": structured.get("structured-email"),
    "mailto-link": mailto ? "html" : undefined,
    "tel-link": tel ? "html" : undefined,
    "contact-form": form ? "html" : undefined,
  };
  const channels: ChannelEvidence[] = CONTACT_CHANNELS.map((channel) => {
    const source = seen[channel];
    if (source) return { channel, status: "present" as const, source };
    if (org.read !== "complete") return { channel, status: "unknown" as const, reason: "incomplete-read" as const };
    return { channel, status: "absent" as const };
  });
  const formOnly = form && !structured.size && !mailto && !tel;
  return { read: org.read, channels, formOnly };
}

function describe(c: ChannelEvidence): string {
  if (c.status === "present") return `present (${c.source})`;
  if (c.status === "absent") return "absent";
  return `unknown (${c.reason})`;
}

export function contactChannelsCheck(e: ContactEvidence): CheckResult {
  const present = e.channels.filter((c) => c.status === "present").map((c) => c.channel);
  const unknown = e.channels.some((c) => c.status === "unknown");
  let message: string;
  if (e.formOnly) message = "Contact channels observed on this page: contact form only";
  else if (present.length > 0) message = `Contact channels observed on this page: ${present.join(", ")}`;
  else if (unknown) message = "Contact channels on this page: unknown (incomplete read)";
  else message = "Contact channels observed on this page: none";
  return {
    name: "organization-contact-channels",
    status: "info",
    message,
    value: "Informational: observed channels only, no requirement to publish contact details",
    items: e.channels.map((c) => ({ id: c.channel, label: describe(c) })),
    details: {
      read: e.read,
      formOnly: e.formOnly,
      channels: Object.fromEntries(e.channels.map((c) => [c.channel, { status: c.status, source: c.source, reason: c.reason }])),
    },
  };
}
