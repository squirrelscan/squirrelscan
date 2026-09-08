// Shared organization resolution for every CLI surface that has to name an
// org: `squirrel keys create|list|revoke` (each key belongs to exactly one org)
// and `squirrel auth status|whoami` (which org does my spend land on).
//
// TWO different questions, TWO different endpoints — do not conflate them:
//
//  - "which orgs am I a member of" → GET /v1/organizations. Cheap (one join),
//    always available, ordered newest-first. This is the authoritative
//    membership list and the only thing `keys` needs.
//  - "which org do my cloud calls act for" → the server's `users.activeOrgId`,
//    which orgContext resolves on every request and which the CLI never sends.
//    The only non-admin endpoint that returns it is GET /v1/hydrate. That is a
//    heavier batch payload (Durable Object reads for websites/usage), so it is
//    ALWAYS best-effort here: a failure costs the caller a display line, never
//    the command.
//
// The distinction is the whole bug in #1971: `keys create` used to mint against
// the FIRST org of the membership list — newest-first, so a second org created
// later silently became the target — while audits spent the ACTIVE org's
// credits. The two disagreed and nothing printed either one.

import { type Result, ok, err, commandError } from "@/controllers/types";
import { cliApi } from "@/lib/api-client";

/** An org the signed-in user is a member of, as the CLI renders it. */
export interface CliOrg {
  id: string;
  /** URL slug (`nikz`). Stable, human-typeable — the preferred `--org` value. */
  slug: string;
  name: string | null;
  /** This user's role in the org (`owner` / `admin` / `member`). */
  role: string;
}

interface OrganizationsResponse {
  organizations?: Array<{
    id?: string;
    slug?: string;
    name?: string | null;
    role?: string;
  }>;
  error?: string | { code?: string; message?: string };
}

interface HydrateResponse {
  activeOrgId?: string | null;
  organizations?: OrganizationsResponse["organizations"];
}

/** The org list + which one the API acts for, as `/v1/hydrate` reports them. */
export interface ActiveOrgContext {
  orgs: CliOrg[];
  activeOrgId: string | null;
  /** The entry of `orgs` matching `activeOrgId`, when it is still a member. */
  active: CliOrg | null;
}

/**
 * The signed-in user's org memberships, newest-first (the API's order).
 *
 * Requires a LOGIN session: every org route is `rejectApiKey`d server-side (a
 * key must not enumerate or mint keys), so call sites must check
 * `resolveCredential()?.source === "login"` first — otherwise the 401 here
 * reads as "no organization" rather than "wrong credential type".
 */
export async function listOrgs(): Promise<Result<CliOrg[]>> {
  const {
    ok: reqOk,
    status,
    data,
  } = await cliApi.request<OrganizationsResponse>("/v1/organizations", {
    method: "GET",
    auth: "required",
  });

  if (!reqOk || !data) {
    if (status === 401) {
      return err(
        commandError(
          "NOT_AUTHENTICATED",
          "Your login session is invalid or expired. Run 'squirrel auth login' to re-authenticate."
        )
      );
    }
    return err(
      commandError(
        "API_ERROR",
        typeof data?.error === "string"
          ? data.error
          : (data?.error?.message ??
              `Could not list organizations (status ${status}).`)
      )
    );
  }

  const orgs = toCliOrgs(data.organizations);

  if (orgs.length === 0) {
    return err(
      commandError(
        "NO_ORGANIZATION",
        "Your account has no organization yet. Finish onboarding at the dashboard, then retry."
      )
    );
  }

  return ok(orgs);
}

/**
 * The org the API acts for when the CLI names none — `users.activeOrgId`, i.e.
 * where an audit's credits are actually spent — together with the membership
 * list, both from the one `/v1/hydrate` call that carries them.
 *
 * BEST-EFFORT BY CONTRACT: returns null on any failure (offline, timeout, a
 * non-login credential, an older API without the field). Callers use it to
 * label output, never to decide what to charge or mint — a wrong label is a
 * cosmetic loss, a missing one must not fail the command.
 */
