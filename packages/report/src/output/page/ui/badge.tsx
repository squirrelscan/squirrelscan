// Classic JSX in the CLI build needs React in scope.
import React from "react";
import type { ReactElement, ReactNode } from "react";

import { cn } from "./utils";

export type BadgeColor =
  | "green"
  | "orange"
  | "red"
  | "blue"
  | "yellow"
  | "purple"
  | "neutral"
  | "primary";

const COLOR_CLASSES: Record<BadgeColor, string> = {
  green: "bg-[oklch(0.52_0.12_145/0.1)] text-[oklch(0.40_0.12_145)]",
  orange: "bg-[oklch(0.62_0.14_45/0.1)] text-[oklch(0.50_0.14_45)]",
  red: "bg-[oklch(0.55_0.18_25/0.1)] text-[oklch(0.45_0.18_25)]",
  blue: "bg-[oklch(0.5_0.15_260/0.1)] text-[oklch(0.40_0.15_260)]",
  yellow: "bg-[oklch(0.7_0.1_60/0.1)] text-[oklch(0.50_0.12_60)]",
  purple: "bg-[oklch(0.55_0.15_300/0.1)] text-[oklch(0.45_0.15_300)]",
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-primary/10 text-primary",
};

const BASE = "inline-flex items-center gap-1 [&>svg]:size-3 [&>svg]:shrink-0";

const VARIANT = {
  default: "bg-primary/10 text-primary border border-primary/20",
  outline: "border border-border text-foreground",
  destructive:
    "bg-[oklch(0.55_0.18_25/0.1)] text-[oklch(0.45_0.18_25)] border border-[oklch(0.55_0.18_25/0.2)]",
  success:
    "bg-[oklch(0.52_0.12_145/0.1)] text-[oklch(0.40_0.12_145)] border border-[oklch(0.52_0.12_145/0.2)]",
  warning:
    "bg-[oklch(0.7_0.1_60/0.1)] text-[oklch(0.50_0.12_60)] border border-[oklch(0.7_0.1_60/0.2)]",
  secondary: "bg-muted text-muted-foreground border border-border",
  colorOnly: "",
} as const;

const APPEARANCE = {
  badge: "font-medium",
  tag: "font-semibold uppercase border-0",
} as const;

const SIZE = {
  sm: "px-1.5 py-0.5 text-[10px]",
  md: "px-2 py-0.5 text-xs",
} as const;

interface BadgeProps {
  variant?: keyof typeof VARIANT;
  appearance?: keyof typeof APPEARANCE;
  size?: keyof typeof SIZE;
  color?: BadgeColor;
  icon?: ReactElement;
  children: ReactNode;
  className?: string;
}

export function Badge({
  variant = "default",
  appearance = "badge",
  size = "sm",
  color,
  icon,
  children,
  className,
}: BadgeProps) {
  return (
    <span
      className={cn(
        BASE,
        VARIANT[color ? "colorOnly" : variant],
        APPEARANCE[appearance],
        SIZE[size],
        color && COLOR_CLASSES[color],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
