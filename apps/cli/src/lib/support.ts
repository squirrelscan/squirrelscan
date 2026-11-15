// Support tickets (#1090): the one client shared by `squirrel support` and the
// local MCP server's support tools, so both send the same payload to the same
// routes. The API owns validation and rate limits; this module clamps what it
// can so an agent's long message is cut, never bounced.

import { API_KEY_BASE_PREFIX } from "@squirrelscan/core-contracts/api-keys";

import type { ApiResult } from "@/lib/api-client";

import { cliApi } from "@/lib/api-client";

import { version } from "../../package.json";

export const TICKET_TYPES = [
  "billing",
  "bug",
  "audit_question",
  "feature_request",
  "other",
] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export const TICKET_TYPE_LABELS: Record<TicketType, string> = {
  billing: "Billing",
  bug: "Bug",
  audit_question: "Audit question",
  feature_request: "Feature request",
  other: "Other",
};

export const TICKET_STATUSES = ["new", "in_progress", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const SUBJECT_MIN_LENGTH = 3;
export const SUBJECT_MAX_LENGTH = 200;
export const BODY_MIN_LENGTH = 10;
export const BODY_MAX_LENGTH = 10000;
export const REPLY_MIN_LENGTH = 1;
export const REPLY_MAX_LENGTH = 10000;
/** Diagnostics ride in metadata, never the prose body; this keeps them small. */
export const DOCTOR_MAX_LENGTH = 4000;
/** Real run, rule and report ids are short; this only keeps junk out of metadata. */
export const ID_MAX_LENGTH = 128;
export const LIST_PAGE_SIZE = 100;
/** Ref lookups stop after this many pages (5,000 tickets) rather than loop forever. */
const MAX_REF_PAGES = 50;

export type SupportSource = "cli" | "mcp";

export function isTicketType(value: string): value is TicketType {
  return (TICKET_TYPES as readonly string[]).includes(value);
}

export function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value);
}

/** Trim, then cut to `max` without splitting a surrogate pair. */
export function clampText(
  raw: string,
  max: number
): { text: string; truncated: boolean } {
  const text = raw.trim();
  if (text.length <= max) return { text, truncated: false };
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { text: cut.trimEnd(), truncated: true };
}

export interface TicketMetadata {
  source: SupportSource;
  cliVersion: string;
  platform: string;
  runId?: string;
  ruleId?: string;
  reportId?: string;
  doctor?: string;
}

export interface TicketMetadataInput {
  source: SupportSource;
  runId?: string;
  ruleId?: string;
  reportId?: string;
  doctor?: string;
}

/** Structured context for the ticket, so staff never have to dig it out of prose. */
export function buildTicketMetadata(
  input: TicketMetadataInput
): TicketMetadata {
  const metadata: TicketMetadata = {
    source: input.source,
    cliVersion: version,
    platform: `${process.platform}-${process.arch}`,
  };
  for (const key of ["runId", "ruleId", "reportId"] as const) {
    const value = input[key]?.trim();
    if (value) metadata[key] = value.slice(0, ID_MAX_LENGTH);
  }
  if (input.doctor?.trim()) {
    metadata.doctor = clampText(input.doctor, DOCTOR_MAX_LENGTH).text;
  }
  return metadata;
}

export interface NewTicketInput {
  type: string;
  subject: string;
  body: string;
  source: SupportSource;
  runId?: string;
  ruleId?: string;
  reportId?: string;
  doctor?: string;
}

export interface PreparedTicket {
  payload: {
    type: TicketType;
    subject: string;
    message: string;
    source: SupportSource;
    metadata: TicketMetadata;
  };
  truncated: { subject: boolean; body: boolean };
}

export type Prepared =
  | ({ ok: true } & PreparedTicket)
  | { ok: false; code: SupportErrorCode; error: string };

export type SupportErrorCode =
  | "invalid_type"
  | "subject_required"
  | "subject_too_short"
  | "message_required"
  | "message_too_short"
  | "not_found";

/** Validate and clamp a new ticket. Pure: nothing is sent. */
export function prepareNewTicket(input: NewTicketInput): Prepared {
  const type = input.type.trim();
  if (!isTicketType(type)) {
    return {
      ok: false,
      code: "invalid_type",
      error: `Unknown ticket type "${input.type}". Use one of: ${TICKET_TYPES.join(", ")}.`,
    };
  }
  const subject = clampText(input.subject, SUBJECT_MAX_LENGTH);
  if (!subject.text) {
    return {
      ok: false,
      code: "subject_required",
      error: "A subject is required.",
    };
  }
  if (subject.text.length < SUBJECT_MIN_LENGTH) {
    return {
      ok: false,
      code: "subject_too_short",
      error: `The subject must be at least ${SUBJECT_MIN_LENGTH} characters.`,
    };
  }
  const body = clampText(input.body, BODY_MAX_LENGTH);
  if (!body.text) {
    return {
      ok: false,
      code: "message_required",
      error: "A message is required.",
    };
  }
  if (body.text.length < BODY_MIN_LENGTH) {
    return {
      ok: false,
      code: "message_too_short",
      error: `The message must be at least ${BODY_MIN_LENGTH} characters.`,
    };
  }
  return {
    ok: true,
    payload: {
      type,
      subject: subject.text,
      message: body.text,
      source: input.source,
      metadata: buildTicketMetadata(input),
    },
    truncated: { subject: subject.truncated, body: body.truncated },
  };
}

