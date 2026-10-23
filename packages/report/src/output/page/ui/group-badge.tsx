// Classic JSX in the CLI build needs React in scope.
import React from "react";
import { getGroupName, getGroupTitle } from "../../../categories";
import { getGroupColor } from "../../../scoring";
import { cn } from "./utils";

/**
 * Coloured label for a top-level rule group (seo/performance/security/ai), in
 * the GROUP_COLORS accents. Full title on the hover tooltip (ai is "Agent
 * Experience"). Unknown codes render neutral grey.
 */
export function GroupBadge({ group, className }: { group: string; className?: string }) {
  const color = getGroupColor(group);
  return (
    <span
      className={cn(
        "inline-flex items-center border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
        className,
      )}
      style={{ color: color.text, background: color.bg, borderColor: color.border }}
      title={getGroupTitle(group)}
    >
      {getGroupName(group)}
    </span>
  );
}
