// Classic JSX in the CLI build needs React in scope.
import React from "react";
import type { HTMLAttributes } from "react";

import { cn } from "./utils";

/** Each tone sets its own border colour and background, so none is overridden. */
const TONE = {
  default: "border-border bg-card",
  subtle: "border-border bg-secondary/50",
  selected: "border-primary/20 bg-primary/5",
} as const;

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  tone?: keyof typeof TONE;
  /** Default true: the standard padding. Pass false and set padding in `className`. */
  padded?: boolean;
}

export function Panel({ className, tone = "default", padded = true, ...props }: PanelProps) {
  return (
    <div
      data-slot="panel"
      className={cn("border", padded && "p-4 md:p-5", TONE[tone], className)}
      {...props}
    />
  );
}
