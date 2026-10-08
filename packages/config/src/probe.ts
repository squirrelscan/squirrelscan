// Probing intensity: the third audit axis, next to breadth (coverage, max pages)
// and rendering. It says how hard each page is poked beyond what the crawl
// fetched:
//
//   passive:    no request beyond the crawl. Today's rules and passive rules.
//   active:     passive plus quiet probes: a handful of requests that look
//                like normal traffic.
//   aggressive: active plus loud probes: many requests, many 404s, robots-
//                disallowed paths on purpose. Can trip a WAF. Never a default.
//
// Everything here is pure, so the CLI and the hosted runner resolve a run's
// level the same way; the caller supplies the context (local or cloud, signed
// in, ownership verified) instead of this module looking it up.

export const PROBE_LEVELS = ["passive", "active", "aggressive"] as const;
export type ProbeLevel = (typeof PROBE_LEVELS)[number];

/** Wall-clock budget for ALL probing in one run, by level (ms). */
export const DEFAULT_PROBE_BUDGET_MS: Record<ProbeLevel, number> = {
  passive: 0,
  active: 30_000,
  aggressive: 120_000,
};

/** Ceiling on --probe-budget / [security] budget: one hour. */
export const MAX_PROBE_BUDGET_MS = 3_600_000;

const DURATION_UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

/**
 * Normalize a raw probe level to a canonical {@link ProbeLevel}, or `null` when
 * it is not one. Case-insensitive and whitespace-trimmed, like coverage.
 */
export function normalizeProbeLevel(raw: string): ProbeLevel | null {
  const value = raw.trim().toLowerCase();
  return (PROBE_LEVELS as readonly string[]).includes(value) ? (value as ProbeLevel) : null;
}

/**
 * Parse a probe budget to milliseconds: `"30s"`, `"500ms"`, `"2m"`, `"1h"`, or a
 * bare number of seconds (`"45"` or `45`). Returns `null` for anything that is
 * not a finite, positive duration of at most {@link MAX_PROBE_BUDGET_MS}, so a
 * typo can never become a NaN or infinite cap (every `elapsed >= NaN` check is
 * false, which is an unbounded budget).
 */
export function parseProbeBudget(raw: string | number): number | null {
  let ms: number;
  if (typeof raw === "number") {
    ms = raw * 1000;
  } else {
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(raw.trim());
    if (!match) return null;
    const unit = (match[2]?.toLowerCase() ?? "s") as keyof typeof DURATION_UNIT_MS;
    ms = Number(match[1]) * DURATION_UNIT_MS[unit];
  }
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_PROBE_BUDGET_MS) return null;
  return Math.round(ms);
}

/** A budget in ms as the shortest readable duration: "500ms", "30s", "2m", "1m30s". */
export function formatProbeBudget(ms: number): string {
  if (ms < 1000 || ms % 1000 !== 0) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
}

/** Where the run happens and what is known about who asked for it. */
export interface ProbeRunContext {
  /** `local` is the CLI on the user's machine; `cloud` is a hosted run. */
  surface: "local" | "cloud";
  /** An account is behind the run (local: signed in; cloud: always true). */
  signedIn: boolean;
  /** Cloud only: the account has verified ownership of the audited site. */
  ownershipVerified?: boolean;
  /**
   * `[crawler] disable_discovery_probes` or `--disable-discovery-probes` is in
   * force. Probing then resolves to passive and no probe sends a request.
   */
  discoveryProbesDisabled?: boolean;
}

/** The probing flags as the command line delivered them. */
export interface ProbeFlags {
  /** `--probe` / `-P`: a raw, unvalidated level. */
  probe?: string;
  passive?: boolean;
  aggressive?: boolean;
  /** `--pentest`: shorthand for `--coverage full --probe aggressive`. */
  pentest?: boolean;
  /** `--probe-budget`: a raw, unvalidated duration. */
  probeBudget?: string;
}

/** The `[security]` section, as the schema validated it. */
export interface ProbeConfig {
  probe?: ProbeLevel;
  /** Raw duration ("30s", or seconds as a number). */
  budget?: string | number;
}

export type ProbeLevelSource = "flag" | "shortcut" | "config" | "default";

export interface ResolvedProbing {
  level: ProbeLevel;
  /** Total probing wall-clock cap (ms). 0 when the level is passive. */
  budgetMs: number;
  /** Which input decided the level (before the discovery-probes override). */
  source: ProbeLevelSource;
  /** Cloud run on an unverified site: passive, and no input can raise it. */
  locked: boolean;
  /** Lines to show the user: why a requested level did not apply, etc. */
  notices: string[];
}

export type ProbeResolution =
  | { ok: true; value: ResolvedProbing }
  | { ok: false; error: string; locked?: boolean };

/**
 * The context default. Aggressive is never a default: it is opt-in only.
 *   CLI local, signed in      → active
 *   CLI local, anonymous      → passive
 *   cloud, ownership verified → active
 *   cloud, unverified         → passive (and locked, see {@link isProbeLocked})
 */
export function defaultProbeLevel(ctx: ProbeRunContext): ProbeLevel {
  if (ctx.surface === "cloud") return ctx.ownershipVerified ? "active" : "passive";
  return ctx.signedIn ? "active" : "passive";
}

