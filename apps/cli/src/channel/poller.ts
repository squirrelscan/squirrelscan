// One poll of the cloud notification feed (#569).
//
// Two feed shapes, one code path each:
//  - cursor feed: every response carries `next_cursor`; `?after=<cursor>`
//    returns rows created after it, oldest first.
//  - legacy feed (no `next_cursor` in the response): newest-first page only, so
//    delivery relies on the bounded seen-set.

import { logger } from "@/utils/logger";

import { type ChannelEvent, type FeedRow, buildEvent } from "./events";
import { type ChannelState, type StateStore, rememberSeen } from "./state";

export const FEED_PAGE_SIZE = 50;
const MAX_PAGES_PER_POLL = 10;

export interface FeedPage {
  rows: FeedRow[];
  // True when the response carried a `next_cursor` key at all.
  cursorSupported: boolean;
  nextCursor: string | null;
}

export type FetchPageResult =
  | { ok: true; page: FeedPage }
  | { ok: false; status: number };

export type FetchPage = (query: {
  after: string | null;
  limit: number;
}) => Promise<FetchPageResult>;

export interface PollDeps {
  fetchPage: FetchPage;
  store: StateStore;
  emit: (event: ChannelEvent) => Promise<void>;
  categories: ReadonlySet<string>;
}

export type PollResult = { ok: true } | { ok: false; status: number };

export function parseFeedPage(body: unknown): FeedPage | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.notifications)) return null;
  const rows: FeedRow[] = [];
  for (const raw of record.notifications) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.category !== "string")
      continue;
    const data =
      row.data && typeof row.data === "object" && !Array.isArray(row.data)
        ? (row.data as Record<string, unknown>)
        : {};
    // Title and body are dropped here on purpose: they can carry crawled text.
    rows.push({ id: row.id, category: row.category, data });
  }
  const cursorSupported = "next_cursor" in record;
  return {
    rows,
    cursorSupported,
    nextCursor:
      typeof record.next_cursor === "string" ? record.next_cursor : null,
  };
}

// The user-scoped and org-scoped twins of one run have different ids, so a run is also keyed by category and run id.
function dedupeKeys(row: FeedRow): string[] {
  const keys = [`id:${row.id}`];
  const runId = row.data.runId;
  if (typeof runId === "string") keys.push(`run:${row.category}:${runId}`);
  return keys;
}

// A row counts as delivered only once its emit resolves, and state is saved per row. If an emit throws, the rest of the page (and the cursor) stay put, so the next poll retries from that row without repeating earlier ones.
async function deliver(
  rows: FeedRow[],
  state: ChannelState,
  deps: PollDeps
): Promise<void> {
  for (const row of rows) {
    const keys = dedupeKeys(row);
    if (keys.some((key) => state.seen.includes(key))) continue;
    const event = deps.categories.has(row.category) ? buildEvent(row) : null;
    // Out-of-scope categories and rows without an event are marked seen so they stay skipped.
    if (event) await deps.emit(event);
    rememberSeen(state, keys);
    deps.store.save(state);
  }
}

export async function pollOnce(deps: PollDeps): Promise<PollResult> {
  const state = deps.store.load();

  if (!state.bootstrapped) {
    const first = await deps.fetchPage({ after: null, limit: FEED_PAGE_SIZE });
    if (!first.ok) return first;
    // First run ever: start from "now". Nothing is delivered; the cursor (or, on a legacy feed, the current page) becomes the baseline.
    if (first.page.cursorSupported) {
      state.cursor = first.page.nextCursor;
      // No cursor handed out yet: stay unbootstrapped and retry next poll. Anything created before the first poll that does return a cursor counts as history.
      state.bootstrapped = state.cursor !== null;
    } else {
      rememberSeen(state, first.page.rows.flatMap(dedupeKeys));
      state.bootstrapped = true;
    }
    deps.store.save(state);
    return { ok: true };
  }

  if (state.cursor !== null) {
    for (let pages = 0; pages < MAX_PAGES_PER_POLL; pages++) {
      const result = await deps.fetchPage({
        after: state.cursor,
        limit: FEED_PAGE_SIZE,
      });
      if (!result.ok) return result;
      if (!result.page.cursorSupported) {
        // The server stopped returning cursors: fall back to the page path below.
        state.cursor = null;
        deps.store.save(state);
        return pollLegacy(deps, state);
      }
      await deliver(result.page.rows, state, deps);
      const { nextCursor, rows } = result.page;
      const advanced = nextCursor !== null && nextCursor !== state.cursor;
      if (nextCursor !== null) state.cursor = nextCursor;
      deps.store.save(state);
      // A short page is the end of the feed; an unchanged cursor would only refetch the same page.
      if (rows.length < FEED_PAGE_SIZE || !advanced) break;
    }
    return { ok: true };
  }

  return pollLegacy(deps, state);
}

// Newest-first page without `after`: deliver the rows the seen-set has not covered, oldest first. If the server has started handing out cursors, adopt one so later polls take the cursor path.
async function pollLegacy(
  deps: PollDeps,
  state: ChannelState
): Promise<PollResult> {
  const result = await deps.fetchPage({ after: null, limit: FEED_PAGE_SIZE });
  if (!result.ok) return result;
  const fresh = result.page.rows.filter(
    (row) => !dedupeKeys(row).some((key) => state.seen.includes(key))
  );
  if (fresh.length >= FEED_PAGE_SIZE) {
    // Every row on a full page is new: older ones may have fallen off the page unseen.
    logger.debug("channel: full page of unseen rows, some may be missed");
  }
  await deliver(fresh.reverse(), state, deps);
  if (result.page.nextCursor !== null) state.cursor = result.page.nextCursor;
  deps.store.save(state);
  return { ok: true };
}
