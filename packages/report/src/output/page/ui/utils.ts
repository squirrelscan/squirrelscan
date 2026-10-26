type ClassValue = string | false | null | undefined;

/**
 * Joins class names, skipping empty values. No conflict resolution: callers
 * never pass two utilities for the same property (components take a prop for
 * the variants they support, such as Panel `padded` or Card `flat`).
 */
export function cn(...inputs: ClassValue[]): string {
  return inputs.filter(Boolean).join(" ");
}
