// Shared utilities for report output formatters

import { writeFileSync } from "node:fs";

/**
 * Grouped line item from indented text parsing
 */
export interface GroupedLine {
  main: string;
  subs: string[];
}

/**
 * Parse indented text into grouped main lines with sub-items
 * Lines starting with 2+ spaces are treated as sub-items of the previous main line
 */
export function parseIndentedLines(text: string): GroupedLine[] {
  const lines = String(text).split("\n");
  const grouped: GroupedLine[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    if (line.startsWith("  ")) {
      // Sub-item - attach to previous main item
      if (grouped.length > 0) {
        grouped[grouped.length - 1].subs.push(line.trim());
      }
    } else {
      // Main item
      grouped.push({ main: line, subs: [] });
    }
  }

  return grouped;
}

/**
 * Escape HTML special characters to prevent XSS
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Wrap text at specified column width
 */
export function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= maxWidth) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines;
}

/**
 * Write content to file with error handling
 * Returns true on success, throws descriptive error on failure
 */
export function writeReportFile(outputPath: string, content: string): void {
  try {
    writeFileSync(outputPath, content);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown write error";
    throw new Error(`Failed to write report to ${outputPath}: ${message}`, {
      cause: error,
    });
  }
}

/**
 * Format ISO date for report headers
 */
export function formatReportDate(timestamp: string): string {
  return new Date(timestamp).toISOString();
}

/**
 * Format date as human-friendly "8th Feb 2026" style
 */
export function formatHumanDate(timestamp: string): string {
  const d = new Date(timestamp);
  const day = d.getUTCDate();
  const suffix = [11, 12, 13].includes(day)
    ? "th"
    : day % 10 === 1
      ? "st"
      : day % 10 === 2
        ? "nd"
        : day % 10 === 3
          ? "rd"
          : "th";
  const month = d.toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  return `${day}${suffix} ${month} ${d.getUTCFullYear()}`;
}

/**
 * Sanitize URL for safe use in href attributes
 * Only allows http:// and https:// URLs to prevent javascript: XSS
 * Returns "#" for invalid or unsafe URLs
 */
export function sanitizeUrl(url: string): string {
  const trimmed = url.trim().toLowerCase();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return url;
  }
  return "#";
}
