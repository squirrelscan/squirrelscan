// squirrel support - threaded support tickets (#1090)
//
// `squirrel feedback` is one-shot and unauthenticated; this is a conversation
// with the team, tied to your account. It needs a login (`squirrel auth
// login`). Every subcommand takes --json: one JSON object on stdout, never a
// prompt, and every failure exits 1.

import { defineCommand } from "citty";

import type { ApiResult } from "@/lib/api-client";

import { promptForInput } from "@/cli/prompt";
import { readStdinText, stdinIsTTY } from "@/cli/stdin";
import { createTheme } from "@/cli/theme";
import {
  BODY_MAX_LENGTH,
  BODY_MIN_LENGTH,
  type SupportThread,
  SUBJECT_MAX_LENGTH,
  SUBJECT_MIN_LENGTH,
  type TicketStatus,
  TICKET_STATUSES,
  TICKET_TYPE_LABELS,
  TICKET_TYPES,
  createSupportTicket,
  describeSupportFailure,
  describeWaitingOn,
  isTicketStatus,
  isTicketType,
  listSupportTickets,
  prepareNewTicket,
  renderThreadMarkdown,
  replyToSupportTicket,
  ticketWaitingOn,
  validateReply,
  viewSupportTicket,
} from "@/lib/support";
import { clearSupportNudge } from "@/lib/support-nudge";
import { resolveCredential, warnIfSessionUnreadable } from "@/self/credentials";
import { collectDoctorText } from "@/self/doctor-report";
import { loadUserSettings } from "@/self/settings";
import { safeExit } from "@/self/updater";

const STDIN_MAX_BYTES = 64 * 1024;
const STDIN_IDLE_MS = 5000;

const NOT_LOGGED_IN =
  "Not logged in. Run `squirrel auth login` to file and follow support tickets.";

interface Failure {
  ok: false;
  code: string;
  error: string;
  status?: number;
}

function fail(code: string, error: string, status?: number): Failure {
  return {
    ok: false,
    code,
    error,
    ...(status === undefined ? {} : { status }),
  };
}

function apiFailure(result: ApiResult<unknown>, notFound?: string): Failure {
  const code =
    result.status === 0
      ? "unreachable"
      : result.status === 404
        ? "not_found"
        : result.status === 429
          ? "rate_limited"
          : result.status === 401 || result.status === 403
            ? "forbidden"
            : "request_failed";
  return fail(code, describeSupportFailure(result, notFound), result.status);
}

/** stderr without console.error: Bun tints console.error output red when colour is forced. */
function writeErr(text: string): void {
  process.stderr.write(`${text}\n`);
}

function lastValue(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw.at(-1) : raw;
  return value === undefined ? undefined : String(value);
}

/** Repeated -m flags are paragraphs, as in `git commit`. */
function readMessageFlag(args: Record<string, unknown>): string | undefined {
  const messages =
    args.message === undefined ? [] : [args.message].flat().map(String);
  return messages.length > 0 ? messages.join("\n\n") : undefined;
}

function reportFailure(failure: Failure, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(failure));
    return;
  }
  const e = createTheme(process.stderr);
  writeErr(`${e.error(e.sym.error)} ${failure.error}`);
}

/** Exit 1 with the failure printed. */
function bail(failure: Failure, json: boolean): Promise<never> {
  reportFailure(failure, json);
  return safeExit(1);
}

/** The login gate shared by every subcommand. */
async function requireLogin(json: boolean): Promise<void> {
  warnIfSessionUnreadable();
  if (resolveCredential()) return;
  await bail(fail("not_logged_in", NOT_LOGGED_IN), json);
}