/** A cloud run against a site whose ownership is not verified stays passive. */
export function isProbeLocked(ctx: ProbeRunContext): boolean {
  return ctx.surface === "cloud" && !ctx.ownershipVerified;
}

/** The message for a level above passive asked for on a locked run. */
export function probeLockedMessage(level: ProbeLevel): string {
  return (
    `Probing is locked to passive for this site, so '${level}' cannot run: ` +
    `hosted audits only probe sites whose ownership is verified. ` +
    `Verify ownership of the site in the squirrelscan dashboard to unlock active and aggressive probing, ` +
    `or run the audit locally with the squirrel CLI.`
  );
}

/**
 * Check the probing flags for contradictions. Returns the error to print, or
 * null. Mirrors validateAuditFlags' `--render` + `--http` refusal: two flags
 * that ask for different levels are refused, never silently resolved.
 */
export function validateProbeFlags(flags: ProbeFlags, coverage?: string): string | null {
  if (flags.passive && flags.aggressive) {
    return "--passive and --aggressive cannot be combined";
  }
  if (flags.pentest && flags.passive) {
    return "--pentest and --passive cannot be combined (--pentest probes aggressively)";
  }
  const probe = flags.probe === undefined ? undefined : normalizeProbeLevel(flags.probe);
  if (probe) {
    if (flags.passive && probe !== "passive") {
      return `--passive cannot be combined with --probe ${probe}`;
    }
    if (flags.aggressive && probe !== "aggressive") {
      return `--aggressive cannot be combined with --probe ${probe}`;
    }
    if (flags.pentest && probe !== "aggressive") {
      return `--pentest cannot be combined with --probe ${probe} (--pentest is --probe aggressive)`;
    }
  }
  if (flags.pentest && coverage !== undefined && coverage.trim().toLowerCase() !== "full") {
    return `--pentest cannot be combined with --coverage ${coverage} (--pentest is --coverage full)`;
  }
  return null;
}

/**
 * Resolve the run's probing level and budget. Precedence, highest first:
 *   --probe  >  --passive / --aggressive / --pentest  >  [security] probe  >  context default
 * and for the budget:
 *   --probe-budget  >  [security] budget  >  the level's default.
 *
 * Then two overrides, in order:
 *   - discovery probes disabled → passive, no budget (with a notice when a
 *     higher level had been asked for).
 *   - a locked context (cloud, ownership unverified) refuses any explicit level
 *     above passive with {@link probeLockedMessage}; it never downgrades
 *     silently.
 */
export function resolveProbeIntensity(input: {
  flags: ProbeFlags;
  config?: ProbeConfig;
  context: ProbeRunContext;
  /** The raw coverage value, so `--pentest` can refuse a conflicting one. */
  coverage?: string;
}): ProbeResolution {
  const { flags, config = {}, context } = input;

  if (flags.probe !== undefined && normalizeProbeLevel(flags.probe) === null) {
    return {
      ok: false,
      error: `unknown --probe level '${flags.probe}'. Valid: ${PROBE_LEVELS.join(", ")}.`,
    };
  }
  const conflict = validateProbeFlags(flags, input.coverage);
  if (conflict) return { ok: false, error: conflict };

  let budgetOverride: number | undefined;
  if (flags.probeBudget !== undefined) {
    const parsed = parseProbeBudget(flags.probeBudget);
    if (parsed === null) {
      return {
        ok: false,
        error: `--probe-budget must be a positive duration of at most 1h, such as 30s, 500ms or 2m (got '${flags.probeBudget}').`,
      };
    }
    budgetOverride = parsed;
  }

  let level: ProbeLevel;
  let source: ProbeLevelSource;
  if (flags.probe !== undefined) {
    level = normalizeProbeLevel(flags.probe)!;
    source = "flag";
  } else if (flags.aggressive || flags.pentest) {
    level = "aggressive";
    source = "shortcut";
  } else if (flags.passive) {
    level = "passive";
    source = "shortcut";
  } else if (config.probe) {
    level = config.probe;
    source = "config";
  } else {
    level = defaultProbeLevel(context);
    source = "default";
  }

  const locked = isProbeLocked(context);
  if (locked && level !== "passive") {
    // Only an explicit choice can land here: the locked default is passive.
    return { ok: false, error: probeLockedMessage(level), locked: true };
  }

  const notices: string[] = [];
  if (context.discoveryProbesDisabled) {
    if (level !== "passive" && source !== "default") {
      notices.push(
        `Probing stays passive: discovery probes are disabled ([crawler] disable_discovery_probes or --disable-discovery-probes), so '${level}' sends no probe.`,
      );
    }
    return { ok: true, value: { level: "passive", budgetMs: 0, source, locked, notices } };
  }

  // The schema already refused an invalid [security] budget; null here means
  // a hand-built config, which falls back to the level default.
  const configBudget = config.budget === undefined ? null : parseProbeBudget(config.budget);
  const budgetMs =
    level === "passive" ? 0 : (budgetOverride ?? configBudget ?? DEFAULT_PROBE_BUDGET_MS[level]);
  return { ok: true, value: { level, budgetMs, source, locked, notices } };
}
