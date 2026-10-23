// Classic JSX in the CLI build needs React in scope.
import React from "react";
import type { HTMLAttributes } from "react";

import { cn } from "./utils";

const TONE = {
  default: "bg-card",
  subtle: "bg-secondary/50",
  selected: "border-primary/20 bg-primary/5",
} as const;

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  tone?: keyof typeof TONE;
}

export function Panel({ className, tone = "default", ...props }: PanelProps) {
  return (
    <div
      data-slot="panel"
      className={cn("border border-border p-4 md:p-5", TONE[tone], className)}
      {...props}
    />
  );
}