export async function fetchActiveOrgContext(
  timeoutMs?: number
): Promise<ActiveOrgContext | null> {
  try {
    const { ok: reqOk, data } = await cliApi.request<HydrateResponse>(
      "/v1/hydrate",
      {
        method: "GET",
        auth: "required",
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }
    );
    if (!reqOk || !data) return null;
    const orgs = toCliOrgs(data.organizations);
    const activeOrgId = data.activeOrgId ?? null;
    return {
      orgs,
      activeOrgId,
      active: activeOrgId
        ? (orgs.find((org) => org.id === activeOrgId) ?? null)
        : null,
    };
  } catch {
    return null;
  }
}

/** Best-effort active org id alone. See `fetchActiveOrgContext`. */
export async function fetchActiveOrgId(
  timeoutMs?: number
): Promise<string | null> {
  return (await fetchActiveOrgContext(timeoutMs))?.activeOrgId ?? null;
}

/**
 * Map raw API org rows to `CliOrg`. A row without an id is unusable as a
 * key-route path segment, so it is dropped rather than turned into
 * `/v1/organizations/undefined/api-keys`.
 */
function toCliOrgs(rows: OrganizationsResponse["organizations"]): CliOrg[] {
  const orgs: CliOrg[] = [];
  // Array-guarded, not just null-guarded: a malformed body (a number, say)
  // would make `for...of` throw, and in `listOrgs` that throw is uncaught.
  if (!Array.isArray(rows)) return orgs;
  for (const raw of rows) {
    if (!raw?.id) continue;
    orgs.push({
      id: raw.id,
      slug: raw.slug ?? "",
      name: raw.name ?? null,
      role: raw.role ?? "",
    });
  }
  return orgs;
}

/**
 * Resolve a user-supplied `--org` value against the membership list. Accepts an
 * exact org id or an exact slug (slugs are lowercased server-side, so the match
 * is case-insensitive). Deliberately NOT a prefix match: an ambiguous or fuzzy
 * match here would mint a live credential against the wrong org, which is the
 * exact failure #1971 is about.
 */
export function matchOrg(orgs: CliOrg[], selector: string): Result<CliOrg> {
  const wanted = selector.trim();
  if (!wanted) {
    return err(
      commandError("INVALID_ORG", "--org needs an organization slug or id.")
    );
  }

  const byId = orgs.find((o) => o.id === wanted);
  if (byId) return ok(byId);

  const lowered = wanted.toLowerCase();
  const bySlug = orgs.filter((o) => o.slug.toLowerCase() === lowered);
  if (bySlug.length === 1) return ok(bySlug[0]);

  return err(
    commandError(
      "ORG_NOT_FOUND",
      `No organization "${wanted}" in your account.\n${formatOrgChoices(orgs)}`
    )
  );
}

/** `nikz (Nik Cubrilovic)`, or just the slug/id when there is no name. */
export function describeOrg(org: CliOrg): string {
  const label = org.slug || org.id;
  return org.name && org.name !== label ? `${label} (${org.name})` : label;
}

/**
 * The org menu printed whenever the CLI refuses to guess: one line per org,
 * marking the active one so the reader can see which org their audits already
 * spend from before they pick a different one for a key.
 */
export function formatOrgChoices(
  orgs: CliOrg[],
  activeOrgId?: string | null
): string {
  const lines = orgs.map((org) => {
    const marker = activeOrgId && org.id === activeOrgId ? " [active]" : "";
    return `  ${org.slug || org.id}  ${org.name ?? ""}${marker}\n    id: ${org.id}`;
  });
  return `Organizations:\n${lines.join("\n")}`;
}

/**
 * Pick the org a key command should act on.
 *
 * With `--org`, that org (validated against membership). Without it: the sole
 * org when there is exactly one, otherwise a REFUSAL listing the choices —
 * never a silent pick. `keys create` mints a live credential bound to one org's
 * credits; guessing is how the wrong org gets charged.
 */
export async function resolveKeyOrg(
  selector?: string
): Promise<Result<CliOrg>> {
  const listed = await listOrgs();
  if (!listed.ok) return listed;
  const orgs = listed.data;

  if (selector !== undefined) return matchOrg(orgs, selector);

  if (orgs.length === 1) return ok(orgs[0]);

  // Refusal path only: not latency-sensitive and already terminal, so the
  // best-effort active-org lookup can only improve the message.
  const activeOrgId = await fetchActiveOrgId();
  return err(
    commandError(
      "ORG_REQUIRED",
      `You belong to ${orgs.length} organizations, so this command will not pick one for you. Re-run with --org <slug|id>.\n${formatOrgChoices(orgs, activeOrgId)}`
    )
  );
}
