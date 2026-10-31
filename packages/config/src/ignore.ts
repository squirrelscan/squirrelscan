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
/** Characters in one selector (the engine refuses longer ones). */
export const MAX_IGNORE_SELECTOR_LENGTH = 300;
/** Characters in a reason. */
export const MAX_IGNORE_REASON_LENGTH = 500;

/**
 * One waiver. `rule` names the rule (or a glob such as `a11y/*`); `items`, `urls`
 * and `selectors` narrow what is waived and AND together when several are present.
 * An entry with none would turn a rule off, which `[rules] disable` already does
 * visibly, so it is refused. `selectors` match the element path a rule reports on
 * its items (`localization-form select`); `squirrel config validate` checks that a
 * rule the entry names reports one.
 */
export const IgnoreEntrySchema = z
  .object({
    rule: z.string().trim().min(1).max(MAX_IGNORE_ITEM_LENGTH),
    checks: z.array(z.string().min(1).max(MAX_IGNORE_ITEM_LENGTH)).max(MAX_IGNORE_MATCHERS).optional(),
    items: z.array(z.string().min(1).max(MAX_IGNORE_ITEM_LENGTH)).max(MAX_IGNORE_MATCHERS).optional(),
    urls: z.array(z.string().min(1).max(MAX_IGNORE_URL_LENGTH)).max(MAX_IGNORE_MATCHERS).optional(),
    selectors: z.array(z.string().min(1).max(MAX_IGNORE_SELECTOR_LENGTH)).max(MAX_IGNORE_MATCHERS).optional(),
    reason: z.string().max(MAX_IGNORE_REASON_LENGTH).optional(),
  })
  .superRefine((entry, ctx) => {
    const hasItems = (entry.items?.length ?? 0) > 0;
    const hasUrls = (entry.urls?.length ?? 0) > 0;
    const hasSelectors = (entry.selectors?.length ?? 0) > 0;
    if (!hasItems && !hasUrls && !hasSelectors) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: `an ignore entry needs items, urls or selectors; to turn a rule off use [rules] disable = ["${entry.rule}"]`,
      });
    }
  });

export type IgnoreEntry = z.infer<typeof IgnoreEntrySchema>;

export const IgnoreListSchema = z.array(IgnoreEntrySchema).max(MAX_IGNORE_ENTRIES);
