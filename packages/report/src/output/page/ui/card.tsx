// Classic JSX in the CLI build needs React in scope.
import React from "react";
import type { HTMLAttributes } from "react";

import { cn } from "./utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="card"
      className={cn(
        "overflow-hidden border border-border bg-card text-card-foreground shadow-xs",
        className,
      )}
      {...props}
    />
  );
}