// ── API shapes ────────────────────────────────────────────────────────────────

export interface SupportTicketSummary {
  id: string;
  ref: string;
  type: string;
  subject: string;
  status: string;
  isUserRead: boolean;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface SupportTicket {
  id: string;
  ref: string;
  type?: string;
  subject: string;
  status: string;
  isUserRead: boolean;
  createdAt: string;
  name?: string;
  email?: string;
}

export interface SupportMessage {
  id: string;
  role: string;
  authorName: string | null;
  body: string;
  createdAt: string;
}

export interface SupportThread {
  ticket: SupportTicket;
  messages: SupportMessage[];
}

export interface SupportTicketList {
  data: SupportTicketSummary[];
  total: number;
}

type Api = Pick<typeof cliApi, "request">;

// ── Client ────────────────────────────────────────────────────────────────────

export function createSupportTicket(
  prepared: PreparedTicket,
  api: Api = cliApi
): Promise<ApiResult<{ id: string; ref: string }>> {
  return api.request("/v1/support/tickets", {
    method: "POST",
    auth: "required",
    body: prepared.payload,
  });
}

export function listSupportTickets(
  options: {
    status?: TicketStatus;
    limit?: number;
    offset?: number;
    timeoutMs?: number;
  } = {},
  api: Api = cliApi
): Promise<ApiResult<SupportTicketList>> {
  const params = new URLSearchParams();
  if (options.status) params.set("status", options.status);
  params.set("limit", String(options.limit ?? LIST_PAGE_SIZE));
  if (options.offset) params.set("offset", String(options.offset));
  return api.request(`/v1/support/tickets?${params}`, {
    auth: "required",
    timeoutMs: options.timeoutMs,
  });
}

export function supportUnreadCount(
  options: { timeoutMs?: number } = {},
  api: Api = cliApi
): Promise<ApiResult<{ count: number }>> {
  return api.request("/v1/support/unread-count", {
    auth: "required",
    timeoutMs: options.timeoutMs,
  });
}

const ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_PATTERN = /^[a-z0-9]{5}$/i;

export function isTicketId(value: string): boolean {
  return ID_PATTERN.test(value.trim());
}

export function isTicketRef(value: string): boolean {
  return REF_PATTERN.test(value.trim());
}

/**
 * A ref (5 characters, any case) or an id, resolved to the ticket id. A ref is
 * found by paging the caller's own tickets; unknown input is a 404.
 */
export async function resolveTicketId(
  refOrId: string,
  api: Api = cliApi
): Promise<ApiResult<{ id: string; ref: string | null }>> {
  const input = refOrId.trim();
  if (isTicketId(input)) {
    return { ok: true, status: 200, data: { id: input, ref: null } };
  }
  if (!isTicketRef(input)) return { ok: false, status: 404, data: null };
  const wanted = input.toUpperCase();
  let offset = 0;
  for (let page = 0; page < MAX_REF_PAGES; page++) {
    const result = await listSupportTickets(
      { limit: LIST_PAGE_SIZE, offset },
      api
    );
    if (!result.ok || !result.data) {
      return { ok: false, status: result.status, data: result.data as null };
    }
    const hit = result.data.data.find((t) => t.ref.toUpperCase() === wanted);
    if (hit) {
      return { ok: true, status: 200, data: { id: hit.id, ref: hit.ref } };
    }
    offset += result.data.data.length;
    if (result.data.data.length === 0 || offset >= result.data.total) break;
  }
  return { ok: false, status: 404, data: null };
}

/** The thread for a ref or an id. Does not mark it read; see viewSupportTicket. */
export async function getSupportThread(
  refOrId: string,
  api: Api = cliApi
): Promise<ApiResult<SupportThread>> {
  const resolved = await resolveTicketId(refOrId, api);
  if (!resolved.ok || !resolved.data) {
    return { ok: false, status: resolved.status, data: resolved.data as null };
  }
  return api.request(
    `/v1/support/tickets/${encodeURIComponent(resolved.data.id)}`,
    { auth: "required" }
  );
}

export function markSupportTicketRead(
  id: string,
  api: Api = cliApi
): Promise<ApiResult<unknown>> {
  return api.request(`/v1/support/tickets/${encodeURIComponent(id)}/read`, {
    method: "POST",
    auth: "required",
  });
}

/** Fetch a thread, then mark it read. A failed mark never fails the view. */
export async function viewSupportTicket(
  refOrId: string,
  api: Api = cliApi
): Promise<ApiResult<SupportThread>> {
  const result = await getSupportThread(refOrId, api);
  if (result.ok && result.data) {
    await markSupportTicketRead(result.data.ticket.id, api).catch(() => {});
  }
  return result;
}

export function validateReply(raw: string): {
  ok: boolean;
  text: string;
  truncated: boolean;
  error?: string;
} {
  const { text, truncated } = clampText(raw, REPLY_MAX_LENGTH);
  if (text.length < REPLY_MIN_LENGTH) {
    return { ok: false, text, truncated, error: "A reply cannot be empty." };
  }
  return { ok: true, text, truncated };
}

export async function replyToSupportTicket(
  refOrId: string,
  text: string,
  api: Api = cliApi
): Promise<ApiResult<{ id: string }>> {
  const resolved = await resolveTicketId(refOrId, api);
  if (!resolved.ok || !resolved.data) {
    return { ok: false, status: resolved.status, data: resolved.data as null };
  }
  return api.request(
    `/v1/support/tickets/${encodeURIComponent(resolved.data.id)}/messages`,
    { method: "POST", auth: "required", body: { message: text } }
  );
}

// ── Status helpers ────────────────────────────────────────────────────────────

export type WaitingOn = "you" | "support" | "closed";

/**
 * Whose move it is. "you" when staff replied last or a reply is unseen,
 * "support" when the user spoke last, "closed" for a closed ticket with
 * nothing unseen. A list row has no messages, so only its read flag counts.
 */
export function ticketWaitingOn(
  ticket: { status: string; isUserRead?: boolean },
  messages?: ReadonlyArray<{ role: string }>
): WaitingOn {
  if (ticket.isUserRead === false) return "you";
  if (ticket.status === "closed") return "closed";
  const last = messages?.at(-1);
  if (last && last.role !== "user") return "you";
  return "support";
}

export const WAITING_LABELS: Record<WaitingOn, string> = {
  you: "waiting on you",
  support: "waiting on support",
  closed: "closed",
};

export function describeWaitingOn(waiting: WaitingOn): string {
  return WAITING_LABELS[waiting];
}

/** A thread as markdown, for an agent or `view --markdown`. */
export function renderThreadMarkdown(thread: SupportThread): string {
  const { ticket, messages } = thread;
  const waiting = ticketWaitingOn(ticket, messages);
  const lines = [
    `# [${ticket.ref}] ${ticket.subject}`,
    "",
    `- Status: ${ticket.status} (${WAITING_LABELS[waiting]})`,
    ...(ticket.type ? [`- Type: ${ticket.type}`] : []),
    `- Opened: ${ticket.createdAt}`,
    "",
  ];
  for (const message of messages) {
    const who =
      message.role === "user"
        ? "You"
        : `${message.authorName || "squirrelscan support"} (support)`;
    lines.push(`## ${who}, ${message.createdAt}`, "", message.body.trim(), "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

// ── Failures ──────────────────────────────────────────────────────────────────

function apiErrorText(data: unknown): string | null {
  if (typeof data === "string") return data.slice(0, 300) || null;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const error = record.error;
    if (typeof error === "string" && error) return error.slice(0, 300);
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message) return message.slice(0, 300);
    }
    if (typeof record.message === "string" && record.message) {
      return record.message.slice(0, 300);
    }
  }
  return null;
}

/** One honest sentence for a failed support call, for the CLI. */
export function describeSupportFailure(
  result: ApiResult<unknown>,
  notFound = "No ticket with that ref or id."
): string {
  switch (result.status) {
    case 0:
      return "Couldn't reach the squirrelscan API. Check your connection and try again.";
    case 401:
      return "Your login was rejected or has expired. Run `squirrel auth login`.";
    case 403:
      return (
        apiErrorText(result.data) ??
        "Support tickets need a logged-in session: org API keys are not accepted yet. Run `squirrel auth login`."
      );
    case 404:
      return notFound;
    case 429:
      return "Too many tickets filed recently (the limit is 5 an hour). Try again later.";
    default:
      return (
        apiErrorText(result.data) ?? `Request failed (HTTP ${result.status}).`
      );
  }
}

/** True for an org API key (`sq_...`), which the support routes do not accept yet. */
export function isOrgApiKey(token: string): boolean {
  return token.startsWith(API_KEY_BASE_PREFIX) && !token.startsWith("sqcli_");
}
