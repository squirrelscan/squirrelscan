// Classic JSX in the CLI build needs React in scope.
import React from "react";
import type { HTMLAttributes } from "react";

import { cn } from "./utils";

const TONE = {
  default: "border-border",
  destructive: "border-destructive/40",
} as const;

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Border colour. */
  tone?: keyof typeof TONE;
  /** No drop shadow. */
  flat?: boolean;
}

export function Card({ className, tone = "default", flat = false, ...props }: CardProps) {
  return (
    <div
      data-slot="card"
      className={cn(
        "overflow-hidden border bg-card text-card-foreground",
        TONE[tone],
        !flat && "shadow-xs",
        className,
      )}
      {...props}
    />
  );
}