/** Message text from a flag or a pipe; null on a terminal with neither. */
async function messageFromFlagOrPipe(
  flag: string | undefined
): Promise<{ text: string; timedOut: boolean } | null> {
  if (flag !== undefined) return { text: flag, timedOut: false };
  if (stdinIsTTY()) return null;
  return readStdinText({ maxBytes: STDIN_MAX_BYTES, idleMs: STDIN_IDLE_MS });
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "-";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

// ── new ───────────────────────────────────────────────────────────────────────

async function promptType(): Promise<string> {
  console.log("\nWhat is this about?");
  for (const [i, type] of TICKET_TYPES.entries()) {
    console.log(`  ${i + 1}) ${TICKET_TYPE_LABELS[type]}`);
  }
  while (true) {
    const input = await promptForInput("Type [1-5]: ");
    const index = Number(input);
    if (Number.isInteger(index) && index >= 1 && index <= TICKET_TYPES.length) {
      return TICKET_TYPES[index - 1]!;
    }
    if (isTicketType(input)) return input;
    console.log(`Enter a number 1-${TICKET_TYPES.length}.`);
  }
}

async function promptMinLength(
  question: string,
  min: number,
  label: string
): Promise<string> {
  while (true) {
    const input = await promptForInput(question);
    if (input.length >= min) return input;
    console.log(`${label} must be at least ${min} characters.`);
  }
}

const supportNew = defineCommand({
  meta: {
    name: "new",
    description: "Open a support ticket with the squirrelscan team",
  },
  args: {
    type: {
      type: "string",
      valueHint: "type",
      description: `Ticket type (${TICKET_TYPES.join(", ")})`,
    },
    subject: {
      type: "string",
      alias: "s",
      valueHint: "text",
      description: `Short summary, ${SUBJECT_MIN_LENGTH} to ${SUBJECT_MAX_LENGTH} characters`,
    },
    message: {
      type: "string",
      alias: "m",
      valueHint: "text",
      description: `What happened, ${BODY_MIN_LENGTH} to ${BODY_MAX_LENGTH} characters (or pipe it on stdin)`,
    },
    "run-id": {
      type: "string",
      valueHint: "id",
      description: "Audit run the ticket is about",
    },
    "rule-id": {
      type: "string",
      valueHint: "id",
      description: "Rule the ticket is about",
    },
    "report-id": {
      type: "string",
      valueHint: "id",
      description: "Report the ticket is about",
    },
    "attach-doctor": {
      type: "boolean",
      description:
        "Attach `squirrel self doctor` output as diagnostics (asked first when interactive)",
    },
    json: {
      type: "boolean",
      description: "Print the result as JSON (never prompts)",
    },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await requireLogin(json);

    let type = lastValue(args.type);
    let subject = lastValue(args.subject);
    let message = readMessageFlag(args);
    let attachDoctor = Boolean(args["attach-doctor"]);

    const interactive =
      !json && stdinIsTTY() && (!subject || message === undefined || !type);

    try {
      if (interactive) {
        if (!type) type = await promptType();
        if (!subject) {
          subject = await promptMinLength(
            "Subject: ",
            SUBJECT_MIN_LENGTH,
            "The subject"
          );
        }
        if (message === undefined) {
          message = await promptMinLength(
            "Message: ",
            BODY_MIN_LENGTH,
            "The message"
          );
        }
        if (!attachDoctor) {
          const answer = await promptForInput(
            "Attach `squirrel self doctor` output? [y/N] "
          );
          attachDoctor = /^y(es)?$/i.test(answer);
        }
      } else if (message === undefined) {
        const piped = await messageFromFlagOrPipe(undefined);
        if (piped) {
          if (!piped.text.trim()) {
            return bail(
              fail(
                "message_required",
                piped.timedOut
                  ? `Nothing arrived on stdin for ${STDIN_IDLE_MS / 1000} seconds. Pass --message "..." or pipe the text.`
                  : 'No message. Pass --message "..." or pipe the text on stdin.'
              ),
              json
            );
          }
          message = piped.text;
        }
      }

      if (!type) {
        return bail(
          fail(
            "invalid_type",
            `Pass --type with one of: ${TICKET_TYPES.join(", ")}.`
          ),
          json
        );
      }
      if (!subject) {
        return bail(
          fail(
            "subject_required",
            'A subject is required. Pass --subject "...".'
          ),
          json
        );
      }

      const doctor = attachDoctor ? await collectDoctorText() : null;
      if (attachDoctor && doctor === null && !json) {
        const e = createTheme(process.stderr);
        writeErr(
          `${e.warn(e.sym.warn)} Couldn't run doctor; sending without it.`
        );
      }

      const prepared = prepareNewTicket({
        type,
        subject,
        body: message ?? "",
        source: "cli",
        runId: lastValue(args["run-id"]),
        ruleId: lastValue(args["rule-id"]),
        reportId: lastValue(args["report-id"]),
        doctor: doctor ?? undefined,
      });
      if (!prepared.ok) {
        return bail(fail(prepared.code, prepared.error), json);
      }

      const result = await createSupportTicket(prepared);
      if (!result.ok || !result.data) return bail(apiFailure(result), json);

      const { ref, id } = result.data;
      if (json) {
        console.log(
          JSON.stringify({
            ok: true,
            id,
            ref,
            truncated: prepared.truncated,
            doctor_attached: doctor !== null,
          })
        );
        return;
      }
      if (prepared.truncated.subject || prepared.truncated.body) {
        const e = createTheme(process.stderr);
        const cut = [
          prepared.truncated.subject ? `subject (${SUBJECT_MAX_LENGTH})` : "",
          prepared.truncated.body ? `message (${BODY_MAX_LENGTH})` : "",
        ]
          .filter(Boolean)
          .join(" and ");
        writeErr(`${e.warn(e.sym.warn)} Your ${cut} was cut to fit.`);
      }
      const t = createTheme(process.stdout);
      console.log(`${t.ok(t.sym.ok)} Ticket ${t.bold(ref)} opened.`);
      console.log(
        `  Follow it with: ${t.command(`squirrel support view ${ref}`)}`
      );
    } catch (error) {
      return bail(
        fail(
          "unexpected",
          `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
        ),
        json
      );
    }
  },
});

// ── list ──────────────────────────────────────────────────────────────────────

const supportList = defineCommand({
  meta: { name: "list", description: "List your support tickets" },
  args: {
    status: {
      type: "string",
      valueHint: "status",
      description: `Only tickets in this status (${TICKET_STATUSES.join(", ")})`,
    },
    limit: {
      type: "string",
      valueHint: "n",
      description: "How many tickets to show, 1 to 100 (default 20)",
    },
    json: { type: "boolean", description: "Output as JSON" },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await requireLogin(json);

    const rawStatus = lastValue(args.status);
    let status: TicketStatus | undefined;
    if (rawStatus !== undefined) {
      if (!isTicketStatus(rawStatus)) {
        return bail(
          fail(
            "invalid_status",
            `Unknown status "${rawStatus}". Use one of: ${TICKET_STATUSES.join(", ")}.`
          ),
          json
        );
      }
      status = rawStatus;
    }
    const rawLimit = lastValue(args.limit);
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return bail(
        fail("invalid_limit", "--limit must be a whole number from 1 to 100."),
        json
      );
    }

    const result = await listSupportTickets({ status, limit });
    if (!result.ok || !result.data) return bail(apiFailure(result), json);

    const rows = result.data.data.map((ticket) => ({
      ...ticket,
      waitingOn: ticketWaitingOn(ticket),
    }));
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          total: result.data.total,
          tickets: rows,
        })
      );
      return;
    }
    const t = createTheme(process.stdout);
    if (rows.length === 0) {
      console.log(
        status
          ? `No ${status} tickets.`
          : `No tickets yet. Open one with ${t.command("squirrel support new")}.`
      );
      return;
    }
    const waitingCol = Math.max(
      ...rows.map((r) => describeWaitingOn(r.waitingOn).length)
    );
    for (const row of rows) {
      const waiting = describeWaitingOn(row.waitingOn).padEnd(waitingCol);
      console.log(
        `${t.bold(row.ref)}  ${row.status.padEnd(11)}  ${
          row.waitingOn === "you" ? t.warn(waiting) : t.dim(waiting)
        }  ${truncate(row.subject, 48).padEnd(48)}  ${t.dim(formatWhen(row.lastMessageAt ?? row.createdAt))}`
      );
    }
    if (result.data.total > rows.length) {
      console.log(
        t.dim(`\nShowing ${rows.length} of ${result.data.total}. Use --limit.`)
      );
    }
  },
});

// ── view ──────────────────────────────────────────────────────────────────────

function printThread(thread: SupportThread): void {
  const t = createTheme(process.stdout);
  const { ticket, messages } = thread;
  const waiting = ticketWaitingOn(ticket, messages);
  console.log(`${t.bold(`[${ticket.ref}] ${ticket.subject}`)}`);
  console.log(
    t.dim(
      `${ticket.status}, ${describeWaitingOn(waiting)}, opened ${formatWhen(ticket.createdAt)}`
    )
  );
  for (const message of messages) {
    const who =
      message.role === "user"
        ? "You"
        : `${message.authorName || "squirrelscan support"} (support)`;
    console.log(`\n${t.accent(who)} ${t.dim(formatWhen(message.createdAt))}`);
    console.log(message.body.trim());
  }
  if (waiting === "you") {
    console.log(
      `\n${t.dim(`Reply with: squirrel support reply ${ticket.ref} -m "..."`)}`
    );
  }
}

const supportView = defineCommand({
  meta: {
    name: "view",
    description: "Show a ticket's thread and mark it read",
  },
  args: {
    ref: {
      type: "positional",
      required: true,
      valueHint: "ref",
      description: "Ticket ref (5 characters) or id",
    },
    markdown: { type: "boolean", description: "Print the thread as markdown" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await requireLogin(json);

    const result = await viewSupportTicket(String(args.ref));
    if (!result.ok || !result.data) return bail(apiFailure(result), json);
    const thread = result.data;

    const settings = loadUserSettings();
    if (settings.ok) clearSupportNudge(settings.data, thread.ticket.ref);

    const waiting = ticketWaitingOn(thread.ticket, thread.messages);
    if (json) {
      console.log(JSON.stringify({ ok: true, ...thread, waitingOn: waiting }));
      return;
    }
    if (args.markdown) {
      process.stdout.write(renderThreadMarkdown(thread));
      return;
    }
    printThread(thread);
  },
});

// ── reply ─────────────────────────────────────────────────────────────────────

const supportReply = defineCommand({
  meta: { name: "reply", description: "Add a message to a ticket" },
  args: {
    ref: {
      type: "positional",
      required: true,
      valueHint: "ref",
      description: "Ticket ref (5 characters) or id",
    },
    message: {
      type: "string",
      alias: "m",
      valueHint: "text",
      description: `Your message, up to ${BODY_MAX_LENGTH} characters (or pipe it on stdin)`,
    },
    json: {
      type: "boolean",
      description: "Print the result as JSON (never prompts)",
    },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    await requireLogin(json);

    let raw = readMessageFlag(args);
    if (raw === undefined) {
      const piped = await messageFromFlagOrPipe(undefined);
      if (piped) raw = piped.text;
      else if (json) {
        return bail(
          fail(
            "message_required",
            '--json never prompts. Pass --message "...".'
          ),
          json
        );
      } else {
        raw = await promptForInput("Reply: ");
      }
    }
    const reply = validateReply(raw);
    if (!reply.ok) {
      return bail(
        fail(
          "message_required",
          `${reply.error} Pass --message "..." or pipe the text on stdin.`
        ),
        json
      );
    }

    const result = await replyToSupportTicket(String(args.ref), reply.text);
    if (!result.ok || !result.data) return bail(apiFailure(result), json);

    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          id: result.data.id,
          truncated: reply.truncated,
        })
      );
      return;
    }
    if (reply.truncated) {
      const e = createTheme(process.stderr);
      writeErr(
        `${e.warn(e.sym.warn)} Your reply was cut to ${BODY_MAX_LENGTH} characters.`
      );
    }
    const t = createTheme(process.stdout);
    console.log(`${t.ok(t.sym.ok)} Reply sent.`);
  },
});

export const support = defineCommand({
  meta: {
    name: "support",
    description: "Open and follow support tickets with the squirrelscan team",
  },
  subCommands: {
    new: supportNew,
    list: supportList,
    view: supportView,
    reply: supportReply,
  },
});
