// Support ticket tools (#1090) on the local server: file a ticket, check on
// it, read the thread, reply. They need a logged-in session (org API keys are
// not accepted by the support routes yet), and share one client with
// `squirrel support`.

import type { McpServer } from "@modelcontextprotocol/server";

import { z } from "zod";

import {
  BODY_MAX_LENGTH,
  BODY_MIN_LENGTH,
  ID_MAX_LENGTH,
  REPLY_MAX_LENGTH,
  SUBJECT_MAX_LENGTH,
  SUBJECT_MIN_LENGTH,
  TICKET_STATUSES,
  TICKET_TYPES,
  createSupportTicket,
  listSupportTickets,
  prepareNewTicket,
  renderThreadMarkdown,
  replyToSupportTicket,
  ticketWaitingOn,
  validateReply,
  viewSupportTicket,
} from "@/lib/support";
import { clearSupportNudge } from "@/lib/support-nudge";
import { loadUserSettings } from "@/self/settings";

import {
  apiResultToTool,
  type LoginResolver,
  requireLoginError,
} from "../cloud";
import { errorResult, jsonResult } from "../result";
import { authNote, TOOL_AUTH } from "../scopes";

const NOT_FOUND = "No support ticket with that ref or id.";

const refSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe(
    "The ticket ref (the 5-character code, any case) or its id, as returned by create_support_ticket or list_support_tickets."
  );

const optionalId = (what: string) =>
  z.string().trim().min(1).max(ID_MAX_LENGTH).optional().describe(what);

export function registerSupportTools(
  server: McpServer,
  resolveLogin?: LoginResolver
): void {
  server.registerTool(
    "create_support_ticket",
    {
      title: "Open a support ticket",
      description:
        "Open a support ticket with the squirrelscan team. Use it when squirrelscan itself fails in a way you cannot resolve after one retry (a crash, a wrong or missing rule result, a billing problem), or when the user asks you to contact support. Say what you ran, what you expected and what happened, and pass run_id, rule_id or report_id when you have them; the CLI version and platform are attached for you. Check on it later with list_support_tickets and get_support_ticket. Limits: 5 tickets per user per hour. For a quick note that needs no answer, use send_feedback instead." +
        authNote(TOOL_AUTH.create_support_ticket),
      inputSchema: z.object({
        type: z
          .enum(TICKET_TYPES)
          .describe(
            "billing, bug (a defect in squirrelscan), audit_question (how to read or fix a result), feature_request, or other."
          ),
        subject: z
          .string()
          .describe(
            `A short summary, ${SUBJECT_MIN_LENGTH} to ${SUBJECT_MAX_LENGTH} characters (cut at ${SUBJECT_MAX_LENGTH}).`
          ),
        body: z
          .string()
          .describe(
            `What happened, ${BODY_MIN_LENGTH} to ${BODY_MAX_LENGTH} characters (cut at ${BODY_MAX_LENGTH}). Plain text or markdown.`
          ),
        run_id: optionalId("Audit run id this ticket relates to, if any."),
        rule_id: optionalId("Rule id this ticket relates to, if any."),
        report_id: optionalId("Report id this ticket relates to, if any."),
      }),
    },
    async ({ type, subject, body, run_id, rule_id, report_id }) => {
      const denied = requireLoginError(resolveLogin);
      if (denied) return denied;
      const prepared = prepareNewTicket({
        type,
        subject,
        body,
        source: "mcp",
        runId: run_id,
        ruleId: rule_id,
        reportId: report_id,
      });
      if (!prepared.ok) return errorResult(prepared.error);
      const result = await createSupportTicket(prepared);
      if (!result.ok || !result.data) return apiResultToTool(result);
      return jsonResult({
        ref: result.data.ref,
        id: result.data.id,
        truncated: prepared.truncated,
        message: `Ticket ${result.data.ref} opened. Tell the user the ref; check it later with get_support_ticket.`,
      });
    }
  );

  server.registerTool(
    "list_support_tickets",
    {
      title: "List support tickets",
      description:
        'List the signed-in user\'s support tickets, newest activity first. Each entry has a waiting_on field: "you" means support replied (or a reply is unseen) and the user or agent should read it with get_support_ticket and relay the answer; "support" means the team has not answered yet; "closed" means it is done. Call it at the start of a later session to see whether an earlier ticket was answered.' +
        authNote(TOOL_AUTH.list_support_tickets),
      inputSchema: z.object({
        status: z
          .enum(TICKET_STATUSES)
          .optional()
          .describe("Only tickets in this status."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("How many to return (default 20)."),
      }),
    },
    async ({ status, limit }) => {
      const denied = requireLoginError(resolveLogin);
      if (denied) return denied;
      const result = await listSupportTickets({ status, limit: limit ?? 20 });
      if (!result.ok || !result.data) return apiResultToTool(result);
      return jsonResult({
        total: result.data.total,
        tickets: result.data.data.map((ticket) => ({
          ...ticket,
          waiting_on: ticketWaitingOn(ticket),
        })),
      });
    }
  );

  server.registerTool(
    "get_support_ticket",
    {
      title: "Read a support ticket",
      description:
        "Read one support ticket's whole thread by ref or id, as markdown, with its status and waiting_on. Reading it marks it as read. When support has replied, relay the answer to the user in your own words and, if they need to follow up, use reply_to_support_ticket." +
        authNote(TOOL_AUTH.get_support_ticket),
      inputSchema: z.object({ ref: refSchema }),
    },
    async ({ ref }) => {
      const denied = requireLoginError(resolveLogin);
      if (denied) return denied;
      const result = await viewSupportTicket(ref);
      if (!result.ok || !result.data) {
        return apiResultToTool(result, NOT_FOUND);
      }
      const thread = result.data;
      const settings = loadUserSettings();
      if (settings.ok) clearSupportNudge(settings.data, thread.ticket.ref);
      return jsonResult({
        ref: thread.ticket.ref,
        id: thread.ticket.id,
        status: thread.ticket.status,
        waiting_on: ticketWaitingOn(thread.ticket, thread.messages),
        thread: renderThreadMarkdown(thread),
      });
    }
  );

  server.registerTool(
    "reply_to_support_ticket",
    {
      title: "Reply to a support ticket",
      description:
        "Add a message to an existing support ticket by ref or id. Use it to answer a question support asked or to add detail. A closed ticket is reopened by a reply." +
        authNote(TOOL_AUTH.reply_to_support_ticket),
      inputSchema: z.object({
        ref: refSchema,
        body: z
          .string()
          .describe(
            `Your message, 1 to ${REPLY_MAX_LENGTH} characters (cut at ${REPLY_MAX_LENGTH}).`
          ),
      }),
    },
    async ({ ref, body }) => {
      const denied = requireLoginError(resolveLogin);
      if (denied) return denied;
      const reply = validateReply(body);
      if (!reply.ok)
        return errorResult(reply.error ?? "A reply cannot be empty.");
      const result = await replyToSupportTicket(ref, reply.text);
      if (!result.ok || !result.data) {
        return apiResultToTool(result, NOT_FOUND);
      }
      return jsonResult({
        id: result.data.id,
        truncated: reply.truncated,
        message: "Reply sent.",
      });
    }
  );
}
