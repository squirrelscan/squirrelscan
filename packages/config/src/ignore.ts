// `[[ignore]]` entries: waive findings without disabling a rule (#1262).
//
// The shape is shared by squirrel.toml and, later, the cloud's website settings,
// so the caps live here: this is user input executed in the engine.

import { z } from "zod";

/** Entries a config may carry. */
export const MAX_IGNORE_ENTRIES = 200;
/** Matchers (items or urls) per entry. */
export const MAX_IGNORE_MATCHERS = 100;
/** Characters in one item matcher, rule pattern or check name. */
export const MAX_IGNORE_ITEM_LENGTH = 200;
/** Characters in one url matcher (a path pattern). */
export const MAX_IGNORE_URL_LENGTH = 512;
/** Characters in a reason. */
export const MAX_IGNORE_REASON_LENGTH = 500;

/**
 * One waiver. `rule` names the rule (or a glob such as `a11y/*`); `items` and
 * `urls` narrow what is waived and AND together when both are present. An entry
 * with neither would turn a rule off, which `[rules] disable` already does
 * visibly, so it is refused. `selectors` is reserved and refused until rules can
 * say where in the DOM an item is.
 */
export const IgnoreEntrySchema = z
  .object({
    rule: z.string().trim().min(1).max(MAX_IGNORE_ITEM_LENGTH),
    checks: z.array(z.string().min(1).max(MAX_IGNORE_ITEM_LENGTH)).max(MAX_IGNORE_MATCHERS).optional(),
    items: z.array(z.string().min(1).max(MAX_IGNORE_ITEM_LENGTH)).max(MAX_IGNORE_MATCHERS).optional(),
    urls: z.array(z.string().min(1).max(MAX_IGNORE_URL_LENGTH)).max(MAX_IGNORE_MATCHERS).optional(),
    selectors: z.array(z.string()).optional(),
    reason: z.string().max(MAX_IGNORE_REASON_LENGTH).optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.selectors !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["selectors"],
        message: "selectors are not supported yet: ignore by items or urls",
      });
    }
    const hasItems = (entry.items?.length ?? 0) > 0;
    const hasUrls = (entry.urls?.length ?? 0) > 0;
    if (!hasItems && !hasUrls) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: `an ignore entry needs items or urls; to turn a rule off use [rules] disable = ["${entry.rule}"]`,
      });
    }
  });

export type IgnoreEntry = z.infer<typeof IgnoreEntrySchema>;

export const IgnoreListSchema = z.array(IgnoreEntrySchema).max(MAX_IGNORE_ENTRIES);
