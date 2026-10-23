import { twMerge } from "tailwind-merge";

type ClassValue = string | false | null | undefined;

/**
 * Joins class names; on a Tailwind conflict the later class wins (a
 * component's `className` overrides its defaults), as in the design system.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(inputs.filter(Boolean).join(" "));
}
