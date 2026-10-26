// Classic JSX in the CLI build needs React in scope.
import React from "react";
export interface Metric {
  value: string;
  label: string;
  /** Colours the number (a severity colour). The label stays muted. */
  color?: string;
}

/** Counts as cells, not a sentence. */
export function Metrics({ items }: { items: Metric[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex border border-border">
      {items.map((item, i) => (
        <div
          key={item.label}
          className={`flex-1 px-3 py-3 text-center ${i > 0 ? "border-l border-border" : ""}`}
        >
          <div className="text-lg font-bold leading-snug" style={{ color: item.color }}>
            {item.value}
          </div>
          <div className="text-xs text-muted-foreground">{item.label}</div>
        </div>
      ))}
    </div>
  );
}
