// Classic JSX in the CLI build needs React in scope.
import React from "react";
import { cn } from "./utils";

interface ProgressProps {
  value: number;
  max?: number;
  className?: string;
}

export function Progress({ value, max = 100, className }: ProgressProps) {
  const percent = max > 0 ? Math.min(100, (value / max) * 100) : 0;

  return (
    <div className={cn("h-2 overflow-hidden bg-muted", className)}>
      <div
        className="h-full bg-primary transition-[width] duration-300"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
