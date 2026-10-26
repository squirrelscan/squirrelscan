// Classic JSX in the CLI build needs React in scope.
import React from "react";
import type { ReactNode } from "react";
import { cn } from "./utils";
import {
  IconBot,
  IconCrackedNut,
  IconFileJson,
  IconGauge,
  IconLink,
  IconNut,
  IconRocket,
  IconSearch,
  IconServer,
  IconShield,
  IconTerminal,
  IconTree,
} from "./icons";

// Uses the `pixel-grid` and `animate-drift` classes from ../styles.css.
const FLOATING_ICONS = [
  // Top row
  {
    Icon: IconSearch,
    className: "top-[12%] left-[6%]",
    size: "w-5 h-5",
    color: "text-primary",
    delay: 0,
  },
  {
    Icon: IconServer,
    className: "top-[18%] left-[22%]",
    size: "w-4 h-4",
    color: "text-accent",
    delay: 1,
  },
  {
    Icon: IconShield,
    className: "top-[8%] right-[28%]",
    size: "w-6 h-6",
    color: "text-primary",
    delay: 2,
  },
  {
    Icon: IconLink,
    className: "top-[15%] right-[10%]",
    size: "w-4 h-4",
    color: "text-accent",
    delay: 3,
  },
  // Middle row
  {
    Icon: IconBot,
    className: "top-[45%] left-[4%]",
    size: "w-6 h-6",
    color: "text-primary",
    delay: 4,
  },
  {
    Icon: IconNut,
    className: "top-[40%] left-[18%]",
    size: "w-4 h-4",
    color: "text-accent",
    delay: 5,
  },
  {
    Icon: IconGauge,
    className: "top-[50%] right-[5%]",
    size: "w-6 h-6",
    color: "text-accent",
    delay: 6,
  },
  {
    Icon: IconCrackedNut,
    className: "top-[42%] right-[20%]",
    size: "w-3 h-3",
    color: "text-primary",
    delay: 7,
  },
  // Bottom row
  {
    Icon: IconFileJson,
    className: "bottom-[20%] left-[12%]",
    size: "w-5 h-5",
    color: "text-primary",
    delay: 8,
  },
  {
    Icon: IconRocket,
    className: "bottom-[25%] left-[32%]",
    size: "w-4 h-4",
    color: "text-accent",
    delay: 9,
  },
  {
    Icon: IconTerminal,
    className: "bottom-[15%] right-[25%]",
    size: "w-5 h-5",
    color: "text-accent",
    delay: 10,
  },
  {
    Icon: IconTree,
    className: "bottom-[22%] right-[8%]",
    size: "w-5 h-5",
    color: "text-primary",
    delay: 11,
  },
  // Extra scattered
  {
    Icon: IconNut,
    className: "top-[28%] left-[42%]",
    size: "w-3 h-3",
    color: "text-primary/70",
    delay: 12,
  },
  {
    Icon: IconNut,
    className: "bottom-[35%] right-[38%]",
    size: "w-3 h-3",
    color: "text-accent/70",
    delay: 13,
  },
] as const;

export interface DecorativeHeaderProps {
  children: ReactNode;
  className?: string;
  /** No minimum height: the band is as tall as its content. */
  compact?: boolean;
}

export function DecorativeHeader({ children, className, compact = false }: DecorativeHeaderProps) {
  return (
    <section
      className={cn(
        "pixel-grid border-b-2 border-primary/50 relative overflow-hidden",
        !compact && "min-h-[180px] md:min-h-[220px]",
        className,
      )}
    >
      {/* Floating decorative icons - hidden on mobile for performance */}
      <div className="absolute inset-0 hidden md:block pointer-events-none" aria-hidden="true">
        {FLOATING_ICONS.map(({ Icon, className: iconClass, size, color, delay }, index) => (
          <div
            key={index}
            className={`absolute opacity-20 animate-drift ${iconClass}`}
            style={{ animationDelay: `${delay * 0.4}s` }}
          >
            <Icon className={`${size} ${color}`} />
          </div>
        ))}
      </div>
      {/* Content */}
      <div className="relative z-10">{children}</div>
    </section>
  );
}
